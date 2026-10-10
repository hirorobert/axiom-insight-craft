/**
 * commercial-webhook-snippe — Snippe (Tanzania mobile money) delivery endpoint.
 * HMAC-SHA256 signature with SNIPPE_WEBHOOK_SECRET over `${X-Webhook-Timestamp}.${raw body}`; the delivery only names a
 * payment reference, and the payment is read back from Snippe before anything is committed.
 * See _shared/payments/webhookEndpoint.ts.
 * Deployed with verify_jwt = false (supabase/config.toml): the provider signature is the credential.
 */
import { handleProviderWebhook } from '../_shared/payments/webhookEndpoint.ts';

Deno.serve((req: Request) => handleProviderWebhook(req, 'SNIPPE'));
