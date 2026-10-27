import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
const DIST = process.argv[2] ?? "dist";
const pairs = [
  ["node_modules/tesseract.js/dist/worker.min.js", `${DIST}/ocr/worker.min.js`],
  [
    "node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz",
    `${DIST}/ocr/lang/eng.traineddata.gz`,
  ],
];
for (const name of ["tesseract-core-lstm", "tesseract-core-simd-lstm"]) {
  for (const extension of ["wasm.js", "wasm"])
    pairs.push([
      `node_modules/tesseract.js-core/${name}.${extension}`,
      `${DIST}/ocr/core/${name}.${extension}`,
    ]);
}
for (const folder of ["wasm", "standard_fonts", "cmaps"]) {
  for (const name of readdirSync(`node_modules/pdfjs-dist/${folder}`))
    pairs.push([
      `node_modules/pdfjs-dist/${folder}/${name}`,
      `${DIST}/ocr/pdf/${folder}/${name}`,
    ]);
}
const digest = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
for (const [source, built] of pairs)
  assert.equal(digest(built), digest(source), `OCR asset differs: ${built}`);
assert.match(readFileSync(`${DIST}/ocr/NOTICE.txt`, "utf8"), /Apache|MIT/);
console.log(
  `LOCAL_OCR_ASSETS: PASS (${pairs.length} exact-byte assets and notices)`,
);
