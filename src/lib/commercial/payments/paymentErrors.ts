/**
 * Ω2 — Typed payment error vocabulary.
 * Never collapse payment failures into generic Error objects — structured
 * errors enable correct UNKNOWN vs FAILED vs CANCELLED UX branching.
 */

export type PaymentErrorCode =
  | 'PLAN_NOT_PURCHASABLE'
  | 'PLAN_NOT_FOUND'
  | 'NO_BILLING_CUSTOMER'
  | 'INVALID_AMOUNT'
  | 'UNSUPPORTED_CURRENCY'
  | 'CHECKOUT_CREATION_FAILED'
  | 'INTENT_EXPIRED'
  | 'INTENT_NOT_FOUND'
  | 'INTENT_ALREADY_RESOLVED'
  | 'WEBHOOK_INVALID_SIGNATURE'
  | 'WEBHOOK_REPLAY'
  | 'PROVIDER_VERIFICATION_FAILED'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'REFERENCE_MISMATCH'
  | 'UNKNOWN_PROVIDER_STATUS'
  | 'COMMIT_FAILED'
  | 'ENTITLEMENT_UNKNOWN'
  | 'PROVIDER_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class PaymentError extends Error {
  constructor(
    public readonly code: PaymentErrorCode,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PaymentError';
  }

  isUserFacing(): boolean {
    return [
      'PLAN_NOT_PURCHASABLE',
      'PLAN_NOT_FOUND',
      'NO_BILLING_CUSTOMER',
      'CHECKOUT_CREATION_FAILED',
      'INTENT_EXPIRED',
    ].includes(this.code);
  }

  toSafeMessage(): string {
    const safeMessages: Partial<Record<PaymentErrorCode, string>> = {
      PLAN_NOT_PURCHASABLE: 'This plan is not currently available for purchase.',
      PLAN_NOT_FOUND: 'The selected plan could not be found.',
      NO_BILLING_CUSTOMER: 'Your billing account could not be found. Please contact support.',
      CHECKOUT_CREATION_FAILED: 'We could not start the payment process. Please try again.',
      INTENT_EXPIRED: 'Your payment session expired. Please start a new payment.',
      PROVIDER_UNAVAILABLE: 'The payment service is temporarily unavailable. Please try again.',
    };
    return safeMessages[this.code] ?? 'An unexpected error occurred. Please contact support.';
  }
}
