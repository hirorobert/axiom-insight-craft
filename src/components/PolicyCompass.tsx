import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Compass, Search, Loader2, ChevronRight, BookOpen, AlertTriangle, CheckCircle2, Scale } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAuditLog } from "@/hooks/useAuditLog";

interface DecisionTreeStep {
  step: number;
  question: string;
  options: { label: string; leads_to: number; description: string }[];
}

interface Evidence {
  rank: number;
  source: string;
  authority: string;
  relevance: "high" | "medium" | "low";
  summary: string;
}

interface PolicyGuidance {
  decision: {
    title: string;
    summary: string;
    confidence: "high" | "medium" | "low";
  };
  decisionTree: DecisionTreeStep[];
  evidence: Evidence[];
  implementation: string[];
  pitfalls: string[];
}

interface PolicyCompassProps {
  financialData?: {
    accounts?: Array<{ name: string; balance: number; category: string }>;
    totals?: { assets: number; liabilities: number; equity: number };
  };
}

// Tanzania-specific questions — ITA Cap.332, SDL, PAYE, IPSAS, IFRS for SMEs
const COMMON_QUESTIONS = [
  "What SDL rate applies to our payroll and who is exempt under Finance Act 2026?",
  "Which ITA wear & tear class applies to medical equipment and computers?",
  "How do I treat a Directors Loan received by a private company on the balance sheet?",
  "When does the 1% single instalment tax on forest produce apply under ITA s.116A?",
  "How should loan facility fees and appraisal fees be accounted for under IFRS for SMEs?",
];

export function PolicyCompass({ financialData }: PolicyCompassProps) {
  const [question, setQuestion] = useState("");
  const [context, setContext] = useState("");
  const [loading, setLoading] = useState(false);
  const [guidance, setGuidance] = useState<PolicyGuidance | null>(null);
  const [activeStep, setActiveStep] = useState<number>(1);
  const { logAction } = useAuditLog();

  const handleSubmit = async (questionText?: string) => {
    const queryQuestion = questionText || question;
    if (!queryQuestion.trim()) {
      toast.error("Please enter a question");
      return;
    }

    setLoading(true);
    setGuidance(null);

    try {
      const { data, error } = await supabase.functions.invoke("policy-compass", {
        body: { 
          question: queryQuestion, 
          context: context.trim() || undefined,
          financialData: financialData || undefined
        },
      });

      if (error) throw error;

      if (data.error) {
        throw new Error(data.error);
      }

      setGuidance(data.guidance);
      setActiveStep(1);
      toast.success("Policy guidance generated");
      logAction({
        action: "policy_compass_query",
        metadata: { question: queryQuestion, confidence: data.guidance?.decision?.confidence },
      });
    } catch (error) {
      console.error("Policy Compass error:", error);
      toast.error(error instanceof Error ? error.message : "Failed to generate guidance");
    } finally {
      setLoading(false);
    }
  };

  const getConfidenceBadge = (confidence: string) => {
    const variants: Record<string, { variant: "default" | "secondary" | "destructive"; icon: typeof CheckCircle2 }> = {
      high: { variant: "default", icon: CheckCircle2 },
      medium: { variant: "secondary", icon: Scale },
      low: { variant: "destructive", icon: AlertTriangle },
    };
    const config = variants[confidence] || variants.medium;
    const Icon = config.icon;
    return (
      <Badge variant={config.variant} className="gap-1">
        <Icon className="w-3 h-3" />
        {confidence.charAt(0).toUpperCase() + confidence.slice(1)} Confidence
      </Badge>
    );
  };

  const getRelevanceBadge = (relevance: string) => {
    const colors: Record<string, string> = {
      high: "bg-green-500/10 text-green-600 border-green-500/20",
      medium: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
      low: "bg-muted text-muted-foreground border-border",
    };
    return (
      <span className={`text-xs px-2 py-0.5 rounded-full border ${colors[relevance] || colors.medium}`}>
        {relevance}
      </span>
    );
  };

  return (
    <Card className="border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Compass className="w-5 h-5 text-primary" />
          Policy Compass
        </CardTitle>
        <CardDescription>
          Tanzania statutory guidance — ITA Cap.332, SDL, PAYE, IFRS for SMEs, IPSAS
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Question Input */}
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Your Question</label>
            <div className="flex gap-2">
              <Input
                placeholder="e.g., Which wear & tear class applies to our X-ray machine?"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                className="flex-1"
              />
              <Button onClick={() => handleSubmit()} disabled={loading}>
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Additional Context (Optional)</label>
            <Textarea
              placeholder="Provide any relevant details about your specific situation..."
              value={context}
              onChange={(e) => setContext(e.target.value)}
              rows={2}
              className="resize-none"
            />
          </div>

          {/* Quick Questions */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Tanzania-Specific Questions</label>
            <div className="flex flex-wrap gap-2">
              {COMMON_QUESTIONS.map((q, i) => (
                <Button
                  key={i}
                  variant="outline"
                  size="sm"
                  className="text-xs h-7"
                  onClick={() => {
                    setQuestion(q);
                    handleSubmit(q);
                  }}
                  disabled={loading}
                >
                  {q.length > 40 ? q.substring(0, 40) + "..." : q}
                </Button>
              ))}
            </div>
          </div>
        </div>

        {/* Results */}
        {guidance && (
          <div className="space-y-6 pt-4 border-t border-border">
            {/* Decision Summary */}
            <div className="bg-primary/5 rounded-lg p-4 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <h3 className="font-semibold text-foreground">{guidance.decision.title}</h3>
                {getConfidenceBadge(guidance.decision.confidence)}
              </div>
              <p className="text-sm text-muted-foreground">{guidance.decision.summary}</p>
            </div>

            <Accordion type="multiple" defaultValue={["decision-tree", "evidence"]} className="space-y-2">
              {/* Decision Tree */}
              {guidance.decisionTree.length > 0 && (
                <AccordionItem value="decision-tree" className="border border-border rounded-lg px-4">
                  <AccordionTrigger className="text-sm font-medium">
                    <span className="flex items-center gap-2">
                      <ChevronRight className="w-4 h-4" />
                      Decision Tree
                    </span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-4 py-2">
                      {guidance.decisionTree.map((step) => (
                        <div
                          key={step.step}
                          className={`p-3 rounded-lg border transition-colors ${
                            activeStep === step.step
                              ? "border-primary bg-primary/5"
                              : "border-border bg-card"
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-medium">
                              {step.step}
                            </span>
                            <span className="text-sm font-medium">{step.question}</span>
                          </div>
                          <div className="grid gap-2 ml-8">
                            {step.options.map((option, i) => (
                              <button
                                key={i}
                                onClick={() => setActiveStep(option.leads_to)}
                                className="text-left p-2 rounded border border-border hover:border-primary/50 hover:bg-primary/5 transition-colors"
                              >
                                <span className="text-sm font-medium text-foreground">{option.label}</span>
                                <p className="text-xs text-muted-foreground">{option.description}</p>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* Evidence */}
              {guidance.evidence.length > 0 && (
                <AccordionItem value="evidence" className="border border-border rounded-lg px-4">
                  <AccordionTrigger className="text-sm font-medium">
                    <span className="flex items-center gap-2">
                      <BookOpen className="w-4 h-4" />
                      Ranked Evidence ({guidance.evidence.length})
                    </span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-3 py-2">
                      {guidance.evidence.map((item) => (
                        <div key={item.rank} className="flex gap-3 p-3 rounded-lg border border-border bg-card">
                          <span className="w-6 h-6 rounded-full bg-accent text-accent-foreground text-xs flex items-center justify-center font-bold shrink-0">
                            {item.rank}
                          </span>
                          <div className="space-y-1 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-sm font-medium text-primary">{item.source}</span>
                              <Badge variant="outline" className="text-xs">{item.authority}</Badge>
                              {getRelevanceBadge(item.relevance)}
                            </div>
                            <p className="text-sm text-muted-foreground">{item.summary}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* Implementation */}
              {guidance.implementation.length > 0 && (
                <AccordionItem value="implementation" className="border border-border rounded-lg px-4">
                  <AccordionTrigger className="text-sm font-medium">
                    <span className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4" />
                      Implementation Steps
                    </span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <ol className="list-decimal list-inside space-y-2 py-2">
                      {guidance.implementation.map((step, i) => (
                        <li key={i} className="text-sm text-muted-foreground">
                          {step}
                        </li>
                      ))}
                    </ol>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* Pitfalls */}
              {guidance.pitfalls.length > 0 && (
                <AccordionItem value="pitfalls" className="border border-border rounded-lg px-4">
                  <AccordionTrigger className="text-sm font-medium">
                    <span className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4" />
                      Common Pitfalls
                    </span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <ul className="space-y-2 py-2">
                      {guidance.pitfalls.map((pitfall, i) => (
                        <li key={i} className="flex gap-2 text-sm">
                          <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                          <span className="text-muted-foreground">{pitfall}</span>
                        </li>
                      ))}
                    </ul>
                  </AccordionContent>
                </AccordionItem>
              )}
            </Accordion>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
