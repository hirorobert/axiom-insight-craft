import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";

export function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border/50">
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-primary-foreground font-bold text-sm shadow-lg">
              AX
            </div>
            <div className="hidden sm:block">
              <h1 className="text-base font-semibold text-foreground">Axiom</h1>
              <p className="text-xs text-muted-foreground">Autonomous Financial Intelligence</p>
            </div>
          </Link>
        </div>

        {/* Desktop Nav */}
        <nav className="hidden md:flex items-center gap-8">
          <a href="#features" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            Features
          </a>
          <a href="#pricing" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            Pricing
          </a>
          <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            Dashboard
          </Link>
          <a href="#contact" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            Contact
          </a>
        </nav>

        <div className="hidden md:flex items-center gap-3">
          <Button variant="ghost" size="sm">
            Sign In
          </Button>
          <Button variant="hero" size="sm" asChild>
            <a href="#demo">Book Demo</a>
          </Button>
        </div>

        {/* Mobile Toggle */}
        <button
          className="md:hidden p-2 text-foreground"
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          {mobileOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {/* Mobile Menu */}
      {mobileOpen && (
        <div className="md:hidden bg-card border-t border-border px-6 py-4 space-y-4 animate-fade-in">
          <a href="#features" className="block text-sm text-muted-foreground hover:text-foreground">
            Features
          </a>
          <a href="#pricing" className="block text-sm text-muted-foreground hover:text-foreground">
            Pricing
          </a>
          <Link to="/dashboard" className="block text-sm text-muted-foreground hover:text-foreground">
            Dashboard
          </Link>
          <a href="#contact" className="block text-sm text-muted-foreground hover:text-foreground">
            Contact
          </a>
          <div className="flex flex-col gap-2 pt-4 border-t border-border">
            <Button variant="ghost" size="sm" className="justify-start">
              Sign In
            </Button>
            <Button variant="hero" size="sm" asChild>
              <a href="#demo">Book Demo</a>
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
