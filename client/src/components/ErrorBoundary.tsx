import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Catches render errors so one broken component does not blank the page.
 *
 * React unmounts the entire root when a render throws and nothing catches it,
 * which leaves an empty document and no indication that anything went wrong.
 * A class component is the only API that can intercept that.
 *
 * This became necessary rather than merely advisable when the editor moved
 * behind a dynamic import: a chunk that fails to load — a flaky connection, or
 * a stale index referring to a file a redeploy has replaced — throws during
 * render. Without this the symptom would be a white screen, and the fix for
 * that particular cause really is a reload, which is why the fallback leads
 * with one.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The stack React collects is more useful than the one on the error, since
    // it names the component that threw.
    console.error('[ui] render failed', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="card centered warning">
        <strong>Something broke while rendering this page.</strong>
        <p className="muted">
          Reloading usually fixes it — most often this means part of the app failed to
          download, or the page is running an older version than the server is now
          serving. Nothing you have written is affected; the document lives on the server.
        </p>
        <p className="muted error-detail">{error.message}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
