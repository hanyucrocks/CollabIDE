import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  resolve: {
    alias: {
      /*
       * y-monaco 0.1.6 imports Monaco as `monaco-editor/esm/vs/editor/editor.api.js`,
       * a deep path that monaco-editor 0.56's exports map ("./*.js" -> "./esm/vs/*.js")
       * no longer permits — it would double the esm/vs prefix and fail to resolve.
       *
       * The target below goes through the exports map to the same file that the
       * bare `monaco-editor` entry re-exports from (esm/vs/index.js line 166), so
       * the app and y-monaco share one Monaco instance rather than bundling two.
       */
      'monaco-editor/esm/vs/editor/editor.api.js': 'monaco-editor/editor/editor.api.js',
    },
  },
});
