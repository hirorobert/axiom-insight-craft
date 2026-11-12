/** An intake refusal. Always says which file, which line (1-based, the record's first physical line) and which column (1-based, 0 = whole line). */
export class IntakeError extends Error {
  constructor(message: string, readonly file: string, readonly line: number, readonly column = 0) {
    super(`${file}:${line}${column ? `:${column}` : ""}: ${message}`);
    this.name = "IntakeError";
  }
}
