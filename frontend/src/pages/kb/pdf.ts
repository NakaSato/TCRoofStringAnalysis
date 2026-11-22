/** pdf.js (pdfjs-dist, Apache-2.0) for the Knowledge Base viewer: loaded only on the viewer and
 * document pages (its own chunk), with its worker as a bundled asset. Nothing is cached by the
 * service worker: the file link is short-lived and signed. */
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy };

/** Open a PDF by URL with range requests (the first page shows before the whole file is in). */
export const openPdf = (url: string): PDFDocumentLoadingTask =>
  pdfjs.getDocument({
    url,
    // never run the document's own scripts / forms (view only)
    enableXfa: false,
    disableAutoFetch: true,
    rangeChunkSize: 262_144,
  });
