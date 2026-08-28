import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command, mode }) => {
  // Vite reads VITE_* from .env files locally and from the process environment
  // on a CI/host build, so check both before deciding it is missing.
  const fromFiles = loadEnv(mode, process.cwd(), '');
  const apiUrl = process.env.VITE_API_URL ?? fromFiles.VITE_API_URL;

  /*
   * Fail the build rather than ship a misconfigured bundle.
   *
   * VITE_* values are inlined at build time. Without VITE_API_URL the client
   * silently falls back to http://localhost:4000 — and because browsers treat
   * localhost as a trustworthy origin, it is not blocked as mixed content. The
   * deployed site then works perfectly for whoever has the API running locally
   * and is completely broken for everyone else. That is a bug that reaches a
   * demo, so it is worth refusing to build.
   */
  if (command === 'build' && mode === 'production' && !apiUrl) {
    throw new Error(
      'VITE_API_URL is not set.\n\n' +
        '  Set it to the deployed API origin, e.g. https://collabide-api.onrender.com\n' +
        '  On Vercel: Settings -> Environment Variables, then redeploy (the value is\n' +
        '  compiled in, so an existing deployment will not pick it up).\n' +
        '  Locally: copy client/.env.example to client/.env.\n',
    );
  }

  if (command === 'build') {
    console.log(`[build] VITE_API_URL = ${apiUrl}`);
  }

  return {
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
  };
});
