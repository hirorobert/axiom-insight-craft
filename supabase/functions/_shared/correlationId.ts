/** Generate a short correlation ID for structured logging. Never log secrets. */
export function generateCorrelationId(): string {
  return `saff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
