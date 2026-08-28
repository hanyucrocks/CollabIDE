import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.ts';

export type AccessPayload = { sub: string; typ: 'access' };
export type RefreshPayload = { sub: string; typ: 'refresh'; jti: string };

// `expiresIn` is typed as a template-literal duration in @types/jsonwebtoken,
// so a plain string from the environment needs this cast.
const accessTtl = env.accessTtl as jwt.SignOptions['expiresIn'];
const refreshTtl = env.refreshTtl as jwt.SignOptions['expiresIn'];

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId, typ: 'access' }, env.accessSecret, {
    expiresIn: accessTtl,
  });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign(
    { sub: userId, typ: 'refresh', jti: crypto.randomUUID() },
    env.refreshSecret,
    { expiresIn: refreshTtl },
  );
}

export function verifyAccessToken(token: string): AccessPayload {
  const payload = jwt.verify(token, env.accessSecret) as AccessPayload;
  if (payload.typ !== 'access') throw new Error('wrong token type');
  return payload;
}

export function verifyRefreshToken(token: string): RefreshPayload {
  const payload = jwt.verify(token, env.refreshSecret) as RefreshPayload;
  if (payload.typ !== 'refresh') throw new Error('wrong token type');
  return payload;
}

// Refresh tokens are stored hashed so a database leak can't be replayed.
// SHA-256 rather than bcrypt: the token is already 100+ bits of signed entropy
// (not a guessable human password), and this hash is looked up on every refresh.
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newInviteToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}
