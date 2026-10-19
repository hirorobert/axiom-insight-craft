/** CFOClose's public LinkedIn page, in LinkedIn's brand blue (token --linkedin). */
export const LINKEDIN_URL = "https://www.linkedin.com/company/106631843/";

function LinkedInMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" />
    </svg>
  );
}

export function LinkedInLink({ variant, className = "" }: { variant: "icon" | "button"; className?: string }) {
  const common = {
    href: LINKEDIN_URL,
    target: "_blank",
    rel: "noopener noreferrer",
    "aria-label": "Follow CFOClose on LinkedIn (opens in a new tab)",
  } as const;
  if (variant === "icon") {
    return (
      <a {...common} title="CFOClose on LinkedIn"
        className={`inline-flex h-8 w-8 items-center justify-center text-linkedin transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}>
        <LinkedInMark className="h-6 w-6" />
      </a>
    );
  }
  return (
    <a {...common}
      className={`inline-flex items-center gap-2 rounded-sm bg-linkedin px-4 py-2 text-sm font-medium text-linkedin-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${className}`}>
      <LinkedInMark className="h-4 w-4" />
      Follow us on LinkedIn
    </a>
  );
}
