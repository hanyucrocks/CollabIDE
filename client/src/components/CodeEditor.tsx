import { useEffect, useRef } from 'react';
// Same API-only entry as monacoSetup, so the full 84-language bundle is
// never pulled in. See the note in lib/monacoSetup.ts.
import * as monaco from 'monaco-editor/editor/editor.api.js';
import * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';
import { MonacoBinding } from 'y-monaco';
import { findStrayCarriageReturns, stripCarriageReturns } from '../lib/lineEndings.ts';
import { configureMonaco, EDITOR_THEME } from '../lib/monacoSetup.ts';

type Props = {
  ydoc: Y.Doc;
  provider: WebsocketProvider | null;
  language: string;
  readOnly?: boolean;
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Awareness state is written by peers, so anything from it that reaches a
 * stylesheet has to be treated as untrusted: a peer could otherwise set a
 * "colour" that closes the declaration and injects rules into everyone's page.
 */
function safeColor(value: unknown): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : '#8b93a4';
}

function safeLabel(value: unknown): string {
  const text = typeof value === 'string' ? value : 'anonymous';
  return text
    .slice(0, 64)
    .replace(/[\\'"\n\r]/g, '')
    .replace(/[^\x20-\x7e]/g, '');
}

export function CodeEditor({ ydoc, provider, language, readOnly = false }: Props) {
  const container = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  // Create the editor once; language and readOnly are applied separately so a
  // change to either never tears down the model the Yjs binding is attached to.
  useEffect(() => {
    configureMonaco();
    const element = container.current;
    if (!element) return;

    const editor = monaco.editor.create(element, {
      value: '',
      language,
      theme: EDITOR_THEME,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13.5,
      lineHeight: 21,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      tabSize: 2,
      padding: { top: 12, bottom: 12 },
    });

    editorRef.current = editor;

    return () => {
      editorRef.current = null;
      editor.getModel()?.dispose();
      editor.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  /*
   * Bind the shared Y.Text to Monaco's model.
   *
   * Monaco normalises line endings in whatever content it is given; Y.Text
   * does not. A document containing \r\n therefore yields a model one
   * character shorter per line than the document believes, every offset past
   * the first line disagrees, and edits land somewhere other than where they
   * were typed — text appearing on the wrong line, drifting further down the
   * file. That is the failure this guards against.
   *
   * Healing after the binding exists does not work: the deletes are expressed
   * in document offsets and applied at the model's, so they remove the wrong
   * characters. It has to happen while nothing is bound.
   */
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !provider) return;

    const ytext = ydoc.getText('code');
    let binding = new MonacoBinding(ytext, model, new Set([editor]), provider.awareness);
    let cancelled = false;

    /*
     * Undo has to go through Yjs, not Monaco.
     *
     * Monaco's own undo stack only records edits that went through
     * pushEditOperations — i.e. local typing. y-monaco applies remote changes
     * with applyEdits, which never touches the command manager, so Monaco's
     * stack neither records them nor adjusts the offsets it has already
     * recorded. After a peer edits above your cursor, Ctrl+Z therefore applies
     * inverse edits at stale positions; and because that lands as a model
     * change, y-monaco pushes it straight back into the document. One person's
     * undo corrupts the file for everyone.
     *
     * A Y.UndoManager reverses only this client's own changes, expressed in
     * document terms, so it stays correct however much the rest of the
     * document has moved underneath.
     *
     * trackedOrigins holds the binding *object*: y-monaco transacts with
     * `this` as the origin, not a string. Anything else — a remote update, or
     * the line-endings repair above, which transacts with no origin — is
     * deliberately not tracked, so Ctrl+Z cannot undo a peer's work or a
     * corruption repair.
     */
    const undoManager = new Y.UndoManager(ytext, {
      trackedOrigins: new Set([binding]),
    });

    /*
     * Runs once the initial sync has landed, which is the first moment the
     * document's real contents are known — before it, there is nothing to
     * inspect and the check would pass vacuously.
     *
     * The binding is deliberately torn down and rebuilt around the edit rather
     * than deferred until after it. Leaving the editor unbound while waiting
     * for a sync that may never arrive would silently discard anything typed
     * in the meantime.
     */
    const normalise = () => {
      if (cancelled) return;

      model.setEOL(monaco.editor.EndOfLineSequence.LF);
      if (!findStrayCarriageReturns(ytext.toString()).length) return;

      binding.destroy();
      stripCarriageReturns(ytext);
      binding = new MonacoBinding(ytext, model, new Set([editor]), provider.awareness);
      model.setEOL(monaco.editor.EndOfLineSequence.LF);

      // The manager tracks the binding by identity, so the rebuilt one has to
      // be swapped in or nothing typed afterwards would be undoable. Mutating
      // the set rather than recreating the manager keeps any history from
      // before the repair.
      undoManager.trackedOrigins.clear();
      undoManager.trackedOrigins.add(binding);
    };

    /*
     * Note for anyone tempted to drop the delete above: rebuilding the binding
     * happens to repair the document on its own, because it re-seeds Y.Text
     * from a model Monaco has already normalised. The e2e suite still passes
     * with `stripCarriageReturns` commented out, which is how that was found.
     *
     * Keep it anyway. That re-seed is a side effect of y-monaco's constructor
     * rather than a documented guarantee, and it repairs by replacing the
     * whole text rather than by deleting the characters that are actually
     * wrong. The explicit delete is the intended mechanism and the one the
     * unit tests describe; the rebuild is defence in depth behind it.
     */

    /*
     * Take over the undo keys.
     *
     * `addAction` and `addCommand` both lose this fight: undo and redo are
     * core Monaco commands and their keybindings win over a registered
     * action's, so the handler simply never runs. That was verified rather
     * than assumed — with an action bound, the UndoManager had the edit on its
     * stack and the action's `run` was never called.
     *
     * Intercepting the keydown and cancelling it is what actually displaces
     * the built-in, and `onKeyDown` returns a disposable so it goes away with
     * the binding.
     */
    const keys = editor.onKeyDown((event) => {
      if (!(event.ctrlKey || event.metaKey) || event.keyCode !== monaco.KeyCode.KeyZ) {
        return;
      }

      // Stop Monaco's own undo from also running against the shared model.
      event.preventDefault();
      event.stopPropagation();

      if (event.shiftKey) undoManager.redo();
      else undoManager.undo();
    });

    // Ctrl+Y is the other redo convention on Windows and Linux.
    const redoKey = editor.onKeyDown((event) => {
      if (!(event.ctrlKey || event.metaKey) || event.keyCode !== monaco.KeyCode.KeyY) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      undoManager.redo();
    });

    /*
     * `on` plus a manual unsubscribe rather than `once`: lib0 wraps a `once`
     * handler in a closure it does not hand back, so `off` cannot match it and
     * the listener would outlive an editor that unmounted before the first
     * sync arrived. The provider is longer-lived than this component, so that
     * leak accumulates across room switches.
     */
    let listening = false;
    const onSync = () => {
      listening = false;
      provider.off('sync', onSync);
      normalise();
    };

    if (provider.synced) {
      normalise();
    } else {
      provider.on('sync', onSync);
      listening = true;
    }

    return () => {
      cancelled = true;
      // Only if it is still attached: lib0 logs a warning for removing a
      // handler that is already gone, and onSync removes itself when it fires.
      if (listening) provider.off('sync', onSync);
      keys.dispose();
      redoKey.dispose();
      // The Y.Doc deliberately outlives this component (see useCollabDoc), so
      // an UndoManager left attached to it would accumulate across every room
      // the user opens.
      undoManager.destroy();
      binding.destroy();
    };
  }, [ydoc, provider]);

  /*
   * y-monaco tags each peer's caret and selection with
   * `yRemoteSelection-<clientId>` classes but ships no CSS for them, so
   * without this every remote cursor is invisible. Rules are regenerated on
   * each awareness change and scoped to one <style> element we own.
   */
  useEffect(() => {
    if (!provider) return;
    const { awareness } = provider;

    const style = document.createElement('style');
    document.head.appendChild(style);

    const render = () => {
      const rules: string[] = [];

      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;

        const user = (state as { user?: { name?: unknown; color?: unknown } }).user;
        if (!user) return;

        const color = safeColor(user.color);
        const label = safeLabel(user.name);

        rules.push(
          `.yRemoteSelection-${clientId} { background-color: ${color}3d; }`,
          `.yRemoteSelectionHead-${clientId} {` +
            `position: absolute; border-left: 2px solid ${color};` +
            'height: 100%; box-sizing: border-box; }',
          // -18px lifts the label a full line above the caret (line height is
          // 21px, the label ~13px), so it never sits on top of the line the
          // peer is actually editing.
          `.yRemoteSelectionHead-${clientId}::after {` +
            `content: '${label}'; position: absolute; top: -18px; left: -2px;` +
            `background: ${color}; color: #0b0d12; font-size: 9px;` +
            'font-family: ui-sans-serif, system-ui, sans-serif; font-weight: 600;' +
            'line-height: 13px; padding: 0 4px; border-radius: 3px;' +
            'white-space: nowrap; pointer-events: none; z-index: 20;' +
            'box-shadow: 0 1px 3px rgba(0,0,0,0.5); }',
        );
      });

      style.textContent = rules.join('\n');
    };

    render();
    awareness.on('change', render);

    return () => {
      awareness.off('change', render);
      style.remove();
    };
  }, [provider]);

  /*
   * data-readonly mirrors the prop deliberately. Monaco's own DOM is not a
   * reliable signal: its hidden textarea reports readOnly while the editor is
   * merely unfocused, so it reads the same whether or not editing is allowed.
   */
  return <div ref={container} className="editor" data-readonly={readOnly} />;
}
