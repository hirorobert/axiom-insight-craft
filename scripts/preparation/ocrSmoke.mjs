// A real local OCR check. Uses only locked local language/core assets; no network/API or customer data.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createWorker, OEM } from "tesseract.js";
import { scan } from "./syntheticScan.mjs";
const worker = await createWorker("eng", OEM.LSTM_ONLY, {
  langPath: resolve("node_modules/@tesseract.js-data/eng/4.0.0"),
  cacheMethod: "none",
});
try {
  const { data } = await worker.recognize(Buffer.from(scan, "base64"));
  assert.match(data.text, /Equipment carrying amount/i);
  assert.match(data.text, /16,000\.00/);
  console.log(
    "LOCAL_OCR_SMOKE: PASS (synthetic image; exact carrying amount recognized; no accounting confirmation implied)",
  );
} finally {
  await worker.terminate();
}
