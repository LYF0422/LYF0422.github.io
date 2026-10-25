import { studioConfig } from "@/data/studio";
import {
  documentPath,
  referencedMedia,
  serializeDocument,
  updatePostOrganization,
  type WritingAsset,
  type WritingDocument,
} from "./model";
import type { CategoryId } from "@/data/categories";

export interface RemoteFile {
  path: string;
  sha: string;
  size?: number;
}
interface TreeEntry extends RemoteFile {
  type: string;
}
interface Snapshot {
  head: string;
  tree: string;
  files: TreeEntry[];
}
export class GitHubError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}
const encodePath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");
export const utf8FromBase64 = (value: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(value.replace(/\s/g, "")), char => char.charCodeAt(0))
  );
async function blobBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export class GitHubClient {
  private base = `/repos/${encodePath(studioConfig.repository)}`;
  constructor(private token: string) {}
  private async request<T>(
    path: string,
    method = "GET",
    data?: unknown
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(data ? { "Content-Type": "application/json" } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      throw new GitHubError(
        "暂时无法连接 GitHub。内容仍保存在本机，可恢复网络后重试。",
        0
      );
    }
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: "GitHub 登录已失效，请重新连接。",
        403: "没有写入权限，或 GitHub 请求额度已用完。请检查令牌的 Contents 权限。",
        404: "未找到仓库或分支，请检查令牌是否允许访问这个仓库。",
        409: "GitHub 上的内容发生了变化，请重新载入后再同步。",
        422: "提交未被接受。分支可能已更新或受保护，请刷新后重试。",
      };
      throw new GitHubError(
        messages[response.status] ??
          `GitHub 请求失败（${response.status}），本地内容已保留。`,
        response.status
      );
    }
    return response.json() as Promise<T>;
  }
  async connect() {
    const user = await this.request<{ login: string; avatar_url: string }>(
      "/user"
    );
    const repo = await this.request<{
      permissions?: { push?: boolean };
      default_branch: string;
    }>(this.base);
    if (repo.permissions?.push === false)
      throw new GitHubError("这个 GitHub 账号没有仓库写入权限。", 403);
    await this.request(
      `${this.base}/git/ref/heads/${encodePath(studioConfig.branch)}`
    );
    return user;
  }
  private async snapshot(): Promise<Snapshot> {
    const reference = await this.request<{ object: { sha: string } }>(
      `${this.base}/git/ref/heads/${encodePath(studioConfig.branch)}`
    );
    const commit = await this.request<{ tree: { sha: string } }>(
      `${this.base}/git/commits/${reference.object.sha}`
    );
    const tree = await this.request<{ tree: TreeEntry[]; truncated: boolean }>(
      `${this.base}/git/trees/${commit.tree.sha}?recursive=1`
    );
    if (tree.truncated)
      throw new GitHubError(
        "仓库文件过多，无法完整读取。请先缩小媒体目录。",
        413
      );
    return {
      head: reference.object.sha,
      tree: commit.tree.sha,
      files: tree.tree,
    };
  }
  async listPosts(): Promise<RemoteFile[]> {
    const snapshot = await this.snapshot();
    return snapshot.files.filter(
      entry =>
        entry.type === "blob" &&
        entry.path.startsWith(`${studioConfig.postsDirectory}/`) &&
        entry.path.endsWith(".md") &&
        !entry.path.split("/").pop()?.startsWith("_")
    );
  }
  async readFile(file: RemoteFile): Promise<string> {
    const blob = await this.request<{ content: string; encoding: string }>(
      `${this.base}/git/blobs/${file.sha}`
    );
    if (blob.encoding !== "base64") throw new Error("无法读取这篇文章的编码。");
    return utf8FromBase64(blob.content);
  }
  rawUrl(path: string) {
    return `https://raw.githubusercontent.com/${encodePath(studioConfig.repository)}/${encodePath(studioConfig.branch)}/${encodePath(path.startsWith("/") ? `public${path}` : path)}`;
  }
  async organizePost(file: RemoteFile, category: CategoryId, tags: string[]) {
    const source = updatePostOrganization(
      await this.readFile(file),
      category,
      tags
    );
    return this.changePost(
      file,
      source,
      `docs(studio): organize ${file.path.split("/").pop()}`
    );
  }
  async deletePost(file: RemoteFile) {
    return this.changePost(
      file,
      null,
      `docs(studio): delete ${file.path.split("/").pop()}`
    );
  }
  private async changePost(
    file: RemoteFile,
    source: string | null,
    message: string
  ) {
    if (
      !file.path.startsWith(`${studioConfig.postsDirectory}/`) ||
      !file.path.endsWith(".md") ||
      file.path.split("/").includes("..")
    )
      throw new Error("文章路径无效。");
    let snapshot = await this.snapshot();
    const assertUnchanged = () => {
      if (
        snapshot.files.find(item => item.path === file.path)?.sha !== file.sha
      )
        throw new GitHubError(
          "其他设备已更新或删除这篇文章，请刷新文章库后重试。",
          409
        );
    };
    assertUnchanged();
    const sha =
      source === null
        ? null
        : (
            await this.request<{ sha: string }>(
              `${this.base}/git/blobs`,
              "POST",
              { content: source, encoding: "utf-8" }
            )
          ).sha;
    for (let attempt = 0; attempt < 2; attempt++) {
      const tree = await this.request<{ sha: string }>(
        `${this.base}/git/trees`,
        "POST",
        {
          base_tree: snapshot.tree,
          tree: [{ path: file.path, mode: "100644", type: "blob", sha }],
        }
      );
      const commit = await this.request<{ sha: string }>(
        `${this.base}/git/commits`,
        "POST",
        {
          message,
          tree: tree.sha,
          parents: [snapshot.head],
        }
      );
      try {
        await this.request(
          `${this.base}/git/refs/heads/${encodePath(studioConfig.branch)}`,
          "PATCH",
          { sha: commit.sha, force: false }
        );
        return {
          sha,
          url: `https://github.com/${studioConfig.repository}/commit/${commit.sha}`,
        };
      } catch (error) {
        if (
          !(error instanceof GitHubError) ||
          ![409, 422].includes(error.status) ||
          attempt > 0
        )
          throw error;
        snapshot = await this.snapshot();
        assertUnchanged();
      }
    }
    throw new Error("修改未完成，请刷新后重试。");
  }
  async publish(
    doc: WritingDocument,
    assets: WritingAsset[],
    progress: (text: string) => void
  ) {
    if (!doc.title.trim()) throw new Error("先给这篇记录起一个标题。");
    if (!Number.isFinite(new Date(doc.pubDatetime).getTime()))
      throw new Error("发布时间无效。");
    const path = documentPath(doc);
    const source = serializeDocument(doc);
    progress("正在检查 GitHub 上的版本…");
    let snapshot = await this.snapshot();
    const assertUnchanged = () => {
      const current = snapshot.files.find(file => file.path === path);
      if (
        (doc.remoteSha && current?.sha !== doc.remoteSha) ||
        (!doc.remoteSha && current)
      )
        throw new GitHubError(
          "其他设备已更新这篇文章，或文件名已被使用。请保留本机草稿并重新载入 GitHub 版本。",
          409
        );
    };
    assertUnchanged();
    const tree: { path: string; mode: string; type: string; sha: string }[] =
      [];
    const referenced = referencedMedia(doc);
    for (const asset of assets.filter(item => referenced.has(item.path))) {
      if (snapshot.files.some(file => file.path === asset.path)) continue;
      if (
        ![studioConfig.mediaDirectory, studioConfig.documentsDirectory].some(
          directory => asset.path.startsWith(`${directory}/`)
        ) ||
        asset.path.includes("..")
      )
        throw new Error("附件路径无效。");
      progress(`正在上传附件 ${tree.length + 1}…`);
      const blob = await this.request<{ sha: string }>(
        `${this.base}/git/blobs`,
        "POST",
        { content: await blobBase64(asset.blob), encoding: "base64" }
      );
      tree.push({
        path: asset.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }
    const article = await this.request<{ sha: string }>(
      `${this.base}/git/blobs`,
      "POST",
      { content: source, encoding: "utf-8" }
    );
    tree.push({ path, mode: "100644", type: "blob", sha: article.sha });
    for (let attempt = 0; attempt < 2; attempt++) {
      progress("正在提交文章与图片…");
      const newTree = await this.request<{ sha: string }>(
        `${this.base}/git/trees`,
        "POST",
        { base_tree: snapshot.tree, tree }
      );
      const commit = await this.request<{ sha: string; html_url?: string }>(
        `${this.base}/git/commits`,
        "POST",
        {
          message: `docs(studio): ${doc.draft ? "save draft" : "publish"} ${doc.title.trim()}`,
          tree: newTree.sha,
          parents: [snapshot.head],
        }
      );
      try {
        await this.request(
          `${this.base}/git/refs/heads/${encodePath(studioConfig.branch)}`,
          "PATCH",
          { sha: commit.sha, force: false }
        );
        return {
          path,
          sha: article.sha,
          commit: commit.sha,
          url: `https://github.com/${studioConfig.repository}/commit/${commit.sha}`,
        };
      } catch (error) {
        if (
          !(error instanceof GitHubError) ||
          ![409, 422].includes(error.status) ||
          attempt > 0
        )
          throw error;
        snapshot = await this.snapshot();
        assertUnchanged();
      }
    }
    throw new Error("同步未完成，请重试。");
  }
}
