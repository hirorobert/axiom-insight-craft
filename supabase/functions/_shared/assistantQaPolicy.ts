/** QA is a separate synthetic-only surface, never an alternate production approval. */
export const QA_COMPANY = "659daa94-116c-4803-99f8-157e0bdd4c62";
export function qaCaseId(value: unknown): number | null {
  return Number.isInteger(value) && typeof value === "number" && value >= 1 && value <= 20 ? value : null;
}
export function qaAccess(companyId: unknown, enrolled: boolean, member: boolean): boolean {
  return companyId === QA_COMPANY && enrolled && member;
}