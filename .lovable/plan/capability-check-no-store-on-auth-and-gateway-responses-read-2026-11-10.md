# Capability check: no-store on Auth and gateway responses (read-only, no action)

| Capability | Finding | Evidence |
|---|---|---|
| Native Cache-Control on Auth token/sign-in responses | Unsupported. No documented setting exists. | Lovable Cloud docs (docs.lovable.dev/features/cloud) list no header controls for the backend. The configure_auth tool covers signup, confirmation, password and email rate-limit settings only. |
| Native Cache-Control on gateway errors that occur before a handler runs | Unsupported. No documented setting exists. | Same docs. The PostgREST pre-request hook runs only after the request reaches PostgREST, so it cannot change gateway or Auth responses. |
| Restricting the public *.supabase.co origin so only a Cloudflare gateway can reach it | Unsupported or unverified. No documented control exists. | Lovable docs mention IP allowlisting only for outbound connector traffic (docs.lovable.dev/integrations/security). Database and pooler restrictions don't count, per your question. No backend custom-domain or origin-lock control is documented for Cloud. |
| Separate Lovable project for staging ref hplriydtdelehepgttul | Not found. | A cross-project search for that ref and for "staging" returned no accessible project. |

## Conclusion
Within this project, Lovable Cloud gives no supported way to add no-store to managed Auth responses or to gateway errors that happen before a handler runs. It also cannot lock the default origin behind Cloudflare. The only controls left would need Lovable platform staff, or an external Supabase project that you own. Both are outside this project and unverified.

No edits, deployments, SQL or settings changes are planned.
