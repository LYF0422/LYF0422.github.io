import { parse, stringify } from "yaml";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { categoryIds, type CategoryId } from "@/data/categories";
import { studioConfig } from "@/data/studio";
import { normalizeEntry, type EntryMeta } from "@/data/entries";

export interface WritingDocument {
  id: string;
  title: string;
  slug: string;
  description: string;
  category: CategoryId;
  tags: string[];
  pubDatetime: string;
  draft: boolean;
  featured: boolean;
  cover: string;
  html: string;
  path: string | null;
  remoteSha: string | null;
  updatedAt: string;
  syncedAt: string | null;
  extra: Record<string, unknown>;
  entry: EntryMeta;
}

export interface WritingAsset {
  path: string;
  blob: Blob;
  width: number;
  height: number;
}

export function newDocument(category: CategoryId = "notes"): WritingDocument {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: "",
    slug: "",
    description: "",
    category,
    tags: [],
    pubDatetime: now,
    draft: true,
    featured: false,
    cover: "",
    html: "<p></p>",
    path: null,
    remoteSha: null,
    updatedAt: now,
    syncedAt: null,
    extra: {},
    entry: normalizeEntry(),
  };
}

export function makeSlug(title: string, id: string): string {
  const text = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return (
    text || `entry-${new Date().toISOString().slice(0, 10)}-${id.slice(0, 6)}`
  );
}

export function cleanHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["data-align", "data-width", "data-caption"],
    FORBID_TAGS: ["style", "script", "iframe", "form", "input", "button"],
  });
}

export function updatePostOrganization(
  source: string,
  category: CategoryId,
  tags: string[]
): string {
  if (!categoryIds.includes(category)) throw new Error("请选择有效分类。");
  const match = source.match(
    /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
  );
  if (!match) throw new Error("这篇文章缺少文章信息，请先打开编辑后保存。");
  const meta = parse(match[1], { maxAliasCount: 20 });
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    throw new Error("文章信息格式无效，请先检查 Markdown 文件。");
  return `---\n${stringify({ ...meta, category, tags, modDatetime: new Date() }).trimEnd()}\n---\n${source.slice(match[0].length)}`;
}

export function parseDocument(
  source: string,
  path: string | null = null,
  sha: string | null = null
): WritingDocument {
  const match = source.match(
    /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/
  );
  const meta: Record<string, unknown> = match
    ? (parse(match[1], { maxAliasCount: 20 }) ?? {})
    : {};
  const doc = newDocument();
  const date = new Date(String(meta.pubDatetime ?? doc.pubDatetime));
  const category = String(meta.category ?? "notes") as CategoryId;
  const body = match ? source.slice(match[0].length) : source;
  return {
    ...doc,
    id:
      typeof meta.studioId === "string"
        ? meta.studioId
        : path
          ? `remote:${path}`
          : doc.id,
    title: String(meta.title ?? ""),
    description: String(meta.description ?? ""),
    slug: path?.split("/").pop()?.replace(/\.md$/, "") ?? "",
    category: categoryIds.includes(category) ? category : "notes",
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    pubDatetime: Number.isFinite(date.getTime())
      ? date.toISOString()
      : doc.pubDatetime,
    draft: meta.draft === true,
    featured: meta.featured === true,
    cover: typeof meta.cover === "string" ? meta.cover : "",
    html: cleanHtml(marked.parse(body, { async: false }) as string),
    path,
    remoteSha: sha,
    syncedAt: sha ? doc.updatedAt : null,
    extra: meta,
    entry: normalizeEntry(meta.entry),
  };
}

export function serializeDocument(doc: WritingDocument): string {
  const parsed = new DOMParser().parseFromString(
    cleanHtml(doc.html),
    "text/html"
  );
  const used = new Set<string>();
  parsed.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading, index) => {
    const base = makeSlug(heading.textContent ?? "", String(index));
    let id = base;
    for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
    used.add(id);
    heading.id = id;
  });
  // Image URLs remain repository-relative; temporary blob URLs never enter Git.
  parsed.querySelectorAll("img").forEach(image => {
    if (image.src.startsWith("blob:") || image.src.startsWith("data:"))
      throw new Error("图片仍在处理中，请稍后同步。");
  });
  const metadata = {
    ...doc.extra,
    studioId: doc.id,
    title: doc.title.trim(),
    description:
      doc.description.trim() ||
      (parsed.body.textContent ?? "").trim().slice(0, 120),
    pubDatetime: new Date(doc.pubDatetime),
    modDatetime: new Date(),
    category: doc.category,
    tags: doc.tags,
    draft: doc.draft,
    featured: doc.featured,
    entry: normalizeEntry(doc.entry),
    ...(doc.cover ? { cover: doc.cover } : {}),
  };
  if (!doc.cover) delete (metadata as Record<string, unknown>).cover;
  const height = String(doc.extra.studioLineHeight ?? "2");
  const lineHeight = ["1.7", "2", "2.3"].includes(height) ? height : "2";
  return `---\n${stringify(metadata).trimEnd()}\n---\n\n<div class="studio-content" style="line-height:${lineHeight}">${parsed.body.innerHTML}</div>\n`;
}

export function referencedMedia(doc: WritingDocument): Set<string> {
  const parsed = new DOMParser().parseFromString(doc.html, "text/html");
  const urls = [...parsed.querySelectorAll("img")].map(
    image => image.getAttribute("src") ?? ""
  );
  if (doc.cover) urls.push(doc.cover);
  const entry = normalizeEntry(doc.entry);
  urls.push(
    ...entry.photos.map(photo => photo.src),
    entry.paper.pdfUrl,
    entry.subject?.image ?? ""
  );
  return new Set(
    urls
      .filter(url => /^\/(?:images|documents)\/studio\//.test(url))
      .map(url => `public${url}`)
  );
}

export function documentPath(doc: WritingDocument): string {
  if (doc.path) {
    if (
      !doc.path.startsWith(`${studioConfig.postsDirectory}/`) ||
      doc.path.split("/").some(part => part === "..") ||
      !doc.path.endsWith(".md")
    )
      throw new Error("文章路径无效。");
    return doc.path;
  }
  const slug = doc.slug.trim() || makeSlug(doc.title, doc.id);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,119}$/u.test(slug))
    throw new Error("文件名只能包含文字、数字、短横线和下划线。");
  return `${studioConfig.postsDirectory}/${slug}.md`;
}
