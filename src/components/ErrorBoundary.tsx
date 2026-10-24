import { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/** Shared recovery screen for React and data-router failures. */
export function ErrorFallback({ onReset, onGoHome, error, errorInfo }: {
  onReset: () => void;
  onGoHome: () => void;
  error?: Error | null;
  errorInfo?: ErrorInfo | null;
}) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <Card className="max-w-lg w-full bg-card border-border">
        <CardHeader className="text-center pb-2">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-8 h-8 text-destructive" />
          </div>
          <CardTitle className="text-xl text-foreground">Something went wrong</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-center text-sm">
            An unexpected error occurred. Please try refreshing the page or return to the home page.
          </p>
          {import.meta.env.DEV && error && (
            <details className="mt-4 p-3 bg-muted/50 rounded-lg text-xs">
              <summary className="cursor-pointer text-muted-foreground font-medium">Error Details</summary>
              <pre className="mt-2 overflow-auto text-destructive whitespace-pre-wrap">
                {error.toString()}
                {errorInfo?.componentStack}
              </pre>
            </details>
          )}
          <div className="flex gap-3 justify-center pt-2">
            <Button variant="outline" onClick={onReset} className="gap-2">
              <RefreshCw className="w-4 h-4" />Try Again
            </Button>
            <Button variant="default" onClick={onGoHome} className="gap-2">
              <Home className="w-4 h-4" />Go Home
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// A fresh document also recovers a rejected lazy import cached by React.lazy.
export function RouteErrorFallback() {
  return <ErrorFallback onReset={() => window.location.reload()} onGoHome={() => window.location.assign("/")} />;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  handleGoHome = () => {
    window.location.href = "/";
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <ErrorFallback onReset={this.handleReset} onGoHome={this.handleGoHome} error={this.state.error} errorInfo={this.state.errorInfo} />
      );
    }

    return this.props.children;
  }
}

// Higher-order component for wrapping functional components
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  fallback?: ReactNode
) {
  return function WithErrorBoundaryWrapper(props: P) {
    return (
      <ErrorBoundary fallback={fallback}>
        <WrappedComponent {...props} />
      </ErrorBoundary>
    );
  };
}
