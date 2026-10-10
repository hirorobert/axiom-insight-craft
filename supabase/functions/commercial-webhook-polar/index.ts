/**
 * commercial-webhook-polar — Polar (merchant of record, cards) delivery endpoint.
 * Standard Webhooks signature with POLAR_WEBHOOK_SECRET; the delivery only names a checkout, and the payment is read
 * back from Polar before anything is committed. See _shared/payments/webhookEndpoint.ts.
 * Deployed with verify_jwt = false (supabase/config.toml): the provider signature is the credential.
 */
import { handleProviderWebhook } from '../_shared/payments/webhookEndpoint.ts';

Deno.serve((req: Request) => handleProviderWebhook(req, 'POLAR'));
