import { afterEach, describe, expect, it, vi } from 'vitest';
import { inviteUrl, parseInviteToken } from './invite.ts';

/*
 * `inviteUrl` reads window.location, which does not exist in the node
 * environment this suite runs in. Stubbing it is cheaper and more explicit
 * than pulling in jsdom for two properties.
 */
function servedFrom(origin: string, pathname: string) {
  vi.stubGlobal('window', { location: { origin, pathname } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('inviteUrl', () => {
  it('builds a link against wherever the app is served from', () => {
    servedFrom('https://collab-ide-three.vercel.app', '/');
    expect(inviteUrl('abc123')).toBe('https://collab-ide-three.vercel.app/#/join/abc123');
  });

  it('respects a non-root path', () => {
    servedFrom('https://example.com', '/app/');
    expect(inviteUrl('abc123')).toBe('https://example.com/app/#/join/abc123');
  });

  it('encodes a token so it survives the URL', () => {
    servedFrom('https://example.com', '/');
    // base64url avoids these, but the encoding is what guarantees that.
    expect(inviteUrl('a+b/c=')).toBe('https://example.com/#/join/a%2Bb%2Fc%3D');
  });
});

describe('parseInviteToken', () => {
  it('accepts a bare token', () => {
    expect(parseInviteToken('abc123')).toBe('abc123');
  });

  it('accepts a full invite link', () => {
    expect(parseInviteToken('https://example.com/#/join/abc123')).toBe('abc123');
  });

  it('trims whitespace from a careless paste', () => {
    expect(parseInviteToken('  https://example.com/#/join/abc123\n')).toBe('abc123');
  });

  it('decodes an encoded token', () => {
    expect(parseInviteToken('https://example.com/#/join/a%2Bb%2Fc%3D')).toBe('a+b/c=');
  });

  /*
   * The reason lastIndexOf is used rather than indexOf: a token can be pasted
   * inside a longer string, and the last occurrence is the real one.
   */
  it('takes the last marker when the text contains more than one', () => {
    expect(parseInviteToken('https://example.com/#/join/#/join/real')).toBe('real');
  });

  it('round-trips whatever inviteUrl produced', () => {
    servedFrom('https://example.com', '/');
    for (const token of ['abc123', 'a+b/c=', 'zY-_09']) {
      expect(parseInviteToken(inviteUrl(token))).toBe(token);
    }
  });

  it('returns an empty string for empty input rather than throwing', () => {
    expect(parseInviteToken('')).toBe('');
    expect(parseInviteToken('   ')).toBe('');
  });
});
