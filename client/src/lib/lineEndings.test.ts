import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { findStrayCarriageReturns, stripCarriageReturns } from './lineEndings.ts';

describe('findStrayCarriageReturns', () => {
  it('finds nothing in an empty document', () => {
    expect(findStrayCarriageReturns('')).toEqual([]);
  });

  it('finds nothing in a document that already uses LF', () => {
    expect(findStrayCarriageReturns('one\ntwo\nthree')).toEqual([]);
  });

  it('finds the carriage return in each CRLF pair', () => {
    //                                0123 4567 89
    expect(findStrayCarriageReturns('one\r\ntwo\r\n')).toEqual([3, 8]);
  });

  it('handles a pair at the very start', () => {
    expect(findStrayCarriageReturns('\r\nafter')).toEqual([0]);
  });

  it('handles consecutive blank CRLF lines', () => {
    expect(findStrayCarriageReturns('a\r\n\r\nb')).toEqual([1, 3]);
  });

  /*
   * The important negative case. A lone \r is a legitimate character — inside
   * a string literal, a regex, or old Mac line endings — and deleting it would
   * corrupt the document rather than repair it. Only paired ones are line
   * endings.
   */
  it('ignores a carriage return that is not followed by a newline', () => {
    expect(findStrayCarriageReturns('literal \\r here')).toEqual([]);
    expect(findStrayCarriageReturns('alone\rnot a line ending')).toEqual([]);
  });

  it('ignores a trailing carriage return with nothing after it', () => {
    expect(findStrayCarriageReturns('trailing\r')).toEqual([]);
  });

  it('finds only the paired one when both kinds are present', () => {
    //                               0123456 78
    expect(findStrayCarriageReturns('a\rb\r\nc')).toEqual([3]);
  });
});

describe('stripCarriageReturns', () => {
  const textOf = (content: string) => {
    const doc = new Y.Doc();
    const ytext = doc.getText('code');
    ytext.insert(0, content);
    return ytext;
  };

  it('leaves an already-clean document untouched', () => {
    const ytext = textOf('one\ntwo\nthree');
    expect(stripCarriageReturns(ytext)).toBe(0);
    expect(ytext.toString()).toBe('one\ntwo\nthree');
  });

  /*
   * The regression test for the bug that reached a real user. Deleting
   * forwards invalidates every later index as the string shrinks, which is one
   * of the three ways the original fix failed — it produced "onetwo/hree/fur".
   */
  it('removes every carriage return and preserves the rest exactly', () => {
    const ytext = textOf('one\r\ntwo\r\nthree\r\nfour\r\nfive');
    expect(stripCarriageReturns(ytext)).toBe(4);
    expect(ytext.toString()).toBe('one\ntwo\nthree\nfour\nfive');
    expect(ytext.toString()).not.toContain('\r');
  });

  it('keeps a lone carriage return that is not a line ending', () => {
    const ytext = textOf('const re = /a\\rb/;\r\nnext');
    stripCarriageReturns(ytext);
    expect(ytext.toString()).toBe('const re = /a\\rb/;\nnext');
  });

  it('handles a document that is nothing but line endings', () => {
    const ytext = textOf('\r\n\r\n\r\n');
    expect(stripCarriageReturns(ytext)).toBe(3);
    expect(ytext.toString()).toBe('\n\n\n');
  });

  it('emits one update for the whole repair, not one per line', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('code');
    ytext.insert(0, 'a\r\nb\r\nc\r\nd');

    let updates = 0;
    doc.on('update', () => updates++);
    stripCarriageReturns(ytext);

    expect(updates).toBe(1);
  });

  /*
   * The property that makes the repair safe to run on one peer while others
   * are connected: it is an ordinary edit, so it merges rather than clobbering.
   */
  it('converges when a peer edits concurrently', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const sync = (from: Y.Doc, to: Y.Doc) =>
      Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));

    a.getText('code').insert(0, 'one\r\ntwo\r\nthree');
    sync(a, b);

    // A repairs line endings while B appends, neither seeing the other yet.
    stripCarriageReturns(a.getText('code'));
    b.getText('code').insert(b.getText('code').length, '!');

    sync(a, b);
    sync(b, a);

    expect(a.getText('code').toString()).toBe(b.getText('code').toString());
    expect(a.getText('code').toString()).not.toContain('\r');
  });
});
