export interface BangumiSubject {
  id: number;
  type: 2 | 4;
  name: string;
  originalName: string;
  image: string;
  date: string;
  platform: string;
  summary: string;
  episodes: number;
  facts: { label: string; value: string }[];
}

export interface GalleryPhoto {
  src: string;
  caption: string;
  alt: string;
  width: number;
  height: number;
}

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfAnnotation {
  id: string;
  documentId: string;
  page: number;
  kind: "highlight" | "note";
  color: "yellow" | "blue" | "pink";
  rects: PdfRect[];
  quote: string;
  text: string;
}

export interface EntryMeta {
  showcase: boolean;
  subject: BangumiSubject | null;
  rating: number | null;
  status: string;
  comment: string;
  photos: GalleryPhoto[];
  paper: {
    title: string;
    sourceUrl: string;
    pdfUrl: string;
    authors: string;
    abstract: string;
    year: string;
    doi: string;
    annotations: PdfAnnotation[];
  };
}

export const entryStatuses: Record<string, string> = {
  wish: "计划中",
  doing: "进行中",
  completed: "已完成",
  on_hold: "搁置",
  dropped: "放弃",
};

/** Only public HTTPS resources and this site's uploaded media may be embedded. */
export function resourceUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  if (/^\/bangumi\/covers\/[1-9]\d*\.webp$/.test(value)) return value;
  if (
    /^\/(?:images|documents)\/studio\/[\w./%-]+$/u.test(value) &&
    !value.includes("..")
  )
    return value;
  try {
    const url = new URL(
      value.replace(/^http:\/\/(lain\.bgm\.tv|bgm\.tv)\//, "https://$1/")
    );
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}

/** Fit a PDF to its reading pane while preserving an explicit page or zoom. */
export function pdfPreviewUrl(value: string): string {
  return value.includes("#") ? value : `${value}#zoom=page-width&navpanes=0`;
}

const string = (value: unknown, length = 2000) =>
  typeof value === "string" ? value.slice(0, length) : "";

export function normalizeAnnotations(value: unknown): PdfAnnotation[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.slice(0, 1000).flatMap(item => {
    if (
      !item ||
      typeof item !== "object" ||
      !/^[\w-]{1,100}$/.test(item.id) ||
      ids.has(item.id) ||
      !/^[a-f0-9]{64}$/.test(item.documentId) ||
      !Number.isInteger(item.page) ||
      item.page < 1 ||
      item.page > 10000 ||
      !["highlight", "note"].includes(item.kind)
    )
      return [];
    const rects: PdfRect[] = Array.isArray(item.rects)
      ? item.rects.slice(0, 100).flatMap((rect: PdfRect) => {
          if (
            !rect ||
            ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
            rect.x < 0 ||
            rect.y < 0 ||
            rect.x >= 1 ||
            rect.y >= 1 ||
            rect.width <= 0 ||
            rect.height <= 0
          )
            return [];
          return [
            {
              x: rect.x,
              y: rect.y,
              width: Math.min(rect.width, 1 - rect.x),
              height: Math.min(rect.height, 1 - rect.y),
            },
          ];
        })
      : [];
    if (!rects.length) return [];
    ids.add(item.id);
    return [
      {
        id: item.id,
        documentId: item.documentId,
        page: item.page,
        kind: item.kind,
        color: ["yellow", "blue", "pink"].includes(item.color)
          ? item.color
          : "yellow",
        rects,
        quote: string(item.quote),
        text: string(item.text, 4000),
      },
    ];
  });
}

export function normalizeEntry(value?: unknown): EntryMeta {
  const item = (
    value && typeof value === "object" ? value : {}
  ) as Partial<EntryMeta>;
  const subject = item.subject;
  return {
    showcase: item.showcase !== false,
    subject:
      subject &&
      [2, 4].includes(subject.type) &&
      Number.isSafeInteger(subject.id) &&
      subject.id > 0
        ? {
            id: subject.id,
            type: subject.type,
            name: string(subject.name, 300),
            originalName: string(subject.originalName, 300),
            image: resourceUrl(subject.image),
            date: string(subject.date, 50),
            platform: string(subject.platform, 100),
            summary: string(subject.summary, 6000),
            episodes: Number.isFinite(subject.episodes) ? subject.episodes : 0,
            facts: Array.isArray(subject.facts)
              ? subject.facts
                  .filter(fact => fact && typeof fact === "object")
                  .slice(0, 5)
                  .map(fact => ({
                    label: string(fact.label, 50),
                    value: string(fact.value, 500),
                  }))
              : [],
          }
        : null,
    rating:
      typeof item.rating === "number" &&
      Number.isFinite(item.rating) &&
      item.rating >= 0 &&
      item.rating <= 10
        ? item.rating
        : null,
    status:
      item.status && Object.hasOwn(entryStatuses, item.status)
        ? item.status
        : "",
    comment: string(item.comment, 2000),
    photos: Array.isArray(item.photos)
      ? item.photos
          .filter(photo => photo && typeof photo === "object")
          .map(photo => ({
            src: resourceUrl(photo.src),
            caption: string(photo.caption),
            alt: string(photo.alt),
            width: Number.isFinite(photo.width) ? photo.width : 0,
            height: Number.isFinite(photo.height) ? photo.height : 0,
          }))
          .filter(photo => photo.src)
      : [],
    paper: {
      title: string(item.paper?.title, 500),
      sourceUrl: resourceUrl(item.paper?.sourceUrl),
      pdfUrl: resourceUrl(item.paper?.pdfUrl),
      authors: string(item.paper?.authors, 1000),
      abstract: string(item.paper?.abstract, 2000),
      year: /^(19|20)\d{2}$/.test(String(item.paper?.year ?? ""))
        ? String(item.paper?.year)
        : "",
      doi: string(item.paper?.doi, 300).replace(
        /^https?:\/\/(?:dx\.)?doi\.org\//i,
        ""
      ),
      annotations: normalizeAnnotations(item.paper?.annotations),
    },
  };
}

export function paperFromUrl(value: string) {
  // Accept a URL copied as a Markdown link or wrapped in angle brackets.
  const pasted = value
    .trim()
    .replace(
      /^\[[^\]]*\]\(\s*(https?:\/\/[^\s]+?)(?:\s+["'][^"']*["'])?\s*\)$/,
      "$1"
    )
    .replace(/^<(https?:\/\/[^<>]+)>$/, "$1")
    .replace(
      /^http:\/\/((?:(?:www|export)\.)?arxiv\.org)(?=\/|$)/i,
      "https://$1"
    );
  const sourceUrl = resourceUrl(pasted);
  if (!sourceUrl) throw new Error("请输入完整的 HTTPS 论文网址或 PDF 链接。");
  const url = new URL(sourceUrl);
  let pdfUrl =
    /\.pdf$/i.test(url.pathname) || /\/pdf(?:\/|$)/.test(url.pathname)
      ? sourceUrl
      : "";
  if (/^(?:www\.|export\.)?arxiv\.org$/.test(url.hostname)) {
    const id = url.pathname
      .replace(/^\/(?:abs|pdf|html)\//, "")
      .replace(/\/+$/, "")
      .replace(/\.pdf$/i, "");
    if (/^(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?$/i.test(id)) {
      pdfUrl = `https://arxiv.org/pdf/${id}`;
      return { sourceUrl: `https://arxiv.org/abs/${id}`, pdfUrl };
    }
    throw new Error(
      "请输入有效的 arXiv 论文网址，例如 https://arxiv.org/abs/2406.07550。"
    );
  }
  if (url.hostname === "openreview.net" && url.searchParams.has("id"))
    pdfUrl = `https://openreview.net/pdf?id=${encodeURIComponent(url.searchParams.get("id")!)}`;
  if (
    url.hostname === "aclanthology.org" &&
    /^\/[\w.-]+\/?$/.test(url.pathname) &&
    !pdfUrl
  )
    pdfUrl = `${url.origin}${url.pathname.replace(/\/$/, "")}.pdf`;
  if (
    url.hostname === "openaccess.thecvf.com" &&
    /\/html\/[^/]+\.html$/i.test(url.pathname)
  )
    pdfUrl = `${url.origin}${url.pathname.replace(/\/html\//, "/papers/").replace(/\.html$/i, ".pdf")}`;
  if (
    /^(?:papers\.(?:neurips|nips)\.cc)$/.test(url.hostname) &&
    /\/hash\/[^/]+-Abstract(?:-Conference)?\.html$/i.test(url.pathname)
  )
    pdfUrl = `${url.origin}${url.pathname.replace(/\/hash\//, "/file/").replace(/-Abstract(-Conference)?\.html$/i, "-Paper$1.pdf")}`;
  if (url.hostname === "proceedings.mlr.press") {
    const match = url.pathname.match(/^\/(v\d+)\/([^/]+)\.html$/);
    if (match) pdfUrl = `${url.origin}/${match[1]}/${match[2]}/${match[2]}.pdf`;
  }
  return { sourceUrl, pdfUrl };
}
