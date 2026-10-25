import { studioConfig } from "@/data/studio";
import { getAssetPath } from "@/utils/withBase";

export function validPostPath(value: string): boolean {
  return (
    value.length <= 1000 &&
    value.startsWith(`${studioConfig.postsDirectory}/`) &&
    value.endsWith(".md") &&
    !/[\\\u0000-\u001f]/.test(value) &&
    value
      .split("/")
      .every(
        part =>
          Boolean(part) &&
          part !== "." &&
          part !== ".." &&
          !part.startsWith("_")
      )
  );
}

export function studioEditUrl(path: string): string {
  if (!validPostPath(path)) throw new Error("文章路径无效，无法生成编辑链接。");
  return `${getAssetPath("studio/")}?${new URLSearchParams({ edit: path })}`;
}

export function requestedPost(search: string): string | null {
  const path = new URLSearchParams(search).get("edit");
  if (path === null) return null;
  if (!validPostPath(path))
    throw new Error("编辑链接中的文章路径无效，请从文章页重新进入写作台。");
  return path;
}
