import type * as Y from 'yjs';

/**
 * Indices of the `\r` in every `\r\n` pair.
 *
 * Only paired carriage returns count. A lone `\r` is a legitimate character
 * inside a string literal or a regex, and removing it would corrupt the
 * document rather than repair it — the bug being fixed is line endings, not
 * carriage returns in general.
 */
export function findStrayCarriageReturns(content: string): number[] {
  const found: number[] = [];
  for (let i = 0; i < content.length - 1; i++) {
    if (content[i] === '\r' && content[i + 1] === '\n') found.push(i);
  }
  return found;
}

/**
 * Removes those carriage returns from the shared text, in one transaction.
 * Returns how many were removed.
 *
 * Why this exists at all: Monaco normalises line endings in whatever content
 * it is given and `Y.Text` does not, so a document containing `\r\n` yields an
 * editor model one character shorter per line than the document believes.
 * Every offset past the first line then disagrees, and the error compounds
 * with each line above the edit — text lands on the wrong line, drifting
 * further down the file the longer the session runs.
 *
 * The caller must destroy the Monaco binding before calling this and rebuild
 * it afterwards. Deleting while bound expresses the deletes in document
 * offsets and applies them at the model's, which removes the wrong characters
 * and reproduces the corruption it is trying to fix.
 */
export function stripCarriageReturns(ytext: Y.Text): number {
  const strays = findStrayCarriageReturns(ytext.toString());
  if (!strays.length) return 0;

  const apply = () => {
    // Backwards, so each deletion leaves the earlier indices valid.
    for (let i = strays.length - 1; i >= 0; i--) ytext.delete(strays[i], 1);
  };

  // One transaction, so peers see a single update rather than one per line.
  if (ytext.doc) ytext.doc.transact(apply);
  else apply();

  return strays.length;
}
