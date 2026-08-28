const JOIN_PATH = '#/join/';

/** The shareable URL for an invite token, based on where the app is served from. */
export function inviteUrl(token: string): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}${JOIN_PATH}${encodeURIComponent(token)}`;
}

/**
 * Pulls the token out of whatever was pasted.
 *
 * People paste the whole link far more often than the bare token, and a link
 * that silently fails to join is a bad first impression, so accept both.
 */
export function parseInviteToken(input: string): string {
  const trimmed = input.trim();
  const marker = trimmed.lastIndexOf(JOIN_PATH);

  if (marker === -1) return trimmed;
  return decodeURIComponent(trimmed.slice(marker + JOIN_PATH.length));
}
