import { useState, useEffect } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Eye, EyeOff, Mail, Lock, User, ArrowRight, ArrowLeft, CheckCircle, MailCheck, AlertTriangle } from "lucide-react";
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
      case "login": return "Sign in to access your financial statements";
      case "signup": return "Start transforming trial balances into insights";
      case "forgot-password": return "Enter your email and we'll send you a reset link";
      case "reset-password": return "Enter your new password below";
      case "verify-email": return "We've sent a verification link to your email";
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-md relative z-10">
        {/* Logo */}
        <div className="text-center mb-8">
          <Link to="/" className="inline-block">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-primary-foreground font-bold text-2xl mb-4">
              AX
            </div>
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

        {/* Trust indicators */}
        <div className="mt-8 flex items-center justify-center gap-6 text-xs text-muted-foreground">
          <span>256-bit encryption</span>
          <span>•</span>
          <span>SOC 2 compliant</span>
          <span>•</span>
          <span>GDPR ready</span>
        </div>
      </div>
    </div>
  );
}
