import { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw, ArrowLeft, Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  children: ReactNode;
  pageName?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * Page-level error boundary with navigation options.
 * Use this to wrap individual page components for granular error handling.
 */
export class PageErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`PageErrorBoundary [${this.props.pageName || "Unknown"}]:`, error, errorInfo);
    this.setState({ errorInfo });
    
    // Could log to an error tracking service here
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    this.props.onReset?.();
  };

  handleGoBack = () => {
    window.history.back();
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[60vh] flex items-center justify-center p-6">
          <Card className="max-w-md w-full bg-card border-border shadow-xl">
            <CardHeader className="text-center pb-4">
              <div className="w-20 h-20 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
                <AlertTriangle className="w-10 h-10 text-destructive" />
              </div>
              <CardTitle className="text-2xl text-foreground">
                {this.props.pageName ? `Error in ${this.props.pageName}` : "Page Error"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <p className="text-muted-foreground text-center">
                Something went wrong while loading this page. This error has been noted and we'll work on fixing it.
              </p>

              {import.meta.env.DEV && this.state.error && (
                <details className="p-4 bg-muted/50 rounded-xl text-sm border border-border">
                  <summary className="cursor-pointer text-muted-foreground font-medium flex items-center gap-2">
                    <Bug className="w-4 h-4" />
                    Developer Details
                  </summary>
                  <div className="mt-3 space-y-2">
                    <p className="font-mono text-destructive text-xs break-all">
                      {this.state.error.message}
                    </p>
                    {this.state.errorInfo?.componentStack && (
                      <pre className="mt-2 overflow-auto text-xs text-muted-foreground whitespace-pre-wrap max-h-40">
                        {this.state.errorInfo.componentStack}
                      </pre>
                    )}
                  </div>
                </details>
              )}

              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Button variant="outline" onClick={this.handleGoBack} className="gap-2">
                  <ArrowLeft className="w-4 h-4" />
                  Go Back
                </Button>
                <Button variant="default" onClick={this.handleReset} className="gap-2">
                  <RefreshCw className="w-4 h-4" />
                  Try Again
                </Button>
              </div>

              <p className="text-xs text-center text-muted-foreground">
                If this keeps happening, try{" "}
                <button 
                  onClick={this.handleReload}
                  className="text-primary hover:underline"
                >
                  refreshing the page
                </button>
                {" "}or contact support.
              </p>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
