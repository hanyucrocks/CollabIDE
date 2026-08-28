import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { UserModel, type UserDoc } from '../models/User.ts';
import { HttpError } from '../middleware/errors.ts';
import { requireAuth } from '../middleware/auth.ts';
import {
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../lib/tokens.ts';

export const authRouter = Router();

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
  // Same response for unknown email and wrong password, so this endpoint
  // can't be used to enumerate which emails have accounts.
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
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

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await UserModel.findById(req.userId);
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ user: publicUser(user) });
});
