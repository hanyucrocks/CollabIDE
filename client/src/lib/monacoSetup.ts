/*
 * monaco-editor's exports map is `"./*.js": "./esm/vs/*.js"`, so these paths
 * omit the esm/vs prefix that older setup guides still show.
 *
 * Importing `editor.api.js` rather than the bare `monaco-editor` entry matters:
 * the bare entry eagerly registers all 84 bundled language definitions. We
 * register only the four a room can use, which is most of the difference
 * between a ~1.1 MB and a ~0.4 MB gzipped initial bundle.
 */
import * as monaco from 'monaco-editor/editor/editor.api.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/cpp/register.js';
import 'monaco-editor/languages/definitions/java/register.js';

// Gives JavaScript rooms completions and diagnostics. The TS worker it needs is
// a lazily fetched chunk, so it costs nothing until a JS room is opened.
import 'monaco-editor/languages/features/typescript/register.js';

export const EDITOR_THEME = 'collabide-dark';

let configured = false;

/**
 * Wires Monaco's web workers through Vite and registers the app's theme.
 *
 * Only the editor and TypeScript workers are bundled: of the room languages
 * (javascript, python, cpp, java) only javascript has a dedicated language
 * service. The rest need tokenisation alone, which lives in the main bundle.
 */
export function configureMonaco(): void {
  if (configured) return;
  configured = true;

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === 'javascript' || label === 'typescript') return new TsWorker();
      return new EditorWorker();
    },
  };

  monaco.editor.defineTheme(EDITOR_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0f1115',
      'editor.foreground': '#e6e9ef',
      'editorLineNumber.foreground': '#3a4152',
      'editorLineNumber.activeForeground': '#8b93a4',
      'editor.lineHighlightBackground': '#171a21',
      'editorCursor.foreground': '#5b8cff',
      'editor.selectionBackground': '#26324d',
    },
  });
}
