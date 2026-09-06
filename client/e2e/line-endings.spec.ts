import { expect, test, type Page } from '@playwright/test';
import {
  connectPeer,
  createRoom,
  joinRoom,
  newUser,
  setMemberRole,
  waitFor,
  type Peer,
  type TestUser,
} from './helpers.ts';

/*
 * The regression test for the bug that reached a real user: "he is writing in
 * some lines but in my screen its showing some other lines".
 *
 * Monaco normalises line endings in whatever content it is given; Y.Text does
 * not. A document containing \r\n therefore yields an editor model one
 * character shorter per line than the document believes, so every offset past
 * the first line disagrees and the error compounds with each line above the
 * edit.
 *
 * Nothing typed in a browser can produce a \r — Monaco normalises it away —
 * which is why the corrupting peer here is a headless Yjs client writing
 * straight to Y.Text. That is precisely what a Windows collaborator was doing.
 *
 * Assertions are made against the peer's Y.Text rather than Monaco's DOM.
 * `.view-line` elements only exist for lines Monaco has painted and read as
 * empty when the editor is offscreen, and the hidden textarea is a small IME
 * buffer, not the document. Both mistakes look exactly like "sync is broken".
 */

async function signIn(page: Page, user: TestUser) {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(user.email);
  await page.locator('input[type="password"]').fill(user.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  // Exact, because the lobby also has a "Your rooms" heading.
  await expect(page.getByRole('heading', { name: 'Rooms', exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Puts the caret at the start of a 1-indexed line.
 *
 * Arrow keys rather than a jump-to-start shortcut: Ctrl+Home and Cmd+Home mean
 * different things across platforms, and a test that silently types on the
 * wrong line is exactly the failure it is supposed to be detecting. Pressing
 * Up more times than the document has lines is unambiguous everywhere.
 */
async function placeCaretAtLineStart(page: Page, line: number) {
  await page.locator('.monaco-editor').click();
  await page.keyboard.press('ArrowUp', { delay: 10 });
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Home');
  for (let i = 1; i < line; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
}

async function openRoom(page: Page, roomId: string) {
  await page.goto(`/#/room/${roomId}`);
  // The editor arrives in its own chunk, so wait for the real thing rather
  // than the Suspense placeholder.
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.badge.connected')).toBeVisible({ timeout: 20_000 });
}

test.describe('line endings', () => {
  let peer: Peer | undefined;

  test.afterEach(() => {
    peer?.destroy();
    peer = undefined;
  });

  test('a document containing CRLF is repaired, and edits land on the line they were typed', async ({
    page,
  }) => {
    const windowsUser = await newUser('windows');
    const room = await createRoom(windowsUser, 'CRLF regression');

    const browserUser = await newUser('browser');
    await joinRoom(browserUser, room.inviteToken);

    // The Windows collaborator writes CRLF straight into the document.
    peer = await connectPeer(room.id, windowsUser);
    peer.text.insert(0, 'one\r\ntwo\r\nthree\r\nfour\r\nfive');
    expect(peer.text.toString()).toContain('\r');

    await signIn(page, browserUser);
    await openRoom(page, room.id);

    // The browser repairs the document, and the repair reaches the peer as an
    // ordinary edit.
    await waitFor(
      () => !peer!.text.toString().includes('\r'),
      'the carriage returns to be stripped',
      20_000,
    );
    expect(peer!.text.toString()).toBe('one\ntwo\nthree\nfour\nfive');

    /*
     * The actual reported symptom. Put the caret at the start of line 3 and
     * type. Before the fix the offsets disagreed by one per line above, so
     * this landed on line 2 or earlier and drifted further with each line.
     */
    await placeCaretAtLineStart(page, 3);
    await page.keyboard.type('XX');

    await waitFor(
      () => peer!.text.toString().includes('XX'),
      'the typed text to reach the peer',
      15_000,
    );

    const lines = peer!.text.toString().split('\n');
    expect(lines[2]).toBe('XXthree');
    expect(lines).toEqual(['one', 'two', 'XXthree', 'four', 'five']);
  });

  test('a clean LF document is left alone', async ({ page }) => {
    const owner = await newUser('lfowner');
    const room = await createRoom(owner, 'LF untouched');

    peer = await connectPeer(room.id, owner);
    peer.text.insert(0, 'alpha\nbeta\ngamma');

    await signIn(page, owner);
    await openRoom(page, room.id);

    await placeCaretAtLineStart(page, 2);
    await page.keyboard.type('-');

    await waitFor(
      () => peer!.text.toString().includes('-'),
      'the typed character to reach the peer',
      15_000,
    );

    expect(peer!.text.toString()).toBe('alpha\n-beta\ngamma');
  });

  test('a viewer cannot write, however the editor looks', async ({ page }) => {
    const owner = await newUser('vowner');
    const room = await createRoom(owner, 'Viewer enforcement');

    const viewer = await newUser('viewer');
    await joinRoom(viewer, room.inviteToken);

    // Demote through the same endpoint the members panel uses.
    await setMemberRole(owner, room.id, viewer.email, 'viewer');

    peer = await connectPeer(room.id, owner);
    peer.text.insert(0, 'owned by the owner');

    await signIn(page, viewer);
    await openRoom(page, room.id);

    await expect(page.locator('.editor[data-readonly="true"]')).toBeVisible();

    await page.locator('.monaco-editor').click();
    await page.keyboard.type('viewer was here');

    // Give any write that did escape time to arrive before asserting it did not.
    await page.waitForTimeout(2000);
    expect(peer.text.toString()).toBe('owned by the owner');
  });
});
