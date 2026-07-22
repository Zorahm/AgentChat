/** Top-level crash guard.
 *
 * React error boundaries can only be class components — there is no hook
 * equivalent — so this is the one sanctioned exception to the functional-only
 * rule in AGENTS.md. Without it, any uncaught throw in a render/effect (e.g. a
 * `JSON.stringify` cycle error) unmounts the entire tree to a blank screen.
 * `withTranslation` (react-i18next's class-component HOC) supplies `t` since
 * `useTranslation` isn't usable here.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { withTranslation, type WithTranslation } from "react-i18next";
import { Button } from "@astryxdesign/core/Button";

interface ErrorBoundaryProps extends WithTranslation {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundaryBase extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
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
    const { t } = this.props;
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
        <div style={{ fontSize: 18, fontWeight: 600 }}>{t("errorBoundary.title")}</div>
        <div style={{ fontSize: 13, opacity: 0.7, maxWidth: 420, wordBreak: "break-word" }}>
          {error.message || t("errorBoundary.unknownError")}
        </div>
        <Button
          label={t("errorBoundary.reload")}
          onClick={this.handleReload}
          variant="secondary"
          style={{ marginTop: 8 }}
        />
      </div>
    );
  }
}

export const ErrorBoundary = withTranslation()(ErrorBoundaryBase);
