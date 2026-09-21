import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import { Button } from "@/components/ui/button";
import { Menu, X, LogOut, Settings, LayoutDashboard, LifeBuoy } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { NotificationBell } from "@/components/NotificationBell";
import { NAV, CTA } from "@/constants/copy";
import { contactHref } from "@/lib/serviceEnquiry/entryPoints";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";

export function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isLanding = location.pathname === "/";

  const handleSignOut = async () => {
    await signOut();
    toast.success("Signed out successfully");
    navigate("/");
  };

  const getUserInitials = () => {
    if (!user?.email) return "U";
    return user.email.substring(0, 2).toUpperCase();
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-border/60 bg-background/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3.5 lg:px-10">

        {/* ── Wordmark ──────────────────────────────────────────────── */}
        <Link to="/" aria-label="CFOClose home" className="inline-flex items-center">
          <CFOCloseWordmark className="text-xl md:text-2xl" />
        </Link>

        {/* ── Desktop nav ───────────────────────────────────────────── */}
        <nav className="hidden lg:flex items-center gap-8">
          {isLanding && NAV.map((item) =>
            item.href.startsWith("/") ? (
              <Link
                key={item.href}
                to={item.href}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {item.label}
              </Link>
            ) : (
              <a
                key={item.href}
                href={item.href}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {item.label}
              </a>
            )
          )}
          {SERVICE_ENQUIRY_SURFACES.headerContactLink && (
            <Link
              to={contactHref("site_header")}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Contact
            </Link>
          )}
          {user && (
            <Link
              to="/dashboard"
              className="flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:text-primary/80"
            >
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </Link>
          )}
        </nav>

        {/* ── Desktop right actions ─────────────────────────────────── */}
        <div className="hidden lg:flex items-center gap-3">
          {user ? (
            <>
              <NotificationBell userId={user?.id} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="relative h-9 w-9 rounded-full p-0">
                    <Avatar className="h-9 w-9 border-2 border-primary/20 transition-colors hover:border-primary/50">
                      <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">
                        {getUserInitials()}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56" align="end" forceMount>
                  <div className="px-2 py-2">
                    <p className="truncate text-sm font-medium">{user.email}</p>
                  </div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/dashboard" className="cursor-pointer">
                      <LayoutDashboard className="mr-2 h-4 w-4" />
                      Dashboard
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/settings" className="cursor-pointer">
                      <Settings className="mr-2 h-4 w-4" />
                      Settings
                    </Link>
                  </DropdownMenuItem>
                  {SERVICE_ENQUIRY_SURFACES.helpSupportLinks && (
                    <DropdownMenuItem asChild>
                      <Link to={contactHref("help_support")} className="cursor-pointer">
                        <LifeBuoy className="mr-2 h-4 w-4" />
                        Help &amp; support
                      </Link>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={handleSignOut}
                    className="cursor-pointer text-destructive focus:text-destructive"
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    Sign Out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="sm" asChild>
                <Link to="/auth">Sign in</Link>
              </Button>
              <Button variant="hero" size="sm" asChild className="px-5">
                <Link to={CTA.primaryHref}>{CTA.primary}</Link>
              </Button>
            </div>
          )}
        </div>

        {/* ── Mobile toggle ─────────────────────────────────────────── */}
        <button
          className="lg:hidden p-2 text-foreground"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
        >
          {mobileOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>

      {/* Mobile Menu */}
      {mobileOpen && (
        <div className="lg:hidden bg-card border-t border-border px-6 py-4">
          <div className="space-y-1">
            {isLanding && NAV.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className="block py-2.5 text-sm text-muted-foreground hover:text-foreground"
              >
                {item.label}
              </a>
            ))}
            {SERVICE_ENQUIRY_SURFACES.headerContactLink && (
              <Link
                to={contactHref("site_header")}
                onClick={() => setMobileOpen(false)}
                className="block py-2.5 text-sm text-muted-foreground hover:text-foreground"
              >
                Contact
              </Link>
            )}
            {user && (
              <Link
                to="/dashboard"
                onClick={() => setMobileOpen(false)}
                className="flex items-center gap-2 py-2.5 text-sm font-medium text-primary"
              >
                <LayoutDashboard className="h-4 w-4" />
                Dashboard
              </Link>
            )}
          </div>
          <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
            {user ? (
              <>
                <p className="truncate px-1 text-sm text-muted-foreground">{user.email}</p>
                <Button variant="ghost" size="sm" className="justify-start gap-2" asChild>
                  <Link to="/settings" onClick={() => setMobileOpen(false)}>
                    <Settings className="h-4 w-4" />Settings
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleSignOut}
                  className="justify-start gap-2 text-destructive hover:text-destructive"
                >
                  <LogOut className="h-4 w-4" />Sign Out
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="lg" className="w-full" asChild>
                  <Link to="/auth" onClick={() => setMobileOpen(false)}>Sign in</Link>
                </Button>
                <Button variant="hero" size="lg" className="w-full" asChild>
                  <a href="/#outcomes" onClick={() => setMobileOpen(false)}>
                    Choose outcome
                  </a>
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
