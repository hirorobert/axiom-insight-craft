// /contact — the canonical universal contact page. The public header, public footer and help/support entry points all lead
// here (carrying only a validated `?from=` context), and it renders the one shared enquiry form. Email is the only contact
// channel: there is no phone field and no "preferred contact method".

import { useSearchParams } from "react-router-dom";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ServiceEnquiryForm } from "@/components/enquiry/ServiceEnquiryForm";
import { sourceFromSearch } from "@/lib/serviceEnquiry/entryPoints";
import { ENQUIRY_FORM_COPY } from "@/lib/serviceEnquiry/copy";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";
import NotFound from "@/pages/NotFound";

const GENERAL_CHOICES = [
  { code: "general", label: "A general question" },
  { code: "support", label: "Help using CFOClose" },
] as const;

/** Behind the `service_enquiry_phase1` gate: even if mounted directly, an OFF gate shows the standard not-found page, never the form. */
export default function Contact() {
  return SERVICE_ENQUIRY_SURFACES.contactRoute ? <ContactPage /> : <NotFound />;
}

function ContactPage() {
  const [params] = useSearchParams();
  const sourceContext = sourceFromSearch(params.get("from"));

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main id="main" className="mx-auto w-full max-w-2xl flex-1 px-4 pb-20 pt-28 sm:px-6 sm:pt-32">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">{ENQUIRY_FORM_COPY.generalHeading}</h1>
        <p className="mb-8 mt-3 text-sm leading-relaxed text-muted-foreground">{ENQUIRY_FORM_COPY.generalIntro}</p>
        <ServiceEnquiryForm formKey="contact" variant="general" serviceCode="general" sourceContext={sourceContext} serviceChoices={GENERAL_CHOICES} />
      </main>
      <Footer />
    </div>
  );
}
