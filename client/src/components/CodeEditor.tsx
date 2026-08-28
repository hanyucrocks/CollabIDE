import { useEffect, useRef } from 'react';
// Same API-only entry as monacoSetup, so the full 84-language bundle is
// never pulled in. See the note in lib/monacoSetup.ts.
import * as monaco from 'monaco-editor/editor/editor.api.js';
import * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';
import { MonacoBinding } from 'y-monaco';
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

  // Bind the shared Y.Text to Monaco's model. y-monaco owns the diffing and
  // the relative-position bookkeeping that keeps remote cursors anchored to
  // characters rather than to offsets.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !provider) return;

    const binding = new MonacoBinding(
      ydoc.getText('code'),
      model,
      new Set([editor]),
      provider.awareness,
    );

    return () => binding.destroy();
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
