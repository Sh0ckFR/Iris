import { Component, type ErrorInfo, type ReactNode } from 'react';
import { IrisLogo } from './features/hud/IrisLogo';
import { t } from './i18n';

interface State {
  error: Error | null;
}

/**
 * Without a boundary, one rendering error unmounts the whole HUD and leaves a blank window.
 * This shows what went wrong and lets the user reload instead.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[iris] interface error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const m = t().app;
    return (
      <div className="crash">
        <IrisLogo size={96} className="crash-logo" />
        <h1>I.R.I.S</h1>
        <p>{m.displayError}</p>
        <pre>{error.message}</pre>
        <button type="button" onClick={() => window.location.reload()}>
          {m.reload}
        </button>
      </div>
    );
  }
}
