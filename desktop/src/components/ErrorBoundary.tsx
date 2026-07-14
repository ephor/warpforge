import React from "react";

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
          <div className="max-w-md space-y-3 text-center">
            <div className="text-destructive font-medium">Something went wrong</div>
            <div className="text-xs">{this.state.error.message}</div>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="rounded bg-secondary px-3 py-1 text-xs text-foreground hover:bg-secondary/80"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
