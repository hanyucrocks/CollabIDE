import { Router, type Request } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { UserModel, type UserDoc } from '../models/User.ts';
import { env, githubEnabled } from '../config/env.ts';
import { authorizeUrl, fetchIdentity, OAuthError } from '../lib/github.ts';
import { mintHandoffCode, redeemHandoffCode } from '../lib/oauth.ts';
import { HttpError } from '../middleware/errors.ts';
import { requireAuth } from '../middleware/auth.ts';
import { clientIp, rateLimit } from '../middleware/rateLimit.ts';
import {
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../lib/tokens.ts';

export const authRouter = Router();

/*
 * Signup and login are the only unauthenticated write paths, and the service
 * is on a public URL. Without a limit, account creation is unbounded against a
 * free database tier and login is open to credential stuffing.
 *
 * Keyed by IP because there is no user yet. Generous enough that a person
 * mistyping a password never notices.
 */
const authLimiter = rateLimit({
  // A short, self-healing window rather than a long punitive one. 20 attempts
  // a minute is negligible against bcrypt for an attacker, while a 15-minute
  // window turned out to lock out anything legitimately making several
  // accounts from one address — an office behind one NAT, or a test suite.
  //
  // A production deployment fronting real users should add a stricter
  // signup-specific limit or a challenge; this bounds the damage, it does not
  // eliminate it.
  windowMs: 60_000,
  max: 20,
  key: clientIp,
  message: 'Too many attempts from this address. Wait a minute and try again.',
});

authRouter.post('/signup', authLimiter);
authRouter.post('/login', authLimiter);

const BCRYPT_ROUNDS = 12;
// Cap stored refresh tokens so the array can't grow without bound across logins.
const MAX_ACTIVE_SESSIONS = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readCredentials(body: unknown): { email: string; password: string } {
  const { email, password } = (body ?? {}) as Record<string, unknown>;

  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    throw new HttpError(400, 'A valid email is required');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }
  return { email: email.trim().toLowerCase(), password };
}

function publicUser(user: UserDoc) {
  return { id: user.id as string, email: user.email, createdAt: user.createdAt };
}

/** Issues a fresh token pair and records the refresh token's hash on the user. */
async function issueTokens(user: UserDoc) {
  const accessToken = signAccessToken(user.id as string);
  const refreshToken = signRefreshToken(user.id as string);

  await UserModel.updateOne(
    { _id: user._id },
    {
      $push: {
        refreshTokens: {
          $each: [hashToken(refreshToken)],
          $slice: -MAX_ACTIVE_SESSIONS,
        },
      },
    },
  );

  return { accessToken, refreshToken };
}

function readRefreshToken(body: unknown): string {
  const { refreshToken } = (body ?? {}) as Record<string, unknown>;
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new HttpError(400, 'refreshToken is required');
  }
  return refreshToken;
}

authRouter.post('/signup', async (req, res) => {
  const { email, password } = readCredentials(req.body);

  if (await UserModel.exists({ email })) {
    throw new HttpError(409, 'An account with that email already exists');
  }

  const user = await UserModel.create({
    email,
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
  });

  res.status(201).json({ user: publicUser(user), ...(await issueTokens(user)) });
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = readCredentials(req.body);

  const user = await UserModel.findOne({ email });

  /*
   * Same response for an unknown email, a wrong password, and an account that
   * has no password at all — one created through GitHub. Distinguishing them
   * would leak both which emails have accounts and how each one signs in.
   */
  const valid =
    user?.passwordHash && (await bcrypt.compare(password, user.passwordHash));

  if (!valid) {
    throw new HttpError(401, 'Invalid email or password');
  }

  res.json({ user: publicUser(user), ...(await issueTokens(user)) });
});

authRouter.post('/refresh', async (req, res) => {
  const presented = readRefreshToken(req.body);

  let userId: string;
  try {
    userId = verifyRefreshToken(presented).sub;
  } catch {
    throw new HttpError(401, 'Invalid or expired refresh token');
  }

  // Atomic consume: the $pull only matches if this exact token is still active,
  // so two concurrent refreshes with the same token can't both succeed.
  const user = await UserModel.findOneAndUpdate(
    { _id: userId, refreshTokens: hashToken(presented) },
    { $pull: { refreshTokens: hashToken(presented) } },
    { new: true },
  );

  if (!user) {
    // The signature was valid but the token is no longer active: it was already
    // rotated, or revoked by logout. A rotated token being replayed means someone
    // is holding a stolen copy, so drop every session for this user.
    await UserModel.updateOne({ _id: userId }, { $set: { refreshTokens: [] } });
    throw new HttpError(401, 'Refresh token has been revoked');
  }

  res.json({ user: publicUser(user), ...(await issueTokens(user)) });
});

authRouter.post('/logout', async (req, res) => {
  const presented = readRefreshToken(req.body);

  // Deliberately does not require a valid access token: logging out has to work
  // even after the short-lived access token has already expired.
  try {
    const { sub } = verifyRefreshToken(presented);
    await UserModel.updateOne(
      { _id: sub },
      { $pull: { refreshTokens: hashToken(presented) } },
    );
  } catch {
    // An unparseable token is already useless; report success either way.
  }

  res.status(204).end();
});

/** Which sign-in methods this deployment actually offers. */
authRouter.get('/providers', (_req, res) => {
  res.json({ password: true, github: githubEnabled() });
});

/**
 * Where GitHub sends the browser back. Must match the OAuth app's registered
 * callback exactly, so it is derived from the request the browser actually
 * reached rather than hardcoded per environment. PUBLIC_API_URL overrides it
 * where a proxy rewrites Host.
 */
function callbackUrl(req: Request): string {
  const base = env.publicApiUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/api/auth/github/callback`;
}

const STATE_TTL_SECONDS = 300;

authRouter.get('/github', (req, res) => {
  if (!githubEnabled()) throw new HttpError(501, 'GitHub sign-in is not configured');

  /*
   * A signed, short-lived state rather than one held server-side: it is only
   * needed to prove the callback belongs to a flow this server started, and
   * signing keeps that stateless across restarts.
   */
  const state = jwt.sign({ typ: 'oauth' }, env.accessSecret, {
    expiresIn: STATE_TTL_SECONDS,
  });

  res.redirect(authorizeUrl(callbackUrl(req), state));
});

authRouter.get('/github/callback', async (req, res) => {
  if (!githubEnabled()) throw new HttpError(501, 'GitHub sign-in is not configured');

  const target = env.clientOrigins[0] ?? 'http://localhost:5173';
  const fail = (reason: string) =>
    res.redirect(`${target}/#oauth_error=${encodeURIComponent(reason)}`);

  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state) return fail('GitHub did not return a code');

  try {
    jwt.verify(state, env.accessSecret);
  } catch {
    return fail('This sign-in link has expired. Try again.');
  }

  let identity;
  try {
    identity = await fetchIdentity(code, callbackUrl(req));
  } catch (err) {
    console.error('[oauth] github failed', err);
    return fail(err instanceof OAuthError ? err.message : 'GitHub sign-in failed');
  }

  if (!identity.email) {
    return fail('Your GitHub account has no verified primary email address');
  }

  /*
   * Match on the GitHub id first: it is stable, whereas an email can be
   * changed or reassigned. Only when there is no linked account do we fall
   * back to the verified email, which links a GitHub login to an existing
   * password account rather than creating a duplicate.
   */
  let user = await UserModel.findOne({ githubId: identity.id });

  if (!user) {
    user = await UserModel.findOne({ email: identity.email });

    if (user) {
      user.githubId = identity.id;
      await user.save();
    } else {
      user = await UserModel.create({ email: identity.email, githubId: identity.id });
    }
  }

  res.redirect(`${target}/#oauth=${mintHandoffCode(user.id as string)}`);
});

/** Trades the single-use handoff code for a real token pair. */
authRouter.post('/github/exchange', async (req, res) => {
  const { code } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof code !== 'string' || !code) throw new HttpError(400, 'code is required');

  const userId = redeemHandoffCode(code);
  if (!userId) throw new HttpError(401, 'That sign-in code is expired or already used');

  const user = await UserModel.findById(userId);
  if (!user) throw new HttpError(401, 'That account no longer exists');

  res.json({ user: publicUser(user), ...(await issueTokens(user)) });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await UserModel.findById(req.userId);
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ user: publicUser(user) });
});
