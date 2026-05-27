/** Top-level crash guard.
 *
 * React error boundaries can only be class components — there is no hook
 * equivalent — so this is the one sanctioned exception to the functional-only
 * rule in AGENTS.md. Without it, any uncaught throw in a render/effect (e.g. a
 * `JSON.stringify` cycle error) unmounts the entire tree to a blank screen.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the full component stack so a blank-screen crash is diagnosable.
    console.error("[ErrorBoundary] uncaught error:", error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 32,
          textAlign: "center",
          color: "var(--ink, #1a1a18)",
          background: "var(--surface, #faf9f6)",
        }}
      >
        <div style={{ fontSize: 40 }}>👻</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Что-то сломалось</div>
        <div style={{ fontSize: 13, opacity: 0.7, maxWidth: 420, wordBreak: "break-word" }}>
          {error.message || "Неизвестная ошибка"}
        </div>
        <button
          type="button"
          onClick={this.handleReload}
          style={{
            marginTop: 8,
            padding: "8px 18px",
            fontSize: 14,
            borderRadius: 8,
            border: "1px solid var(--line-2, #ccc)",
            background: "var(--surface-2, #fff)",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          Перезагрузить
        </button>
      </div>
    );
  }
}
