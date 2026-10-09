// /contact — the canonical universal contact page. The public header, public footer and help/support entry points all lead
// here (carrying only a validated `?from=` context), and it renders the one shared enquiry form. Email is the only contact
// channel: there is no phone field and no "preferred contact method".
//
// Commercial requests use the same form, preselected by a validated `?service=` (src/lib/commercial/offerings.ts):
//   plan_activation (+ ?plan=)  a manually activated subscription; nothing is purchased or activated by sending it
//   a specialist service        work delivered by people and quoted separately; not an automated feature
// Anything unrecognised is the general form — never a guessed service or plan.

import { useSearchParams } from "react-router-dom";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ServiceEnquiryForm } from "@/components/enquiry/ServiceEnquiryForm";
import { sourceFromSearch } from "@/lib/serviceEnquiry/entryPoints";
import { ENQUIRY_FORM_COPY } from "@/lib/serviceEnquiry/copy";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";
import { contactIntentFromSearch, MANUAL_ACTIVATION_NOTE, SPECIALIST_LABEL, REQUEST_ACTIVATION_LABEL } from "@/lib/commercial/offerings";
import { PRICING_CATALOGUE } from "@/lib/commercial/pricingCatalogue";
import NotFound from "@/pages/NotFound";

const GENERAL_CHOICES = [
  { code: "general", label: "A general question" },
  { code: "support", label: "Help using CFOClose" },
] as const;

const PLAN_CHOICES = PRICING_CATALOGUE.map((p) => ({ value: p.code, label: p.name }));

/** Behind the `service_enquiry_phase1` gate: even if mounted directly, an OFF gate shows the standard not-found page, never the form. */
export default function Contact() {
  return SERVICE_ENQUIRY_SURFACES.contactRoute ? <ContactPage /> : <NotFound />;
}

function ContactPage() {
  const [params] = useSearchParams();
  const intent = contactIntentFromSearch(params);

  let heading: string = ENQUIRY_FORM_COPY.generalHeading;
  let intro: string = ENQUIRY_FORM_COPY.generalIntro;
  let form: JSX.Element;
  if (intent.kind === "activation") {
    heading = REQUEST_ACTIVATION_LABEL;
    intro = `${MANUAL_ACTIVATION_NOTE} Tell us which plan you need; we reply to agree terms before anything is activated.`;
    form = (
      <ServiceEnquiryForm formKey="activation" variant="activation" serviceCode="plan_activation" sourceContext={intent.source ?? "contact_page"}
        planChoices={PLAN_CHOICES} initialPayload={intent.plan ? { plan_code: intent.plan } : {}} submitLabel="Send activation request"
        defaultSubject={intent.plan ? `Activation request: ${PRICING_CATALOGUE.find((p) => p.code === intent.plan)?.name ?? intent.plan}` : "Activation request"} />
    );
  } else if (intent.kind === "specialist") {
    heading = intent.service.name;
    intro = `${intent.service.description} ${SPECIALIST_LABEL}`;
    form = (
      <ServiceEnquiryForm formKey={`specialist-${intent.service.code}`} variant="specialist" serviceCode={intent.service.code} sourceContext={intent.source ?? "contact_page"}
        defaultSubject={`${intent.service.name} enquiry`} submitLabel="Request a quote"
        contextSummary={<p className="text-xs text-muted-foreground" data-testid="specialist-label">{SPECIALIST_LABEL}</p>} />
    );
  } else {
    form = <ServiceEnquiryForm formKey="contact" variant="general" serviceCode="general" sourceContext={sourceFromSearch(params.get("from"))} serviceChoices={GENERAL_CHOICES} />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main id="main" className="mx-auto w-full max-w-2xl flex-1 px-4 pb-20 pt-28 sm:px-6 sm:pt-32">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">{heading}</h1>
        <p className="mb-8 mt-3 text-sm leading-relaxed text-muted-foreground" data-testid="contact-intro">{intro}</p>
        {form}
      </main>
      <Footer />
    </div>
  );
}
