import type { ExecState } from '../lib/useExecState.ts';

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="output-line">
      <span className="output-label">{label}</span>
      <pre>{children}</pre>
    </div>
  );
}

export function OutputPanel({ state }: { state: ExecState }) {
  if (!state.status) {
    return (
      <div className="card output">
        <h2>Output</h2>
        <p className="muted">Nothing has been run yet.</p>
      </div>
    );
  }

  const failed = state.status === 'error';
  const exitedBadly = typeof state.exitCode === 'number' && state.exitCode !== 0;

  return (
    <div className="card output">
      <div className="row">
        <h2>Output</h2>
        <span className={`badge ${failed || exitedBadly ? 'disconnected' : 'connected'}`}>
          {state.status === 'running'
            ? 'running…'
            : failed
              ? 'failed'
              : (state.execStatus ?? 'done')}
        </span>
      </div>

      {state.stub && (
        <p className="muted">
          No execution service is configured, so this is a stubbed result — nothing ran.
        </p>
      )}

      {state.status === 'running' && <p className="muted">Waiting for the result…</p>}

      {failed && <p className="error">{state.message}</p>}

      {state.status === 'done' && (
        <>
          {state.stdout ? <Line label="stdout">{state.stdout}</Line> : null}
          {state.stderr ? <Line label="stderr">{state.stderr}</Line> : null}
          {!state.stdout && !state.stderr && (
            <p className="muted">The program produced no output.</p>
          )}
          <p className="muted">
            exit code {String(state.exitCode ?? '—')} · {state.durationMs ?? 0} ms
          </p>
        </>
      )}
    </div>
  );
}
