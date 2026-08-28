import { env } from '../config/env.ts';

export type GitHubIdentity = {
  id: string;
  email: string | null;
  login: string;
};

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API = 'https://api.github.com';

export class OAuthError extends Error {}

export function authorizeUrl(redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', env.githubClientId);
  url.searchParams.set('redirect_uri', redirectUri);
  // read:user for the profile, user:email because a primary address is not
  // included in the profile when the user keeps it private.
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeCode(code: string, redirectUri: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.githubClientId,
      client_secret: env.githubClientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) throw new OAuthError(`GitHub rejected the code exchange (${res.status})`);

  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) {
    throw new OAuthError(body.error_description ?? 'GitHub returned no access token');
  }
  return body.access_token;
}

/**
 * Resolves the signed-in GitHub user.
 *
 * Only a *verified* primary address is accepted. An unverified one would let
 * someone claim an address they do not control, and since accounts are linked
 * by email that would be a route into somebody else's account.
 */
export async function fetchIdentity(
  code: string,
  redirectUri: string,
): Promise<GitHubIdentity> {
  const token = await exchangeCode(code, redirectUri);

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'CollabIDE',
  };

  const profileRes = await fetch(`${API}/user`, { headers });
  if (!profileRes.ok) throw new OAuthError('Could not read your GitHub profile');

  const profile = (await profileRes.json()) as { id: number; login: string };

  const emailsRes = await fetch(`${API}/user/emails`, { headers });
  let email: string | null = null;

  if (emailsRes.ok) {
    const emails = (await emailsRes.json()) as Array<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;
    email = emails.find((e) => e.primary && e.verified)?.email ?? null;
  }

  return { id: String(profile.id), email: email?.toLowerCase() ?? null, login: profile.login };
}
