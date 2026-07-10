export interface GenerateTaxComputationPDFArgs {
  computation?: unknown;
  company?: unknown;
  allowances?: unknown[];
  findings?: unknown[];
  [key: string]: unknown;
}

export function generateTaxComputationPDF(_args: GenerateTaxComputationPDFArgs): void {
  console.warn("generateTaxComputationPDF is not implemented in this build.");
}

export default generateTaxComputationPDF;