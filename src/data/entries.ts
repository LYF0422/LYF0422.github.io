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

export interface EntryMeta {
  showcase: boolean;
  subject: BangumiSubject | null;
  rating: number | null;
  status: string;
  comment: string;
  photos: GalleryPhoto[];
  paper: { sourceUrl: string; pdfUrl: string; authors: string };
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
      sourceUrl: resourceUrl(item.paper?.sourceUrl),
      pdfUrl: resourceUrl(item.paper?.pdfUrl),
      authors: string(item.paper?.authors, 1000),
    },
  };
}

export function paperFromUrl(value: string) {
  const sourceUrl = resourceUrl(value.trim());
  if (!sourceUrl) throw new Error("请输入完整的 HTTPS 论文网址或 PDF 链接。");
  const url = new URL(sourceUrl);
  let pdfUrl =
    /\.pdf$/i.test(url.pathname) || /\/pdf(?:\/|$)/.test(url.pathname)
      ? sourceUrl
      : "";
  if (/^(?:www\.|export\.)?arxiv\.org$/.test(url.hostname)) {
    const id = url.pathname
      .replace(/^\/(?:abs|pdf|html)\//, "")
      .replace(/\.pdf$/, "");
    if (/^(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?$/i.test(id)) {
      pdfUrl = `https://arxiv.org/pdf/${id}`;
      return { sourceUrl: `https://arxiv.org/abs/${id}`, pdfUrl };
    }
  }
  if (url.hostname === "openreview.net" && url.searchParams.has("id"))
    pdfUrl = `https://openreview.net/pdf?id=${encodeURIComponent(url.searchParams.get("id")!)}`;
  if (url.hostname === "aclanthology.org" && /^\/[\w.-]+\/$/.test(url.pathname))
    pdfUrl = `${sourceUrl.replace(/\/$/, "")}.pdf`;
  return { sourceUrl, pdfUrl };
}
