import { paperFromUrl, resourceUrl } from "@/data/entries";
import { pdfSizeMessage, paperTransferTimeout } from "@/data/papers";

/** These errors describe locating a document, before PDF parsing starts. */
export class PaperSourceError extends Error {}

/** Resolve an article's main PDF without executing its HTML or loading subresources. */
export async function resolvePaperSource(value: string, signal: AbortSignal) {
  const paper = paperFromUrl(value);
  if (paper.pdfUrl) return { ...paper, bytes: undefined };
  const { pdfLimit, readPdfBytes } = await import("./pdf-document");
  let response: Response;
  try {
    response = await fetch(paper.sourceUrl, {
      credentials: "omit",
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(paperTransferTimeout),
      ]),
    });
  } catch {
    signal.throwIfAborted();
    throw new PaperSourceError(
      "浏览器无法读取这个论文网页，可能是网络或网站跨域限制。请复制网页中的 PDF 下载链接，或下载后上传 PDF。"
    );
  }
  if (!response.ok || !response.body)
    throw new PaperSourceError(
      `论文网页读取失败（HTTP ${response.status}）。请提供 PDF 下载链接，或上传 PDF。`
    );
  const type = response.headers.get("content-type") || "";
  if (/application\/pdf|application\/octet-stream/i.test(type)) {
    const bytes = await readPdfBytes(response, signal);
    return { ...paper, pdfUrl: response.url || paper.sourceUrl, bytes };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  // HTML pages need far less space than a PDF. Untyped download endpoints may
  // still return a PDF; detect their header before applying the smaller limit.
  let size = 0;
  let pdf = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      const header = new Uint8Array(Math.min(size, 1024));
      let offset = 0;
      for (const chunk of chunks) {
        const part = chunk.subarray(0, header.length - offset);
        header.set(part, offset);
        offset += part.length;
        if (offset === header.length) break;
      }
      pdf = new TextDecoder().decode(header).includes("%PDF-");
      if (size > (pdf ? pdfLimit : 2 * 1024 * 1024))
        throw new PaperSourceError(
          pdf
            ? pdfSizeMessage
            : "论文网页内容过大，请提供 PDF 下载链接或上传 PDF。"
        );
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const blob = new Blob(chunks as BlobPart[]);
  if (pdf) {
    const bytes = await readPdfBytes(blob, signal);
    return { ...paper, pdfUrl: response.url || paper.sourceUrl, bytes };
  }
  const template = document.createElement("template");
  template.innerHTML = await blob.text();
  const html = template.content;
  const base = response.url || paper.sourceUrl;
  const resolve = (value: string | null) => {
    if (!value?.trim() || value.trim().startsWith("#")) return "";
    try {
      const url = resourceUrl(new URL(value.trim(), base).href);
      return url !== base && url !== paper.sourceUrl ? url : "";
    } catch {
      return "";
    }
  };
  const candidates: string[] = [];
  for (const meta of html.querySelectorAll("meta[name], meta[property]")) {
    const name = (
      meta.getAttribute("name") ||
      meta.getAttribute("property") ||
      ""
    ).toLowerCase();
    if (
      ["citation_pdf_url", "eprints.document_url", "wkhealth_pdf_url"].includes(
        name
      )
    )
      candidates.push(resolve(meta.getAttribute("content")));
  }
  for (const link of html.querySelectorAll(
    'link[type="application/pdf"], a[type="application/pdf"]'
  ))
    candidates.push(resolve(link.getAttribute("href")));
  for (const link of html.querySelectorAll("a[href]")) {
    const label = (link.textContent || "").trim().replace(/\s+/g, " ");
    if (
      /^(?:\[?PDF\]?|(?:download|view|full[ -]?text)(?:\s+(?:the|full[ -]?text))?\s*\(?PDF\)?|(?:下载|查看|全文)\s*PDF)$/i.test(
        label
      )
    )
      candidates.push(resolve(link.getAttribute("href")));
  }
  const pdfUrl = candidates.find(Boolean);
  if (!pdfUrl)
    throw new PaperSourceError(
      "已读取这个网页，但没有找到公开的 PDF 下载链接。请复制网页中的 PDF 下载链接，或下载后上传 PDF。"
    );
  return { ...paper, pdfUrl, bytes: undefined };
}
