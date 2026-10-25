import {
  normalizeEntry,
  resourceUrl,
  type BangumiSubject,
} from "@/data/entries";
import { studioConfig } from "@/data/studio";

const api = "https://api.bgm.tv";
export interface SubjectResult {
  id: number;
  type: number;
  name: string;
  name_cn?: string;
  images?: { common?: string; large?: string };
}
async function request(path: string, signal: AbortSignal) {
  for (const base of [studioConfig.bangumiProxy, api]) {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(base === api ? 6000 : 15_000),
        ]),
        credentials: "omit",
      });
      if (response.ok) {
        const data = await response.json();
        return { data, proxy: base !== api };
      }
    } catch (error) {
      if (signal.aborted) throw error;
      continue;
    }
    if ([404, 429].includes(response.status))
      throw new Error(
        response.status === 404
          ? "未找到此 Bangumi 条目，或条目暂不公开。"
          : "检索暂时较多，请稍后重试。"
      );
  }
  throw new Error(
    "暂时无法连接 Bangumi，检索服务和备用线路均未连接成功。已填写的内容会保留。"
  );
}
export async function searchSubjects(
  keyword: string,
  type: 2 | 4,
  signal: AbortSignal
): Promise<SubjectResult[]> {
  const { data: result, proxy } = await request(
    `/search/subject/${encodeURIComponent(keyword)}?type=${type}&responseGroup=small&max_results=12`,
    signal
  );
  return (Array.isArray(result.list) ? result.list : [])
    .filter((item: SubjectResult) => item.type === type)
    .slice(0, 12)
    .map((item: SubjectResult) => ({
      ...item,
      images: {
        common: coverUrl(
          item.id,
          item.images?.common || item.images?.large,
          proxy
        ),
      },
    }));
}
export async function getSubject(
  id: number,
  type: 2 | 4,
  signal: AbortSignal
): Promise<BangumiSubject> {
  const { data: result, proxy } = await request(`/v0/subjects/${id}`, signal);
  if (result.type !== type)
    throw new Error(type === 2 ? "请选择动画条目。" : "请选择游戏条目。");
  const wanted =
    type === 2
      ? ["导演", "动画制作", "原作"]
      : ["开发", "开发商", "发行", "发行商", "游戏类型", "游玩人数"];
  const facts = (result.infobox ?? [])
    .filter((item: { key: string }) => wanted.includes(item.key))
    .slice(0, 4)
    .map((item: { key: string; value: unknown }) => ({
      label: item.key,
      value:
        typeof item.value === "string"
          ? item.value
          : Array.isArray(item.value)
            ? item.value
                .map((part: { v?: string }) => part.v ?? "")
                .filter(Boolean)
                .join("、")
            : "",
    }));
  return normalizeEntry({
    subject: {
      id: result.id,
      type,
      name: result.name_cn || result.name,
      originalName: result.name,
      image: coverUrl(
        result.id,
        result.images?.common || result.images?.large,
        proxy
      ),
      date: result.date || "",
      platform: result.platform || "",
      summary: result.summary || "",
      episodes: result.eps || result.total_episodes || 0,
      facts,
    },
  }).subject!;
}

function coverUrl(id: number, source: unknown, proxy: boolean): string {
  const image = resourceUrl(source);
  return image && proxy ? `${studioConfig.bangumiProxy}/covers/${id}` : image;
}

export async function downloadSubjectCover(
  subject: BangumiSubject,
  signal: AbortSignal
) {
  const response = await fetch(subject.image, {
    credentials: "omit",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) throw new Error("封面暂未下载。");
  const blob = await response.blob();
  if (
    blob.size > 5 * 1024 * 1024 ||
    !/^image\/(?:jpeg|png|webp|gif|avif)$/.test(blob.type)
  )
    throw new Error("封面格式暂不支持。");
  return new File([blob], `bangumi-${subject.id}`, { type: blob.type });
}

export function subjectId(value: string): number | null {
  const match = value
    .trim()
    .match(
      /^(?:https:\/\/(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/)?(\d+)\/?$/
    );
  return match && Number.isSafeInteger(Number(match[1]))
    ? Number(match[1])
    : null;
}
