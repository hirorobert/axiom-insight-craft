import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  FileText,
  Sparkles,
  Loader2,
  CheckCircle,
  AlertCircle,
  BookOpen,
  Download,
} from "lucide-react";
import jsPDF from "jspdf";

interface DisclosureNote {
  id: string;
  title: string;
  category: string;
  content: string;
  relevance: "high" | "medium" | "low";
  accountsReferenced?: string[];
}

interface NoteSynthProps {
  uploadId: string;
  existingNotes?: {
    notes: DisclosureNote[];
    metadata: {
      generatedAt: string;
      totalNotes: number;
      framework: string;
    };
  } | null;
  onNotesGenerated?: () => void;
}

export function NoteSynth({ uploadId, existingNotes, onNotesGenerated }: NoteSynthProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [notes, setNotes] = useState<DisclosureNote[]>(existingNotes?.notes || []);
  const [metadata, setMetadata] = useState(existingNotes?.metadata || null);

  const generateNotes = async () => {
    setIsGenerating(true);
    toast.info("NoteSynth is generating disclosure notes...");

    try {
      const { data, error } = await supabase.functions.invoke("generate-disclosure-notes", {
        body: { uploadId },
      });

      if (error) throw error;

      if (data.error) {
        throw new Error(data.error);
      }

      setNotes(data.notes);
      setMetadata(data.metadata);
      toast.success(`Generated ${data.notes.length} disclosure notes!`);
      onNotesGenerated?.();
    } catch (error) {
      console.error("Error generating notes:", error);
      const message = error instanceof Error ? error.message : "Failed to generate notes";
      toast.error(message);
    } finally {
      setIsGenerating(false);
    }
  };

  const getRelevanceBadge = (relevance: string) => {
    switch (relevance) {
      case "high":
        return <Badge className="bg-destructive/20 text-destructive border-destructive/30">High Priority</Badge>;
      case "medium":
        return <Badge className="bg-primary/20 text-primary border-primary/30">Standard</Badge>;
      case "low":
        return <Badge variant="secondary">Supplementary</Badge>;
      default:
        return null;
    }
  };

  const exportNotesToPDF = () => {
    if (notes.length === 0) return;

    const doc = new jsPDF();
    let yPosition = 20;

    // Title
    doc.setFontSize(18);
    doc.setTextColor(40);
    doc.text("Financial Disclosure Notes", 14, yPosition);
    yPosition += 10;

    // Metadata
    doc.setFontSize(10);
    doc.setTextColor(100);
    if (metadata) {
      doc.text(`Framework: ${metadata.framework}`, 14, yPosition);
      yPosition += 5;
      doc.text(`Generated: ${new Date(metadata.generatedAt).toLocaleDateString()}`, 14, yPosition);
      yPosition += 5;
      doc.text(`Total Notes: ${metadata.totalNotes}`, 14, yPosition);
      yPosition += 15;
    }

    // Notes
    notes.forEach((note, index) => {
      // Check if we need a new page
      if (yPosition > 250) {
        doc.addPage();
        yPosition = 20;
      }

      // Note title
      doc.setFontSize(12);
      doc.setTextColor(40);
      doc.setFont("helvetica", "bold");
      doc.text(`${index + 1}. ${note.title}`, 14, yPosition);
      yPosition += 6;

      // Category and relevance
      doc.setFontSize(9);
      doc.setTextColor(100);
      doc.setFont("helvetica", "normal");
      doc.text(`Category: ${note.category} | Priority: ${note.relevance}`, 14, yPosition);
      yPosition += 8;

      // Content - wrap text
      doc.setFontSize(10);
      doc.setTextColor(60);
      const lines = doc.splitTextToSize(note.content, 180);
      lines.forEach((line: string) => {
        if (yPosition > 280) {
          doc.addPage();
          yPosition = 20;
        }
        doc.text(line, 14, yPosition);
        yPosition += 5;
      });

      yPosition += 10;
    });

    doc.save("disclosure-notes.pdf");
    toast.success("Notes exported to PDF");
  };

  if (notes.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            NoteSynth - Disclosure Notes
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-primary/10 flex items-center justify-center">
              <BookOpen className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">
              Generate Audit-Ready Disclosure Notes
            </h3>
            <p className="text-muted-foreground text-sm mb-6 max-w-md mx-auto">
              NoteSynth uses AI to generate GAAP/IFRS-compliant disclosure notes based on your mapped financial statements.
            </p>
            <Button
              variant="hero"
              onClick={generateNotes}
              disabled={isGenerating}
              className="gap-2"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating Notes...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Generate Disclosure Notes
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-lg flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            NoteSynth - Disclosure Notes
          </CardTitle>
          {metadata && (
            <p className="text-sm text-muted-foreground mt-1">
              {metadata.framework} • {metadata.totalNotes} notes • Generated{" "}
              {new Date(metadata.generatedAt).toLocaleDateString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportNotesToPDF} className="gap-2">
            <Download className="w-4 h-4" />
            Export PDF
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={generateNotes}
            disabled={isGenerating}
            className="gap-2"
          >
            {isGenerating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            Regenerate
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[400px] pr-4">
          <Accordion type="single" collapsible className="space-y-2">
            {notes.map((note, index) => (
              <AccordionItem
                key={note.id}
                value={note.id}
                className="border border-border rounded-xl px-4 data-[state=open]:bg-secondary/30"
              >
                <AccordionTrigger className="hover:no-underline py-3">
                  <div className="flex items-start gap-3 text-left">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <FileText className="w-4 h-4 text-primary" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-foreground">
                          Note {index + 1}: {note.title}
                        </span>
                        {getRelevanceBadge(note.relevance)}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{note.category}</p>
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="pb-4">
                  <div className="pl-11 space-y-3">
                    <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                      {note.content}
                    </p>
                    {note.accountsReferenced && note.accountsReferenced.length > 0 && (
                      <div className="pt-2 border-t border-border">
                        <p className="text-xs text-muted-foreground mb-1">Referenced Accounts:</p>
                        <div className="flex flex-wrap gap-1">
                          {note.accountsReferenced.map((account, i) => (
                            <Badge key={i} variant="outline" className="text-xs">
                              {account}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </ScrollArea>

        {/* Summary */}
        <div className="mt-4 pt-4 border-t border-border flex items-center justify-between text-sm">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <CheckCircle className="w-4 h-4 text-accent" />
              <span className="text-muted-foreground">
                {notes.filter((n) => n.relevance === "high").length} high priority
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <AlertCircle className="w-4 h-4 text-primary" />
              <span className="text-muted-foreground">
                {notes.filter((n) => n.relevance === "medium").length} standard
              </span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Review all notes before including in final statements
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
