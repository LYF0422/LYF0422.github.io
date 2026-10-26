import { paperFromUrl, resourceUrl } from "@/data/entries";
import { getAssetPath } from "@/utils/withBase";

export interface CachedPaper {
  path: string;
  sha256: string;
  size: number;
}
export interface ImportedPaper extends CachedPaper {
  blob: Blob;
}
export function arxivId(value: string): string {
  try {
    const paper = paperFromUrl(value);
    const url = new URL(paper.pdfUrl);
    if (url.hostname !== "arxiv.org") return "";
    return url.pathname.slice("/pdf/".length);
  } catch {
    return "";
  }
}
export function arxivPath(id: string): string {
  if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?$/i.test(id))
    throw new Error("请输入有效的 arXiv 论文网址。");
  return `/documents/studio/arxiv/${id.replaceAll("/", "_")}.pdf`;
}
export function validCachedPaper(
  value: unknown,
  id: string
): value is CachedPaper {
  if (!value || typeof value !== "object") return false;
  const item = value as CachedPaper;
  return (
    item.path === arxivPath(id) &&
    resourceUrl(item.path) !== "" &&
    /^[a-f0-9]{64}$/.test(item.sha256) &&
    Number.isSafeInteger(item.size) &&
    item.size > 0 &&
    item.size <= 20 * 1024 * 1024
  );
}
export async function cachedArxivPaper(
  id: string,
  signal: AbortSignal
): Promise<CachedPaper | null> {
  try {
    const response = await fetch(
      getAssetPath("documents/studio/arxiv/index.json"),
      {
        credentials: "omit",
        cache: "no-cache",
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      }
    );
    if (!response.ok) return null;
    const index = await response.json();
    const item = index.version === 1 ? index.papers?.[id] : null;
    return validCachedPaper(item, id) ? item : null;
  } catch {
    signal.throwIfAborted();
    return null;
  }
}
export async function checkPaperDigest(blob: Blob, expected: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer()
  );
  const actual = Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  if (actual !== expected)
    throw new Error("下载的论文校验未通过，请重新获取或上传 PDF。");
}
