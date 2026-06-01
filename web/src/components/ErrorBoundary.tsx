import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Button } from "./ui/button";
import { makeT, readInitialLocale } from "../i18n";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Skill Sync UI crashed.", error, info);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    const t = makeT(readInitialLocale());

    return (
      <main className="error-boundary" role="alert">
        <div className="error-boundary-panel">
          <span className="confirm-icon danger">
            <CircleAlert size={18} aria-hidden="true" />
          </span>
          <div>
            <p className="eyebrow">{t("uiError")}</p>
            <h1>{t("somethingWentWrong")}</h1>
            <p>{this.state.error.message || t("interfaceError")}</p>
            <Button type="button" variant="primary" onClick={() => window.location.reload()}>
              <RefreshCw size={15} aria-hidden="true" />
              {t("reload")}
            </Button>
          </div>
        </div>
      </main>
    );
  }
}
