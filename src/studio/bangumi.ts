import type { BangumiSubject } from "@/data/entries";
import { getAssetPath } from "@/utils/withBase";
export {
  searchCatalog as searchSubjects,
  readCatalogSubject as getSubject,
} from "./catalog";

export async function downloadSubjectCover(
  subject: BangumiSubject,
  signal: AbortSignal
) {
  const response = await fetch(getAssetPath(subject.image), {
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
