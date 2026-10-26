import { studioConfig } from "@/data/studio";
import {
  documentPath,
  referencedMedia,
  serializeDocument,
  updatePostOrganization,
  type WritingAsset,
  type WritingDocument,
} from "./model";
import {
  arxivPath,
  checkPaperDigest,
  validCachedPaper,
  type ImportedPaper,
} from "./paper-imports";
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
    data?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        method,
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(data ? { "Content-Type": "application/json" } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(45_000)])
          : AbortSignal.timeout(45_000),
      });
    } catch {
      signal?.throwIfAborted();
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
  /** A Contents-only token can enqueue a request; the workflow downloads public arXiv PDFs. */
  async importArxiv(
    id: string,
    signal: AbortSignal,
    progress: (message: string) => void
  ): Promise<ImportedPaper> {
    const path = arxivPath(id);
    const requestId = crypto.randomUUID();
    progress("正在提交 GitHub 获取任务…");
    await this.request(
      `${this.base}/contents/.paper-imports/requests/${requestId}.json`,
      "PUT",
      {
        message: `data(paper): request arXiv ${id}`,
        branch: studioConfig.branch,
        content: btoa(JSON.stringify({ version: 1, id, requestId })),
      },
      signal
    );
    progress("GitHub 正在获取论文，通常需要 1–3 分钟；可以继续填写信息。");
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 4_000);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      let result: { content: string; encoding: string };
      try {
        result = await this.request(
          `${this.base}/contents/.paper-imports/results/${requestId}.json?ref=${encodePath(studioConfig.branch)}`,
          "GET",
          undefined,
          signal
        );
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) continue;
        throw error;
      }
      if (result.encoding !== "base64")
        throw new Error("GitHub 返回的获取结果编码无效。");
      const item = JSON.parse(utf8FromBase64(result.content));
      if (item.id !== id || item.requestId !== requestId)
        throw new Error("GitHub 返回的论文与请求不匹配。");
      if (item.error)
        throw new Error(
          `GitHub 获取失败：${String(item.error).slice(0, 300)} 可重试或上传 PDF。`
        );
      const blobSha = item.blobSha;
      if (!validCachedPaper(item, id) || !/^[a-f0-9]{40}$/.test(blobSha))
        throw new Error("GitHub 返回的论文信息无效。");
      progress("论文已获取，正在传回工作台…");
      const data = await this.request<{ content: string; encoding: string }>(
        `${this.base}/git/blobs/${blobSha}`,
        "GET",
        undefined,
        signal
      );
      if (data.encoding !== "base64")
        throw new Error("无法读取 GitHub 中的 PDF。");
      const bytes = Uint8Array.from(
        atob(data.content.replace(/\s/g, "")),
        char => char.charCodeAt(0)
      );
      if (bytes.length !== item.size)
        throw new Error("GitHub 中的 PDF 大小与记录不一致。");
      const blob = new Blob([bytes], { type: "application/pdf" });
      await checkPaperDigest(blob, item.sha256);
      signal.throwIfAborted();
      return { path, blob, size: item.size, sha256: item.sha256 };
    }
    throw new Error(
      "GitHub 获取尚未完成。请稍后重试或查看获取进度；已填写的信息保留。"
    );
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
