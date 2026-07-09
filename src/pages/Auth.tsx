import { useState, useEffect } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Eye, EyeOff, Mail, Lock, User, ArrowRight, ArrowLeft, CheckCircle, MailCheck, AlertTriangle } from "lucide-react";
import { SaffLogo } from "@/components/SaffLogo";
import { z } from "zod";
import { useLoginRateLimit } from "@/hooks/useLoginRateLimit";

const emailSchema = z.string().email("Please enter a valid email address");
const passwordSchema = z.string().min(6, "Password must be at least 6 characters");

type AuthMode = "login" | "signup" | "forgot-password" | "reset-password" | "verify-email";

export default function Auth() {
  const [searchParams] = useSearchParams();
  const initialMode = searchParams.get("mode") as AuthMode || "login";
  
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [signupEmail, setSignupEmail] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string; confirmPassword?: string }>({});
  
  const { signIn, signUp, user } = useAuth();
  const navigate = useNavigate();
  const { 
    isLocked, 
    getRemainingAttempts, 
    recordFailedAttempt, 
    recordSuccessfulLogin,
    remainingTime,
    formatRemainingTime,
    attempts 
  } = useLoginRateLimit();

  useEffect(() => {
    if (user && mode !== "reset-password" && mode !== "verify-email") {
      navigate("/");
    }
  }, [user, navigate, mode]);

  // Check for password reset token in URL
  useEffect(() => {
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const accessToken = hashParams.get("access_token");
    const type = hashParams.get("type");
    
    if (accessToken && type === "recovery") {
      setMode("reset-password");
    }
  }, []);

  const validateForm = () => {
    const newErrors: { email?: string; password?: string; confirmPassword?: string } = {};
    
    if (mode !== "reset-password") {
      const emailResult = emailSchema.safeParse(email);
      if (!emailResult.success) {
        newErrors.email = emailResult.error.errors[0].message;
      }
    }
    
    if (mode === "login" || mode === "signup" || mode === "reset-password") {
      const passwordResult = passwordSchema.safeParse(password);
      if (!passwordResult.success) {
        newErrors.password = passwordResult.error.errors[0].message;
      }
    }

    if (mode === "reset-password" && password !== confirmPassword) {
      newErrors.confirmPassword = "Passwords do not match";
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const emailResult = emailSchema.safeParse(email);
    if (!emailResult.success) {
      setErrors({ email: emailResult.error.errors[0].message });
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth?mode=reset-password`,
      });
      
      if (error) {
        toast.error(error.message);
      } else {
        toast.success("Password reset email sent! Check your inbox.");
        setMode("login");
      }
    } catch (error) {
      toast.error("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) return;

    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      
      if (error) {
        toast.error(error.message);
      } else {
        toast.success("Password updated successfully!");
        navigate("/");
      }
    } catch (error) {
      toast.error("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (mode === "forgot-password") {
      return handleForgotPassword(e);
    }

    if (mode === "reset-password") {
      return handleResetPassword(e);
    }
    
    if (!validateForm()) return;
    
    // Check rate limiting for login attempts
    if (mode === "login" && isLocked()) {
      toast.error(`Too many failed attempts. Please wait ${formatRemainingTime()} before trying again.`);
      return;
    }

    setLoading(true);
    
    try {
      if (mode === "login") {
        const { error } = await signIn(email, password);
        if (error) {
          const { locked, lockoutSeconds } = recordFailedAttempt();
          
          if (locked) {
            toast.error(`Too many failed attempts. Account locked for ${Math.ceil(lockoutSeconds / 60)} minute(s).`);
          } else if (error.message.includes("Invalid login credentials")) {
            const remaining = getRemainingAttempts() - 1;
            toast.error(`Invalid email or password. ${remaining > 0 ? `${remaining} attempts remaining.` : ''}`);
          } else {
            toast.error(error.message);
          }
        } else {
          recordSuccessfulLogin();
          toast.success("Welcome back!");
          navigate("/");
        }
      } else {
        const { error } = await signUp(email, password, displayName);
        if (error) {
          if (error.message.includes("User already registered")) {
            toast.error("This email is already registered. Please sign in instead.");
          } else {
            toast.error(error.message);
          }
        } else {
          setSignupEmail(email);
          setMode("verify-email");
          toast.success("Account created! Please check your email.");
        }
      }
    } catch (error) {
      toast.error("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const getTitle = () => {
    switch (mode) {
      case "login": return "Welcome back";
      case "signup": return "Create your account";
      case "forgot-password": return "Reset your password";
      case "reset-password": return "Set new password";
      case "verify-email": return "Check your email";
    }
  };

  const getSubtitle = () => {
    switch (mode) {
      case "login": return "Sign in to your SAFF ERP account";
      case "signup": return "Start transforming trial balances into insights";
      case "forgot-password": return "Enter your email and we'll send you a reset link";
      case "reset-password": return "Enter your new password below";
      case "verify-email": return "We've sent a verification link to your email";
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-md relative z-10">
        {/* Back to home */}
        <div className="mb-5">
          <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to home
          </Link>
        </div>

        {/* Logo */}
        <div className="text-center mb-8">
          <Link to="/" className="inline-block mb-6">
            <SaffLogo variant="full" className="h-24 w-auto mx-auto" />
          </Link>
          <h1 className="text-2xl font-bold text-foreground">{getTitle()}</h1>
          <p className="text-muted-foreground mt-2">{getSubtitle()}</p>
        </div>

        {/* Email Verification Success */}
        {mode === "verify-email" ? (
          <div className="bg-card border border-border rounded-2xl p-8 shadow-lg">
            <div className="text-center space-y-6">
              <div className="w-20 h-20 mx-auto rounded-full bg-accent/10 flex items-center justify-center">
                <MailCheck className="w-10 h-10 text-accent" />
              </div>
              
              <div className="space-y-2">
                <h2 className="text-xl font-semibold text-foreground">Verification email sent!</h2>
                <p className="text-muted-foreground">
                  We've sent a confirmation link to:
                </p>
                <p className="text-foreground font-medium">{signupEmail}</p>
              </div>

              <div className="bg-secondary/50 rounded-xl p-4 text-sm text-muted-foreground space-y-2">
                <div className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-accent mt-0.5 shrink-0" />
                  <span>Click the link in the email to verify your account</span>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-accent mt-0.5 shrink-0" />
                  <span>Check your spam folder if you don't see it</span>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-accent mt-0.5 shrink-0" />
                  <span>The link expires in 24 hours</span>
                </div>
              </div>

              <div className="pt-4 space-y-3">
                <Button
                  variant="hero"
                  className="w-full gap-2"
                  onClick={() => {
                    setMode("login");
                    setEmail(signupEmail);
                    setPassword("");
                    setErrors({});
                  }}
                >
                  Continue to Sign In
                  <ArrowRight className="w-4 h-4" />
                </Button>
                
                <p className="text-sm text-muted-foreground">
                  Didn't receive the email?{" "}
                  <button
                    onClick={async () => {
                      setLoading(true);
                      try {
                        const { error } = await supabase.auth.resend({
                          type: "signup",
                          email: signupEmail,
                          options: {
                            emailRedirectTo: `${window.location.origin}/`,
                          },
                        });
                        if (error) {
                          toast.error(error.message);
                        } else {
                          toast.success("Verification email resent!");
                        }
                      } catch {
                        toast.error("Failed to resend email. Please try again.");
                      } finally {
                        setLoading(false);
                      }
                    }}
                    disabled={loading}
                    className="text-primary hover:text-primary/80 font-medium"
                  >
                    {loading ? "Sending..." : "Resend email"}
                  </button>
                </p>
              </div>
            </div>
          </div>
        ) : (
          /* Form */
          <div className="bg-card border border-border rounded-2xl p-8 shadow-lg">
            <form onSubmit={handleSubmit} className="space-y-5">
              {mode === "signup" && (
                <div className="space-y-2">
                  <Label htmlFor="displayName" className="text-foreground">
                    Display Name
                  </Label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                    <Input
                      id="displayName"
                      type="text"
                      placeholder="Your name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className="pl-10 bg-secondary border-border focus:border-primary"
                    />
                  </div>
                </div>
              )}

              {mode !== "reset-password" && (
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-foreground">
                    Email
                  </Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      placeholder="you@company.com"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setErrors((prev) => ({ ...prev, email: undefined }));
                      }}
                      className={`pl-10 bg-secondary border-border focus:border-primary ${
                        errors.email ? "border-destructive" : ""
                      }`}
                    />
                  </div>
                  {errors.email && (
                    <p className="text-sm text-destructive">{errors.email}</p>
                  )}
                </div>
              )}

              {(mode === "login" || mode === "signup" || mode === "reset-password") && (
                <div className="space-y-2">
                  <Label htmlFor="password" className="text-foreground">
                    {mode === "reset-password" ? "New Password" : "Password"}
                  </Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setErrors((prev) => ({ ...prev, password: undefined }));
                      }}
                      className={`pl-10 pr-10 bg-secondary border-border focus:border-primary ${
                        errors.password ? "border-destructive" : ""
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                  {errors.password && (
                    <p className="text-sm text-destructive">{errors.password}</p>
                  )}
                </div>
              )}

              {mode === "reset-password" && (
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword" className="text-foreground">
                    Confirm New Password
                  </Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                    <Input
                      id="confirmPassword"
                      type={showPassword ? "text" : "password"}
                      placeholder="••••••••"
                      value={confirmPassword}
                      onChange={(e) => {
                        setConfirmPassword(e.target.value);
                        setErrors((prev) => ({ ...prev, confirmPassword: undefined }));
                      }}
                      className={`pl-10 bg-secondary border-border focus:border-primary ${
                        errors.confirmPassword ? "border-destructive" : ""
                      }`}
                    />
                  </div>
                  {errors.confirmPassword && (
                    <p className="text-sm text-destructive">{errors.confirmPassword}</p>
                  )}
                </div>
              )}

              {mode === "login" && (
                <div className="flex items-center justify-between">
                  {attempts > 0 && attempts < 5 && (
                    <p className="text-sm text-muted-foreground">
                      {getRemainingAttempts()} attempts remaining
                    </p>
                  )}
                  {isLocked() && remainingTime > 0 && (
                    <div className="flex items-center gap-1.5 text-sm text-destructive">
                      <AlertTriangle className="w-4 h-4" />
                      <span>Locked for {formatRemainingTime()}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setMode("forgot-password");
                      setErrors({});
                    }}
                    className="text-sm text-primary hover:text-primary/80 ml-auto"
                  >
                    Forgot password?
                  </button>
                </div>
              )}

              {/* Google OAuth — show only on login / signup */}
              {(mode === "login" || mode === "signup") && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full gap-2 mb-1"
                    onClick={async () => {
                      const { error } = await supabase.auth.signInWithOAuth({
                        provider: "google",
                        options: { redirectTo: window.location.origin + "/dashboard" },
                      });
                      if (error) toast.error(error.message);
                    }}
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    Continue with Google
                  </Button>
                  <div className="relative my-3">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-border" />
                    </div>
                    <div className="relative flex justify-center text-xs">
                      <span className="bg-card px-2 text-muted-foreground">or with email</span>
                    </div>
                  </div>
                </>
              )}

              <Button
                type="submit"
                variant="hero"
                className="w-full gap-2"
                disabled={loading || (mode === "login" && isLocked())}
              >
                {loading ? (
                  "Loading..."
                ) : (
                  <>
                    {mode === "login" && "Sign In"}
                    {mode === "signup" && "Create Account"}
                    {mode === "forgot-password" && "Send Reset Link"}
                    {mode === "reset-password" && "Update Password"}
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </Button>
            </form>

            <div className="mt-6 text-center">
              {mode === "login" && (
                <p className="text-muted-foreground text-sm">
                  Don't have an account?{" "}
                  <button
                    onClick={() => {
                      setMode("signup");
                      setErrors({});
                    }}
                    className="text-primary hover:text-primary/80 font-medium"
                  >
                    Sign up
                  </button>
                </p>
              )}
              {mode === "signup" && (
                <p className="text-muted-foreground text-sm">
                  Already have an account?{" "}
                  <button
                    onClick={() => {
                      setMode("login");
                      setErrors({});
                    }}
                    className="text-primary hover:text-primary/80 font-medium"
                  >
                    Sign in
                  </button>
                </p>
              )}
              {(mode === "forgot-password" || mode === "reset-password") && (
                <button
                  onClick={() => {
                    setMode("login");
                    setErrors({});
                  }}
                  className="text-muted-foreground text-sm hover:text-foreground inline-flex items-center gap-1"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to sign in
                </button>
              )}
            </div>
          </div>
        )}

        {/* Trust indicator */}
        <div className="mt-8 text-center text-xs text-muted-foreground">
          AES-256 encrypted &nbsp;·&nbsp; ITA Cap.332 R.E.2023
        </div>
      </div>
    </div>
  );
}
