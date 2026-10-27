/** Bounded, on-device PDF reading. Extraction is a proposal; it never confirms a financial fact. */
export const PRIOR_PDF_MAX_BYTES = 20 * 1024 * 1024;
export const PRIOR_PDF_MAX_PAGES = 200;
export const PRIOR_PAGE_MAX_PIXELS = 2_000_000;
export type ReadPage = {
  sha256: string;
  page: number;
  pages: number;
  text: string;
  method: "text" | "ocr";
  preview: Blob;
};
export function checkPriorPdf(size: number, page: number) {
  if (size <= 0 || size > PRIOR_PDF_MAX_BYTES)
    throw new Error("Choose a PDF up to 20 MiB.");
  if (!Number.isInteger(page) || page < 1 || page > PRIOR_PDF_MAX_PAGES)
    throw new Error("Choose a page from 1 to 200.");
}
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new DOMException("Reading cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new DOMException("Reading cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export async function readPriorPage(
  file: File,
  pageNumber: number,
  signal: AbortSignal,
  status: (text: string) => void,
  forceOcr = false,
): Promise<ReadPage> {
  checkPriorPdf(file.size, pageNumber);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
    throw new Error("This file is not a PDF.");
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url"))
    .default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  signal.throwIfAborted();
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const assetRoot = `${window.location.origin}${import.meta.env.BASE_URL}ocr/pdf`;
  const task = pdfjs.getDocument({
    data: bytes,
    wasmUrl: `${assetRoot}/wasm/`,
    standardFontDataUrl: `${assetRoot}/standard_fonts/`,
    cMapUrl: `${assetRoot}/cmaps/`,
    cMapPacked: true,
    stopAtErrors: true,
    enableXfa: false,
    useSystemFonts: false,
  });
  let worker: Awaited<
    ReturnType<(typeof import("tesseract.js"))["createWorker"]>
  > | null = null;
  let render: { cancel: () => void } | null = null;
  const controller = new AbortController();
  const stop = () => controller.abort();
  const abort = () => {
    render?.cancel();
    void task.destroy().catch(() => {});
    void worker?.terminate().catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  controller.signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(stop, 120_000);
  const wait = <T>(promise: Promise<T>) =>
    abortable(promise, controller.signal);
  try {
    status("Reading the selected page locally…");
    const pdf = await wait(task.promise);
    if (pdf.numPages > PRIOR_PDF_MAX_PAGES || pageNumber > pdf.numPages)
      throw new Error(
        `Choose an existing page in a PDF of at most ${PRIOR_PDF_MAX_PAGES} pages.`,
      );
    const page = await wait(pdf.getPage(pageNumber));
    const native = page.getViewport({ scale: 1 });
    if (
      ![native.width, native.height].every((n) => Number.isFinite(n) && n > 0)
    )
      throw new Error("Invalid PDF page dimensions.");
    const viewport = page.getViewport({
      scale: Math.min(
        2,
        Math.sqrt(PRIOR_PAGE_MAX_PIXELS / (native.width * native.height)),
      ),
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot display the page.");
    const rendering = page.render({ canvasContext: ctx, canvas, viewport });
    render = rendering;
    await wait(rendering.promise);
    const preview = await wait(
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) =>
            b ? resolve(b) : reject(new Error("Could not display this page.")),
          "image/png",
        ),
      ),
    );
    const textContent = await wait(page.getTextContent());
    let text = textContent.items
      .map((item) =>
        "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
      )
      .join("");
    let method: ReadPage["method"] = "text";
    if (forceOcr || text.trim().length < 30) {
      status(
        "Reading the scanned page locally. Check every figure against the image.",
      );
      const { createWorker, OEM } = await import("tesseract.js");
      const root = `${window.location.origin}${import.meta.env.BASE_URL}ocr`;
      const creation = createWorker("eng", OEM.LSTM_ONLY, {
        workerPath: `${root}/worker.min.js`,
        corePath: `${root}/core`,
        langPath: `${root}/lang`,
        cacheMethod: "none",
        workerBlobURL: false,
      });
      // If cancelled during startup, terminate the eventual worker rather than leaking it.
      void creation.then(
        (w) => {
          if (controller.signal.aborted) void w.terminate();
        },
        () => {},
      );
      worker = await wait(creation);
      controller.signal.throwIfAborted();
      const result = await wait(worker.recognize(canvas));
      text = result.data.text;
      method = "ocr";
    }
    controller.signal.throwIfAborted();
    return {
      sha256: hash,
      page: pageNumber,
      pages: pdf.numPages,
      text: text.slice(0, 60_000),
      method,
      preview,
    };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", stop);
    controller.signal.removeEventListener("abort", abort);
    await Promise.allSettled([worker?.terminate(), task.destroy()]);
  }
}
