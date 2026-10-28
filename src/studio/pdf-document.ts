import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { getAssetPath } from "@/utils/withBase";
import { pdfLimit, pdfSizeMessage, paperTransferTimeout } from "@/data/papers";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export { pdfjs };
export { pdfLimit } from "@/data/papers";

export function openPdf(bytes: Uint8Array) {
  return pdfjs.getDocument({
    data: bytes,
    cMapUrl: getAssetPath("pdfjs/cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: getAssetPath("pdfjs/standard_fonts/"),
    wasmUrl: getAssetPath("pdfjs/wasm/"),
  });
}

/** Limit the streamed body as well as Content-Length; never store an HTML error page. */
export async function readPdfBytes(
  source: string | Blob | Response,
  signal: AbortSignal,
  progress?: (size: number, total: number) => void
): Promise<Uint8Array<ArrayBuffer>> {
  let bytes: Uint8Array<ArrayBuffer>;
  if (source instanceof Blob) {
    if (source.size > pdfLimit) throw new Error(pdfSizeMessage);
    bytes = new Uint8Array(await source.arrayBuffer());
  } else {
    const response =
      source instanceof Response
        ? source
        : await fetch(source, {
            credentials: "omit",
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(paperTransferTimeout),
            ]),
          });
    if (!response.ok || !response.body)
      throw new Error(
        `PDF 下载失败（HTTP ${response.status}），请检查链接或上传 PDF。`
      );
    const total = Number(response.headers.get("content-length")) || 0;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (total > pdfLimit) throw new Error(pdfSizeMessage);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > pdfLimit) throw new Error(pdfSizeMessage);
        chunks.push(value);
        progress?.(size, total);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  }
  signal.throwIfAborted();
  // PDF headers may follow a short preamble, but an HTML response is never a PDF.
  if (!new TextDecoder().decode(bytes.slice(0, 1024)).includes("%PDF-"))
    throw new Error(
      "这个链接返回的不是 PDF 文件。请使用 PDF 下载地址，或下载后上传文件。"
    );
  return bytes;
}

export function pdfError(error: unknown): string {
  if (
    error instanceof Error &&
    /PDF 最大支持|HTTP|不是 PDF/.test(error.message)
  )
    return error.message;
  if (error instanceof Error && error.name === "TimeoutError")
    return "下载 PDF 超时。可重试，或从原文下载 PDF 后上传；已填写的信息会保留。";
  if (
    error instanceof Error &&
    ["TypeError", "NetworkError"].includes(error.name)
  )
    return "浏览器未能下载 PDF，可能是网络或网站跨域限制。请重试，或从原文下载 PDF 后上传。";
  return "PDF 无法解析，可能已加密或损坏。请上传可正常打开的 PDF。";
}
