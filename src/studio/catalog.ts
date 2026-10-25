import { normalizeEntry, type BangumiSubject } from "@/data/entries";
import { getAssetPath } from "@/utils/withBase";

export interface CatalogItem {
  id: number;
  type: 2 | 4;
  name: string;
  name_cn: string;
  aliases: string[];
  image: string;
}
interface Catalog {
  version: 1;
  updatedAt: string;
  counts: { anime: number; game: number };
  subjects: CatalogItem[];
}
let catalogPromise: Promise<Catalog> | undefined;
const details = new Map<number, BangumiSubject>();
const localCover = (value: unknown) =>
  typeof value === "string" && /^\/bangumi\/covers\/[1-9]\d*\.webp$/.test(value)
    ? value
    : "";
const normalized = (value: string) =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");

async function readJson(path: string) {
  try {
    const response = await fetch(getAssetPath(path), {
      credentials: "omit",
      cache: "no-cache",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error();
    return await response.json();
  } catch {
    throw new Error("站内作品库暂时无法加载，请稍后重试。已填写的内容会保留。");
  }
}

export async function loadCatalog(signal?: AbortSignal): Promise<Catalog> {
  signal?.throwIfAborted();
  if (!catalogPromise) {
    catalogPromise = readJson("bangumi/catalog.json")
      .then(data => {
        if (
          data?.version !== 1 ||
          !Array.isArray(data.subjects) ||
          !Number.isFinite(Date.parse(data.updatedAt))
        )
          throw new Error("站内作品库格式无效，请稍后重试。");
        const subjects: CatalogItem[] = data.subjects
          .filter(
            (item: CatalogItem) =>
              item &&
              Number.isSafeInteger(item.id) &&
              item.id > 0 &&
              [2, 4].includes(item.type) &&
              typeof item.name === "string"
          )
          .map((item: CatalogItem) => ({
            ...item,
            name_cn: typeof item.name_cn === "string" ? item.name_cn : "",
            aliases: Array.isArray(item.aliases)
              ? item.aliases.filter(alias => typeof alias === "string")
              : [],
            image: localCover(item.image),
          }));
        if (!subjects.length)
          throw new Error("站内作品库正在准备中，请稍后重试。");
        return {
          version: 1 as const,
          updatedAt: data.updatedAt,
          subjects,
          counts: {
            anime: subjects.filter(item => item.type === 2).length,
            game: subjects.filter(item => item.type === 4).length,
          },
        };
      })
      .catch(error => {
        catalogPromise = undefined;
        throw error;
      });
  }
  const catalog = await catalogPromise;
  signal?.throwIfAborted();
  return catalog;
}

export async function searchCatalog(
  keyword: string,
  type: 2 | 4,
  signal: AbortSignal
) {
  const catalog = await loadCatalog(signal);
  const query = normalized(keyword);
  if (!query) return [];
  return catalog.subjects
    .filter(item => item.type === type)
    .map(item => {
      const terms = [item.name, item.name_cn, ...item.aliases]
        .map(normalized)
        .filter(Boolean);
      const score = terms.includes(query)
        ? 0
        : terms.some(term => term.startsWith(query))
          ? 1
          : terms.some(term => term.includes(query))
            ? 2
            : 3;
      return { item, score };
    })
    .filter(result => result.score < 3)
    .sort((a, b) => a.score - b.score)
    .slice(0, 12)
    .map(({ item }) => ({ ...item, images: { common: item.image } }));
}

export async function readCatalogSubject(
  id: number,
  type: 2 | 4,
  signal: AbortSignal
): Promise<BangumiSubject> {
  const catalog = await loadCatalog(signal);
  const item = catalog.subjects.find(subject => subject.id === id);
  if (!item)
    throw new Error(
      "站内暂未收录这个条目。当前作品库只包含部分热门动画和游戏。"
    );
  if (item.type !== type)
    throw new Error(type === 2 ? "请选择动画条目。" : "请选择游戏条目。");
  if (details.has(id)) return structuredClone(details.get(id)!);
  const data = await readJson(`bangumi/subjects/${id}.json`);
  signal.throwIfAborted();
  if (data?.id !== id || data.type !== type || typeof data.name !== "string")
    throw new Error("作品资料暂时无法读取，请稍后重试。");
  const subject = normalizeEntry({
    subject: { ...data, image: localCover(data.image) },
  }).subject!;
  details.set(id, subject);
  return structuredClone(subject);
}
