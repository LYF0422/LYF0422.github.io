import type { PaperMetadata } from "./pdf-metadata";
import { PaperSourceError } from "./paper-source";
import { paperTextFields } from "@/data/papers";

/** DOI metadata is public even when a publisher refuses the PDF download. */
export async function readDoiMetadata(
  doi: string,
  signal: AbortSignal
): Promise<PaperMetadata | null> {
  try {
    const response = await fetch(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      {
        credentials: "omit",
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      }
    );
    if (!response.ok) return null;
    const data = (await response.json()).message;
    if (
      typeof data?.DOI !== "string" ||
      data.DOI.toLowerCase() !== doi.toLowerCase()
    )
      return null;
    const clean = (value: unknown, limit = 2000) =>
      typeof value === "string"
        ? value.replace(/\s+/g, " ").trim().slice(0, limit)
        : "";
    const title = clean(data.title?.[0], 500);
    const subtitle = clean(data.subtitle?.[0], 500);
    const abstract = document.createElement("template");
    abstract.innerHTML = typeof data.abstract === "string" ? data.abstract : "";
    const year = String(data.published?.["date-parts"]?.[0]?.[0] || "");
    return {
      title:
        title && subtitle && !title.includes(subtitle)
          ? `${title}: ${subtitle}`.slice(0, 500)
          : title,
      authors: Array.isArray(data.author)
        ? data.author
            .slice(0, 100)
            .map((author: { given?: string; family?: string; name?: string }) =>
              clean(
                [author.given, author.family].filter(Boolean).join(" ") ||
                  author.name
              )
            )
            .filter(Boolean)
            .join(", ")
            .slice(0, 1000)
        : "",
      abstract: clean(abstract.content.textContent),
      year: /^(?:19|20)\d{2}$/.test(year) ? year : "",
      doi,
      venue: clean(data["container-title"]?.[0] || data.event?.name, 500),
      publisher: clean(data.publisher, 300),
      volume: clean(data.volume, 50),
      issue: clean(data.issue, 50),
      pages: clean(data.page || data["article-number"], 100),
      keywords: Array.isArray(data.subject)
        ? data.subject
            .map((value: unknown) => clean(value, 100))
            .filter(Boolean)
            .slice(0, 8)
        : [],
    };
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

export function mergePaperMetadata(
  pdf: PaperMetadata,
  publisher: PaperMetadata | null
): PaperMetadata {
  if (!publisher) return pdf;
  const merged = {
    ...pdf,
    title: publisher.title || pdf.title,
    keywords: publisher.keywords.length ? publisher.keywords : pdf.keywords,
  };
  for (const key of paperTextFields) merged[key] = publisher[key] || pdf[key];
  return merged;
}

/** A DOI found in PDF text may belong to a cited work. Require its title to match. */
export async function enrichPaperMetadata(
  pdf: PaperMetadata,
  signal: AbortSignal
): Promise<PaperMetadata> {
  if (!/^10\.\d{4,9}\/.+/.test(pdf.doi)) return pdf;
  const publisher = await readDoiMetadata(pdf.doi, signal);
  signal.throwIfAborted();
  if (!publisher) return pdf;
  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  const a = normalize(pdf.title),
    b = normalize(publisher.title);
  // Conservative containment allows a subtitle to be omitted from one source.
  if (Math.min(a.length, b.length) < 12 || !(a.includes(b) || b.includes(a)))
    return pdf;
  return mergePaperMetadata(pdf, publisher);
}

/** A verification page is an access failure; changing URL syntax cannot fix it. */
export function acmDownloadError(error: unknown): Error {
  if (error instanceof Error && /PDF 最大支持/.test(error.message))
    return error;
  const status =
    error instanceof Error ? error.message.match(/HTTP \d{3}/)?.[0] : "";
  return new PaperSourceError(
    `ACM 未提供可供本站读取的 PDF${status ? `（${status}）` : ""}，可能受到访问验证或跨域限制。已填写的信息保留，请点击“打开原文”下载 PDF 后上传。`
  );
}
