import { Link, useSearchParams } from "react-router-dom";
import { TERMS_VERSION } from "@/lib/commercial/purchaseTerms";
import { LEGAL_ARCHIVE, type ArchivedPolicies } from "@/legal/archive";

/**
 * The version line under a policy heading, and the archived view a ?v=<version> link asks for. The current version renders the
 * live page (it IS that version); an archived version renders its archived text verbatim; an unknown version says so and offers the
 * current text. Nothing here is legal wording of its own.
 */
export function usePolicyVersion(): { requested: string | null; archived: ArchivedPolicies | null; unknown: boolean } {
  const [params] = useSearchParams();
  const requested = params.get("v");
  if (!requested || requested === TERMS_VERSION) return { requested, archived: null, unknown: false };
  const entry = LEGAL_ARCHIVE[requested];
  const archived = entry && entry.status === "published" ? entry : null; // a draft version is never served by link
  return { requested, archived, unknown: archived === null };
}

export function PolicyVersionLine({ page }: { page: "terms" | "privacy" }) {
  return (
    <p className="text-sm text-muted-foreground mb-10" data-testid={`${page}-version`}>
      Version {TERMS_VERSION} · <Link to={`/${page}?v=${TERMS_VERSION}`} className="underline hover:text-foreground">permanent link to this version</Link>
    </p>
  );
}

export function ArchivedPolicy({ page, requested, text, unknown }: { page: "terms" | "privacy"; requested: string; text: string | null; unknown: boolean }) {
  const title = page === "terms" ? "Terms of Service" : "Privacy Policy";
  return (
    <main className="max-w-3xl mx-auto px-6 pt-32 pb-20">
      <h1 className="text-3xl font-bold text-foreground mb-2">{title}</h1>
      {unknown ? (
        <p className="text-sm text-muted-foreground mb-10" role="status" data-testid={`${page}-version-unknown`}>
          There is no published version "{requested}". <Link to={`/${page}`} className="underline hover:text-foreground">Read the current version ({TERMS_VERSION})</Link>.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground mb-6" data-testid={`${page}-version`}>
            Archived version {requested}, shown as it was published. <Link to={`/${page}`} className="underline hover:text-foreground">Read the current version ({TERMS_VERSION})</Link>.
          </p>
          <pre className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground" data-testid={`${page}-archived-text`}>{text}</pre>
        </>
      )}
    </main>
  );
}
