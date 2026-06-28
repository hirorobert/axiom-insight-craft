import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle2, ArrowRight, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";

export function LeadCapture() {
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    
    if (!email || !company) {
      toast({
        title: "Please fill in required fields",
        description: "Email and company name are required.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    
    // Simulate API call - replace with actual Supabase integration
    await new Promise((resolve) => setTimeout(resolve, 1500));
    
    setIsSubmitting(false);
    setSubmitted(true);
    
    toast({
      title: "Demo request received!",
      description: "Our team will reach out within 24 hours.",
    });
  }

  if (submitted) {
    return (
      <section id="demo" className="py-24 px-6">
        <div className="max-w-xl mx-auto text-center">
          <div className="w-16 h-16 rounded-full bg-accent/20 flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 size={32} className="text-accent" />
          </div>
          <h2 className="text-3xl font-bold mb-4">Thank You!</h2>
          <p className="text-lg text-muted-foreground">
            Your demo request has been received. Our Enterprise Success team will 
            contact you within 24 hours to schedule your private demonstration.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section id="demo" className="py-24 px-6 relative">
      {/* Background */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-card to-transparent pointer-events-none" />

      <div className="relative max-w-4xl mx-auto">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          {/* Left side - Copy */}
          <div>
            <h2 className="text-3xl sm:text-4xl font-bold mb-4">
              Request Your Private Demo
            </h2>
            <p className="text-lg text-muted-foreground mb-6">
              See how Axiom can transform your firm's compliance workflow and 
              unlock strategic insights from your financial data.
            </p>
            <ul className="space-y-4">
              {[
                "30-minute personalized walkthrough",
                "Live demonstration with sample data",
                "Custom ROI analysis for your firm",
                "No commitment required",
              ].map((item) => (
                <li key={item} className="flex items-center gap-3 text-muted-foreground">
                  <CheckCircle2 size={18} className="text-accent flex-shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {/* Right side - Form */}
          <div className="p-8 rounded-2xl bg-card border border-border">
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-foreground mb-2">
                  Work Email *
                </label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div>
                <label htmlFor="company" className="block text-sm font-medium text-foreground mb-2">
                  Company Name *
                </label>
                <Input
                  id="company"
                  type="text"
                  placeholder="Your Firm Name"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  required
                />
              </div>

              <div>
                <label htmlFor="role" className="block text-sm font-medium text-foreground mb-2">
                  Your Role
                </label>
                <Input
                  id="role"
                  type="text"
                  placeholder="e.g., Partner, CFO, Controller"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                />
              </div>

              <Button
                type="submit"
                variant="hero"
                size="lg"
                className="w-full"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    Request Demo
                    <ArrowRight size={18} />
                  </>
                )}
              </Button>

              <p className="text-xs text-muted-foreground text-center">
                By submitting, you agree to our{" "}
                <a href="#" className="underline hover:text-foreground">
                  Privacy Policy
                </a>
                .
              </p>
            </form>
          </div>
        </div>
      </div>
    </section>
  );
}
