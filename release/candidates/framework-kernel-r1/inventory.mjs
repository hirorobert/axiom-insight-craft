// Read-only, reproducible inventory of the current contract boundaries. No database access or mutations.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const probes = [
  ['src/lib/statements/composition.ts', /family: z.literal|packId: z.enum/],
  ['src/lib/notes/notesStatus.ts', /packId: z.enum/],
  ['src/lib/reporting/serverCompilation.ts', /FRAMEWORK_EDITION_UNSUPPORTED|PUBLICATION_PATH_UNSUPPORTED/],
  ['src/lib/financialGeneration/composedReport.ts', /FRAMEWORK_PROFILES.IFRS_FOR_SMES|kind: "IFRS_FOR_SMES"/],
  ['supabase/migrations/20261018100000_fs_statement_composition.sql', /CHECK \(pack_family|framework_not_ifrs_for_smes/],
  ['supabase/migrations/20261123100000_fs_server_compilation.sql', /compiler_sha256 =|packId.*ifrs-for-smes/],
  ['scripts/buildStatementCompiler.mjs', /20261123100000|migration.includes/],
];
const result = { schema: 'framework-kernel-boundary-inventory/1', evidence: 'SOURCE_ONLY', files: probes.map(([file, re]) => {
  const bytes = fs.readFileSync(path.join(root, file));
  const matches = bytes.toString('utf8').split('\n').flatMap((text, i) => re.test(text) ? [{ line: i + 1, text: text.trim() }] : []);
  if (!matches.length) throw new Error(`Boundary moved; review required: ${file}`);
  return { file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), matches };
}) };
const rendered = JSON.stringify(result, null, 2) + '\n';
const target = path.join(root, 'release/candidates/framework-kernel-r1/boundary-inventory.json');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== rendered) throw new Error('Boundary inventory drift: re-assess and regenerate');
  console.log('FRAMEWORK_KERNEL_BOUNDARIES: OK (source evidence only)');
} else process.stdout.write(rendered);
