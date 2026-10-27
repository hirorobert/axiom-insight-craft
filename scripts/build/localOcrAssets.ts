/** OCR runs locally. Bundle every runtime asset so no financial page or text is sent to a CDN. */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
export function localOcrAssets(): Plugin {
  const files = new Map<string, { path: string; type: string }>();
  files.set("ocr/worker.min.js", {
    path: "node_modules/tesseract.js/dist/worker.min.js",
    type: "text/javascript",
  });
  for (const name of ["tesseract-core-lstm", "tesseract-core-simd-lstm"]) {
    files.set(`ocr/core/${name}.wasm.js`, {
      path: `node_modules/tesseract.js-core/${name}.wasm.js`,
      type: "text/javascript",
    });
    files.set(`ocr/core/${name}.wasm`, {
      path: `node_modules/tesseract.js-core/${name}.wasm`,
      type: "application/wasm",
    });
  }
  files.set("ocr/lang/eng.traineddata.gz", {
    path: "node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz",
    type: "application/octet-stream",
  });
  // PDF scans may use JBIG2/JPEG2000; host decoders, fonts and CMaps locally too.
  for (const folder of ["wasm", "standard_fonts", "cmaps"]) {
    for (const name of readdirSync(
      resolve(process.cwd(), `node_modules/pdfjs-dist/${folder}`),
    )) {
      files.set(`ocr/pdf/${folder}/${name}`, {
        path: `node_modules/pdfjs-dist/${folder}/${name}`,
        type: name.endsWith(".wasm")
          ? "application/wasm"
          : name.endsWith(".js") || name.endsWith(".mjs")
            ? "text/javascript"
            : "application/octet-stream",
      });
    }
  }
  let root = "";
  return {
    name: "cfoclose-local-ocr",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = files.get(
          (req.url ?? "").split("?")[0].replace(/^\//, ""),
        );
        if (!file) return next();
        res.setHeader("Content-Type", file.type);
        res.end(readFileSync(resolve(root, file.path)));
      });
    },
    generateBundle() {
      const licenses = [
        "node_modules/pdfjs-dist/LICENSE",
        "node_modules/tesseract.js/LICENSE.md",
        "node_modules/tesseract.js-core/LICENSE",
      ]
        .map((file) => `${file}\n${readFileSync(resolve(root, file), "utf8")}`)
        .join("\n\n");
      this.emitFile({
        type: "asset",
        fileName: "ocr/NOTICE.txt",
        source: `${licenses}\n\nEnglish model distribution: @tesseract.js-data/eng@1.0.0 (MIT package metadata), https://github.com/naptha/tessdata`,
      });
      for (const [fileName, file] of files)
        this.emitFile({
          type: "asset",
          fileName,
          source: readFileSync(resolve(root, file.path)),
        });
    },
  };
}
