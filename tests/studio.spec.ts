import { test, expect, type Page, type Route } from "@playwright/test";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

const repository = "/repos/LYF0422/LYF0422.github.io";
const token = "test-session-token-not-a-real-secret";
const bangumiProxy =
  "https://lyf0422-github-io.yifan-liu-51f.workers.dev/api/bangumi";
const seedPath = "src/content/posts/remote-note.md";
const seedSource =
  "---\ntitle: 远端记录\ndescription: 一篇测试记录\npubDatetime: 2026-10-01T12:00:00+08:00\ncategory: anime\ndraft: true\ntags: [anime]\n---\n\n原始正文。\n";
const hash = (value: string) => createHash("sha1").update(value).digest("hex");

async function mockGitHub(page: Page) {
  const blobs = new Map<string, { content: string; encoding: string }>();
  const seedSha = hash(seedSource);
  blobs.set(seedSha, {
    content: Buffer.from(seedSource).toString("base64"),
    encoding: "base64",
  });
  let files = new Map([
    [seedPath, seedSha],
    ["README.md", "readme-original"],
  ]);
  let head = "head-initial";
  let treeSha = "tree-initial";
  const trees = new Map<string, Map<string, string>>([
    [treeSha, new Map(files)],
  ]);
  const commits = new Map([
    [head, { tree: { sha: treeSha }, parents: [] as string[] }],
  ]);
  const calls: { method: string; path: string; data: any }[] = [];
  let counter = 0;
  const control = {
    failBlob: false,
    race: false,
    mutateArticle() {
      const source = seedSource.replace("原始正文", "来自另一台设备的更新");
      const sha = hash(source);
      blobs.set(sha, {
        content: Buffer.from(source).toString("base64"),
        encoding: "base64",
      });
      files = new Map(files);
      files.set(seedPath, sha);
      head = "head-other-device";
      treeSha = "tree-other-device";
      trees.set(treeSha, new Map(files));
      commits.set(head, { tree: { sha: treeSha }, parents: [] });
    },
    media() {
      return [...files]
        .filter(([path]) => path.startsWith("public/images/studio/"))
        .map(([path, sha]) => ({ path, base64: blobs.get(sha)!.content }));
    },
    get calls() {
      return calls;
    },
    get files() {
      return files;
    },
    source(path: string) {
      const blob = blobs.get(files.get(path)!);
      return blob
        ? Buffer.from(blob.content, "base64").toString("utf8")
        : undefined;
    },
  };
  await page.route("https://api.github.com/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = decodeURIComponent(url.pathname);
    const data = request.postDataJSON();
    calls.push({ method, path, data });
    const respond = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(body),
      });
    if (method === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
          "access-control-allow-headers": "*",
        },
      });
    expect(request.headers().authorization).toBe(`Bearer ${token}`);
    if (path === "/user") return respond({ login: "LYF0422", avatar_url: "" });
    if (path === repository)
      return respond({ permissions: { push: true }, default_branch: "main" });
    if (path === `${repository}/git/ref/heads/main`)
      return respond({ object: { sha: head } });
    if (path.startsWith(`${repository}/git/commits/`) && method === "GET")
      return respond(commits.get(path.split("/").pop()!)!);
    if (path.startsWith(`${repository}/git/trees/`) && method === "GET") {
      const entries = trees.get(path.split("/").pop()!)!;
      return respond({
        tree: [...entries].map(([path, sha]) => ({ path, sha, type: "blob" })),
        truncated: false,
      });
    }
    if (path.startsWith(`${repository}/git/blobs/`) && method === "GET")
      return respond(blobs.get(path.split("/").pop()!)!);
    if (path === `${repository}/git/blobs` && method === "POST") {
      if (control.failBlob) {
        control.failBlob = false;
        return respond({ message: "Temporary failure" }, 503);
      }
      const sha = hash(`${data.encoding}:${data.content}`);
      blobs.set(sha, {
        content:
          data.encoding === "base64"
            ? data.content
            : Buffer.from(data.content).toString("base64"),
        encoding: "base64",
      });
      return respond({ sha }, 201);
    }
    if (path === `${repository}/git/trees` && method === "POST") {
      const next = new Map(trees.get(data.base_tree));
      for (const entry of data.tree) {
        if (entry.sha === null) next.delete(entry.path);
        else next.set(entry.path, entry.sha);
      }
      const sha = `tree-created-${++counter}`;
      trees.set(sha, next);
      return respond({ sha }, 201);
    }
    if (path === `${repository}/git/commits` && method === "POST") {
      const sha = `commit-created-${++counter}`;
      commits.set(sha, { tree: { sha: data.tree }, parents: data.parents });
      return respond({ sha }, 201);
    }
    if (path === `${repository}/git/refs/heads/main` && method === "PATCH") {
      expect(data.force).toBe(false);
      if (control.race) {
        control.race = false;
        head = "head-unrelated-update";
        treeSha = "tree-unrelated-update";
        files = new Map(files);
        files.set("README.md", "readme-other-device");
        trees.set(treeSha, new Map(files));
        commits.set(head, { tree: { sha: treeSha }, parents: [] });
        return respond({ message: "Not a fast forward" }, 422);
      }
      const commit = commits.get(data.sha)!;
      if (commit.parents[0] !== head)
        return respond({ message: "Not a fast forward" }, 422);
      head = data.sha;
      treeSha = commit.tree.sha;
      files = new Map(trees.get(treeSha));
      return respond({ object: { sha: head } });
    }
    return respond(
      { message: `Unhandled test request ${method} ${path}` },
      404
    );
  });
  return control;
}

async function connect(page: Page) {
  await page.goto("/studio/");
  await expect(page.locator("#connect-dialog")).toBeVisible();
  await page.locator("#github-token").fill(token);
  await page.locator("#confirm-connect").click();
  await expect(page.locator("#connect-dialog")).not.toBeVisible();
  await expect(page.locator("#remote-documents .document-open")).toHaveCount(1);
}
async function write(
  page: Page,
  title: string,
  body = "这是一篇值得留下的记录。"
) {
  await page.locator("#document-title").fill(title);
  await page.locator(".tiptap").fill(body);
  await expect(page.locator("#save-status")).toHaveText("已自动保存在本机");
}
async function pasteImage(page: Page) {
  await page.locator(".tiptap").click();
  await page.locator(".tiptap").press("ControlOrMeta+End");
  await page.locator(".tiptap").press("Enter");
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 80;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#53674e";
    ctx.fillRect(0, 0, 120, 80);
    const blob = await new Promise<Blob>(resolve =>
      canvas.toBlob(value => resolve(value!), "image/png")
    );
    const data = new DataTransfer();
    data.items.add(new File([blob], "clipboard.png", { type: "image/png" }));
    document.querySelector(".tiptap")!.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  await expect(page.locator(".studio-image-node img")).toBeVisible();
}

function entrySource(source: string) {
  return parseYaml(source.match(/^---\n([\s\S]*?)\n---/)![1]);
}

async function mockCatalog(page: Page, options: { coverFails?: boolean } = {}) {
  const requests: string[] = [];
  const cover = await sharp({
    create: { width: 32, height: 48, channels: 3, background: "#77a572" },
  })
    .webp()
    .toBuffer();
  const subjects = [2, 4].map(type => ({
    id: type === 4 ? 200 : 100,
    type,
    name: type === 4 ? "Test Game" : "Test Anime",
    name_cn: type === 4 ? "测试游戏" : "测试动画",
    aliases: [type === 4 ? "游戏别名" : "动画别名"],
    image: `/bangumi/covers/${type === 4 ? 200 : 100}.webp`,
  }));
  await page.route("http://127.0.0.1:4322/bangumi/**", async route => {
    const url = new URL(route.request().url());
    requests.push(url.href);
    expect(route.request().headers().authorization).toBeUndefined();
    if (url.pathname.includes("/covers/"))
      return options.coverFails
        ? route.fulfill({ status: 502, body: "Cover unavailable" })
        : route.fulfill({
            status: 200,
            contentType: "image/webp",
            body: cover,
          });
    const subject = subjects.find(item =>
      url.pathname.endsWith(`/${item.id}.json`)
    );
    const data = url.pathname.endsWith("catalog.json")
      ? { version: 1, updatedAt: "2026-10-25T00:00:00Z", subjects }
      : subject
        ? {
            ...subject,
            name: subject.name_cn,
            originalName: subject.name,
            date: "2026-01-01",
            platform: subject.type === 4 ? "PC" : "TV",
            episodes: 12,
            summary: "来自 Bangumi 的作品简介。",
            facts: [
              {
                label: subject.type === 4 ? "开发" : "导演",
                value: "测试作者",
              },
            ],
          }
        : null;
    await route.fulfill({
      status: data ? 200 : 404,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  const blocked = (route: Route) => {
    requests.push(`external:${route.request().url()}`);
    return route.abort();
  };
  await page.route("https://api.bgm.tv/**", blocked);
  await page.route(`${bangumiProxy}/**`, blocked);
  await page.route("https://lain.bgm.tv/**", blocked);
  return requests;
}

test("uses only site catalog assets and uploads the subject image even with a custom cover", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  const requests = await mockCatalog(page);
  await connect(page);
  const cover = await sharp({
    create: { width: 40, height: 40, channels: 3, background: "#abcabc" },
  })
    .png()
    .toBuffer();
  await page.locator("#cover-file").setInputFiles({
    name: "my-cover.png",
    mimeType: "image/png",
    buffer: cover,
  });
  await expect(page.locator("#save-status")).toHaveText("已自动保存在本机");
  await page.locator("#quick-category").selectOption("anime");
  await page.locator("#bangumi-query").fill("100");
  await page.locator("#bangumi-search").click();
  await expect(page.locator("#bangumi-selected")).toContainText("测试动画");
  await page.locator("#publish-button").click();
  await expect(page.locator("#sync-result")).toContainText("文章与图片已提交");
  const metadata = entrySource(api.source("src/content/posts/测试动画.md")!);
  expect(metadata.entry.subject.image).toMatch(/^\/images\/studio\//);
  expect(metadata.cover).not.toBe(metadata.entry.subject.image);
  expect(api.media()).toHaveLength(2);
  expect(
    requests.every(url => url.startsWith("http://127.0.0.1:4322/bangumi/"))
  ).toBe(true);
});

test("keeps the selected subject and review when its cover cannot be downloaded", async ({
  page,
}) => {
  await mockCatalog(page, { coverFails: true });
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#quick-category").selectOption("anime");
  await page.locator("#entry-comment").fill("先记录感受，图片稍后补上。");
  await page.locator("#bangumi-query").fill("100");
  await page.locator("#bangumi-search").click();
  await expect(page.locator("#bangumi-selected")).toContainText("测试动画");
  await expect(page.locator("#bangumi-status")).toContainText("封面暂未保存");
  await expect(page.locator("#entry-comment")).toHaveValue(
    "先记录感受，图片稍后补上。"
  );
  await expect(page.locator("#save-status")).toHaveText("已自动保存在本机");
  await page.reload();
  await expect(page.locator("#bangumi-selected")).toContainText("测试动画");
  await expect(page.locator("#entry-comment")).toHaveValue(
    "先记录感受，图片稍后补上。"
  );
});

test("searches aliases and normalized names locally and reports missing works without external fallback", async ({
  page,
}) => {
  const requests = await mockCatalog(page);
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#quick-category").selectOption("anime");
  await expect(page.locator("#catalog-info")).toContainText(
    "1 部动画 / 1 部游戏"
  );
  for (const keyword of ["动画别名", "ＴＥＳＴ－ＡＮＩＭＥ"]) {
    await page.locator("#bangumi-query").fill(keyword);
    await page.locator("#bangumi-search").click();
    await expect(page.locator(".bangumi-result")).toHaveCount(1);
    await expect(page.locator(".bangumi-result")).toContainText("测试动画");
  }
  await page.locator("#bangumi-query").fill("测试游戏");
  await page.locator("#bangumi-search").click();
  await expect(page.locator("#bangumi-status")).toContainText(
    "站内暂无匹配作品"
  );
  await expect(page.locator(".bangumi-result")).toHaveCount(0);
  await page.locator("#bangumi-query").fill("https://bgm.tv/subject/999999");
  await page.locator("#bangumi-search").click();
  await expect(page.locator("#studio-error")).toContainText("站内暂未收录");
  expect(
    requests.some(url => url.includes("999999") || url.startsWith("external:"))
  ).toBe(false);
});

test("retries loading a failed catalog and ignores a detail response after switching category", async ({
  page,
}) => {
  await mockCatalog(page);
  await page.route("**/bangumi/catalog.json", route =>
    route.fulfill({ status: 503, body: "Unavailable" })
  );
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#quick-category").selectOption("anime");
  await expect(page.locator("#catalog-info")).toContainText("暂时无法加载");
  await page.unroute("**/bangumi/catalog.json");
  await page.locator("#bangumi-query").fill("测试动画");
  await page.locator("#bangumi-search").click();
  await expect(page.locator(".bangumi-result")).toHaveCount(1);
  await expect(page.locator("#catalog-info")).toContainText(
    "1 部动画 / 1 部游戏"
  );
  let respond!: () => void;
  const gate = new Promise<void>(resolve => {
    respond = resolve;
  });
  await page.route("**/bangumi/subjects/100.json", async route => {
    await gate;
    await route.fallback();
  });
  const detailRequest = page.waitForRequest("**/bangumi/subjects/100.json");
  await page.locator(".bangumi-result").click();
  await detailRequest;
  await page.locator("#quick-category").selectOption("photo");
  const detailResponse = page.waitForResponse("**/bangumi/subjects/100.json");
  respond();
  await (await detailResponse).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.locator("#gallery-fields")).toBeVisible();
  await expect(page.locator("#document-title")).toHaveValue("");
});

function testPdf(label = "Temporal models resolve ambiguity.") {
  const stream = `BT /F1 12 Tf 25 340 Td (${label}) Tj ET`;
  const second = "BT /F1 12 Tf 25 340 Td (A second page for notes.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    `<< /Length ${second.length} >>\nstream\n${second}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  return Buffer.from(
    pdf +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  );
}

test("searches Bangumi anime, saves a personal rating, and restores the metadata on another session", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  const requests = await mockCatalog(page);
  await connect(page);
  await page.locator("#quick-category").selectOption("anime");
  await page.locator("#bangumi-query").fill("测试动画");
  await page.locator("#bangumi-search").click();
  await page.locator(".bangumi-result").click();
  await expect(page.locator("#document-title")).toHaveValue("测试动画");
  await page.locator("#entry-rating").fill("8.5");
  await page.locator("#entry-status").selectOption("completed");
  await page.locator("#entry-comment").fill("值得再看一次。");
  await page.locator(".tiptap").fill("详细观后感。");
  await page.locator("#publish-button").click();
  await expect(page.locator("#sync-result")).toContainText("文章与图片已提交");
  const metadata = entrySource(api.source("src/content/posts/测试动画.md")!);
  expect(metadata.entry.subject).toMatchObject({
    id: 100,
    type: 2,
    name: "测试动画",
    facts: [{ label: "导演", value: "测试作者" }],
  });
  expect(metadata.entry).toMatchObject({
    rating: 8.5,
    comment: "值得再看一次。",
    status: "completed",
    showcase: true,
  });
  expect(requests.some(url => url.endsWith("/subjects/100.json"))).toBe(true);
  expect(
    requests.every(url => url.startsWith("http://127.0.0.1:4322/bangumi/"))
  ).toBe(true);
  expect(metadata.entry.subject.image).toMatch(/^\/images\/studio\//);
  expect(metadata.cover).toBe(metadata.entry.subject.image);
  expect(api.media()).toHaveLength(1);
  // Clear only the local article cache, then load the actual serialized GitHub file.
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open("yifan-writing-studio", 1);
      r.onsuccess = () => {
        const tx = r.result.transaction("documents", "readwrite");
        tx.objectStore("documents").clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.reload();
  await page
    .locator("#remote-documents .document-open")
    .filter({ hasText: "测试动画" })
    .click();
  await expect(page.locator("#entry-rating")).toHaveValue("8.5");
  await expect(page.locator("#bangumi-selected")).toContainText("测试动画");
  await expect(page.locator("#bangumi-selected img")).toHaveAttribute(
    "src",
    /^blob:/
  );
  await expect(page.locator("#entry-comment")).toHaveValue("值得再看一次。");
});

test("searches games with the correct Bangumi type and supports direct subject links", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  const requests = await mockCatalog(page);
  await connect(page);
  await page.locator("#quick-category").selectOption("game");
  await page.locator("#bangumi-query").fill("测试游戏");
  await page.locator("#bangumi-search").click();
  await page.locator(".bangumi-result").click();
  await expect(page.locator("#bangumi-selected")).toContainText("测试游戏");
  await page.locator("#bangumi-query").fill("https://bgm.tv/subject/200");
  await page.locator("#bangumi-query").press("Enter");
  await expect(page.locator("#bangumi-status")).toHaveText("");
  await page.locator("#entry-rating").fill("9");
  await page.locator("#entry-showcase").uncheck();
  await page.locator("#publish-button").click();
  await expect(page.locator("#sync-result")).toContainText("文章与图片已提交");
  expect(requests.some(url => url.endsWith("/subjects/200.json"))).toBe(true);
  expect(
    entrySource(api.source("src/content/posts/测试游戏.md")!).entry
  ).toMatchObject({
    showcase: false,
    rating: 9,
    subject: { type: 4, platform: "PC" },
  });
});

test("uploads, captions and reorders an album and commits all referenced photos together", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  await connect(page);
  await page.locator("#quick-category").selectOption("photo");
  await write(page, "Photo album");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 60;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#a8c789";
    ctx.fillRect(0, 0, 80, 60);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("#gallery-files").setInputFiles([
    {
      name: "first.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    },
    {
      name: "second.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    },
  ]);
  await expect(page.locator(".gallery-editor-card")).toHaveCount(2);
  await page.getByLabel("照片 1 简评").fill("第一张的光影");
  await page.getByLabel("照片 2 简评").fill("第二张的街景");
  await page
    .locator(".gallery-editor-card")
    .nth(1)
    .getByRole("button", { name: "↑", exact: true })
    .click();
  await expect(page.getByLabel("照片 1 简评")).toHaveValue("第二张的街景");
  await page
    .locator(".gallery-editor-card")
    .first()
    .getByRole("button", { name: "设为封面", exact: true })
    .click();
  await page.locator("#entry-comment").fill("十月的小相册");
  await page.locator("#publish-button").click();
  await expect(page.locator("#sync-result")).toContainText("文章与图片已提交");
  const metadata = entrySource(api.source("src/content/posts/photo-album.md")!);
  expect(
    metadata.entry.photos.map((p: { caption: string }) => p.caption)
  ).toEqual(["第二张的街景", "第一张的光影"]);
  expect(metadata.cover).toBe(metadata.entry.photos[0].src);
  expect(api.media()).toHaveLength(2);
  await page.reload();
  await expect(page.locator(".gallery-editor-card")).toHaveCount(2);
  await page.locator("#mode-preview").click();
  await expect(page.locator("#entry-preview img")).toHaveCount(2);
  await expect(page.locator("#entry-preview")).toContainText("第二张的街景");
});

test("reads arXiv beside notes, uploads a PDF, and restores the committed PDF and notes", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  await page.route("https://arxiv.org/**", route =>
    route.fulfill({ contentType: "application/pdf", body: testPdf() })
  );
  await connect(page);
  await page.locator("#quick-category").selectOption("paper-reading");
  await write(page, "Paper notes", "这篇文章的方法与我的想法。");
  await page.locator("#paper-source").fill("https://arxiv.org/abs/1810.04703");
  await page.locator("#paper-attach").click();
  await expect(
    page.locator("#paper-annotation-reader [data-pdf-reader]")
  ).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".with-paper-reader")).toBeVisible();
  await expect(page.locator("#paper-attachment-details")).not.toHaveAttribute(
    "open"
  );
  await page.locator("#paper-attachment-details > summary").click();
  await page.locator("#paper-authors").fill("Huang et al.");
  await page.locator("#entry-comment").fill("稀疏 IMU 的时序建模。");
  await page.locator("#paper-file").setInputFiles({
    name: "reading.pdf",
    mimeType: "application/pdf",
    buffer: testPdf(),
  });
  await expect(
    page.locator("#paper-annotation-reader [data-pdf-reader]")
  ).toHaveAttribute("data-ready", "true");
  await page.locator("#publish-button").click();
  await expect(page.locator("#sync-result")).toContainText("文章与图片已提交");
  const source = api.source("src/content/posts/paper-notes.md")!;
  const metadata = entrySource(source);
  expect(metadata.entry.paper).toMatchObject({
    sourceUrl: "https://arxiv.org/abs/1810.04703",
    authors: "Huang et al.",
  });
  expect(metadata.entry.paper.pdfUrl).toMatch(/^\/documents\/studio\/.+\.pdf$/);
  expect(
    [...api.files.keys()].filter(path =>
      path.startsWith("public/documents/studio/")
    )
  ).toHaveLength(1);
  expect(source).not.toContain("blob:");
  expect(source).toContain("这篇文章的方法");
  await page.reload();
  await expect(
    page.locator("#paper-annotation-reader [data-pdf-reader]")
  ).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".tiptap")).toContainText("这篇文章的方法");
  await page.locator("#paper-remove").click();
  await expect(page.locator("#paper-reader-pane")).not.toBeVisible();
});

test("retains a review after the site catalog fails and keeps the phone album within the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("https://api.bgm.tv/**", route => route.abort());
  await page.route("**/bangumi/catalog.json", route => route.abort());
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#quick-category").selectOption("anime");
  await page.locator("#entry-comment").fill("网络失败也保留的简评");
  await page.locator("#bangumi-query").fill("测试");
  await page.locator("#bangumi-search").click();
  await expect(page.locator("#studio-error")).toContainText(
    "站内作品库暂时无法加载"
  );
  await expect(page.locator("#entry-comment")).toHaveValue(
    "网络失败也保留的简评"
  );
  await page.locator("#quick-category").selectOption("photo");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
});

test("pastes and formats images, atomically publishes an Anime article, and restores local drafts", async ({
  page,
}, testInfo) => {
  const api = await mockGitHub(page);
  await connect(page);
  await write(page, "Anime studio test");
  await page.locator("#quick-category").selectOption("anime");
  await page.locator(".tiptap").press("ControlOrMeta+A");
  await page.getByRole("button", { name: "加粗", exact: true }).click();
  await expect(page.locator(".tiptap strong")).toContainText("值得留下");
  await pasteImage(page);
  await page.locator(".studio-image-node img").click();
  await page.locator("#image-width").selectOption("50");
  await page.locator("#image-caption").fill("故事里的一个瞬间");
  await page.locator("#image-alt").fill("绿色测试图片");
  await page.locator("#image-set-cover").click();
  await expect(page.locator(".studio-image-node figcaption")).toHaveText(
    "故事里的一个瞬间"
  );
  await page.locator(".tiptap").press("ControlOrMeta+End");
  await page.locator(".tiptap").press("Enter");
  await page.getByRole("button", { name: "插入表格", exact: true }).click();
  await expect(page.locator(".tiptap table tr")).toHaveCount(3);
  await page.getByRole("button", { name: "＋ 行", exact: true }).click();
  await expect(page.locator(".tiptap table tr")).toHaveCount(4);
  await page.locator("#document-line-height").selectOption("2.3");
  await page.locator("#mode-preview").click();
  await expect(page.locator("#article-preview img")).toBeVisible();
  expect(
    await page
      .locator("#article-preview img")
      .evaluate(image => (image as HTMLImageElement).naturalWidth)
  ).toBeGreaterThan(0);
  await page.locator("#mode-write").click();
  await page.locator("#publish-button").click();
  await expect(page.locator("#sync-result")).toContainText("文章与图片已提交");
  const path = "src/content/posts/anime-studio-test.md";
  const source = api.source(path)!;
  expect(source).toContain("category: anime");
  expect(source).toContain("draft: false");
  expect(source).toContain('data-width="50"');
  expect(source).toContain("故事里的一个瞬间");
  expect(source).not.toContain("blob:");
  expect(source).not.toContain(token);
  expect(source).toContain("<table");
  expect(source).toContain("line-height:2.3");
  await writeFile(
    testInfo.outputPath("published.json"),
    JSON.stringify({ source, media: api.media() })
  );
  const tree = api.calls.find(
    call => call.method === "POST" && call.path.endsWith("/git/trees")
  )!;
  expect(tree.data.tree).toHaveLength(2);
  expect(
    tree.data.tree.some((entry: { path: string }) =>
      entry.path.startsWith("public/images/studio/")
    )
  ).toBe(true);
  expect(api.files.get("README.md")).toBe("readme-original");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    token
  );
  await page.reload();
  await expect(page.locator("#document-title")).toHaveValue(
    "Anime studio test"
  );
  await expect(page.locator(".studio-image-node img")).toBeVisible();
  await expect(page.locator("#connect-dialog")).not.toBeVisible();
  await page.locator("#logout-button").click();
  expect(
    await page.evaluate(() => sessionStorage.getItem("writing-studio-session"))
  ).toBeNull();
});

test("stops when another device changed the same article and retains the local version", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  await connect(page);
  await page.locator("#remote-documents .document-open").click();
  await expect(page.locator("#document-title")).toHaveValue("远端记录");
  await page.locator(".tiptap").fill("本机尚未合并的想法");
  api.mutateArticle();
  await page.locator("#publish-button").click();
  await expect(page.locator("#studio-error")).toContainText("其他设备已更新");
  expect(api.source(seedPath)).toContain("来自另一台设备的更新");
  expect(api.calls.filter(call => call.method === "POST")).toHaveLength(0);
  await page.reload();
  await expect(page.locator(".tiptap")).toContainText("本机尚未合并的想法");
});

test("retries a racing unrelated commit without force pushing or losing other files", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  await connect(page);
  await write(page, "Unrelated race");
  api.race = true;
  await page.locator("#publish-button").click();
  await expect(page.locator("#sync-result")).toContainText("文章与图片已提交");
  expect(api.files.get("README.md")).toBe("readme-other-device");
  expect(api.source("src/content/posts/unrelated-race.md")).toContain(
    "值得留下"
  );
  const updates = api.calls.filter(call => call.method === "PATCH");
  expect(updates).toHaveLength(2);
  expect(updates.every(call => call.data.force === false)).toBe(true);
});

test("retains the draft after a failed upload and successfully retries", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  await connect(page);
  await write(page, "Retry record");
  api.failBlob = true;
  await page.locator("#publish-button").click();
  await expect(page.locator("#studio-error")).toContainText("503");
  expect(api.files.has("src/content/posts/retry-record.md")).toBe(false);
  await expect(page.locator(".tiptap")).toContainText("值得留下");
  await page.locator("#publish-button").click();
  await expect(page.locator("#sync-result")).toContainText("文章与图片已提交");
});

test("automatically syncs new entries as drafts", async ({ page }) => {
  const api = await mockGitHub(page);
  await connect(page);
  await page.locator("#publish-options > summary").click();
  await page.locator("#auto-sync").check();
  await page.locator("#publish-options > summary").click();
  await write(page, "Automatic draft");
  await expect(page.locator("#sync-result")).toContainText("草稿已同步", {
    timeout: 20_000,
  });
  expect(api.source("src/content/posts/automatic-draft.md")).toContain(
    "draft: true"
  );
});

test("organizes and deletes another local article from its context menu without changing the active editor", async ({
  page,
}) => {
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await write(page, "需要整理的记录", "第一篇的正文。");
  await page.locator("#new-document").click();
  await expect(page.locator("#document-title")).toHaveValue("");
  await write(page, "正在写的记录", "不要切走这篇正文。");
  const first = page
    .locator("#local-documents .document-open")
    .filter({ hasText: "需要整理的记录" });
  await first.click({ button: "right" });
  await page.getByRole("menuitem", { name: "修改分类和标签" }).click();
  await page.locator("#organize-category").selectOption("game");
  await page.locator("#organize-tags").fill("RPG，游戏, RPG");
  await page.locator("#organize-save").click();
  await expect(page.locator("#organize-dialog")).not.toBeVisible();
  await expect(page.locator("#document-title")).toHaveValue("正在写的记录");
  await expect(page.locator(".tiptap")).toContainText("不要切走");
  await first.click();
  await expect(page.locator("#quick-category")).toHaveValue("game");
  await expect(page.locator("#document-tags")).toHaveValue("RPG, 游戏");
  await page.reload();
  await expect(page.locator("#document-tags")).toHaveValue("RPG, 游戏");
  await expect(page.locator("#connect-dialog")).not.toBeVisible();
  await page
    .locator("#local-documents .document-open")
    .filter({ hasText: "正在写的记录" })
    .click();
  await expect(page.locator("#document-title")).toHaveValue("正在写的记录");
  await first.click({ button: "right" });
  page.once("dialog", dialog => dialog.accept());
  await page
    .getByRole("menuitem", { name: "删除本机记录", exact: true })
    .click();
  await expect(first).toHaveCount(0);
  await expect(page.locator("#document-title")).toHaveValue("正在写的记录");
  await page.reload();
  await expect(page.locator("#local-documents .document-open")).toHaveCount(1);
  await expect(page.locator(".tiptap")).toContainText("不要切走");
});

test("updates only the selected GitHub article's category and tags and preserves its body", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  await connect(page);
  await write(page, "当前编辑的正文", "这段文字不应该被替换。");
  await page
    .locator("#remote-documents .document-open")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "修改分类和标签" }).click();
  await expect(page.locator("#organize-tags")).toHaveValue("anime");
  await page.locator("#organize-category").selectOption("paper-reading");
  await page.locator("#organize-tags").fill("IMU, 论文");
  await page.locator("#organize-save").click();
  await expect(page.locator("#organize-dialog")).not.toBeVisible();
  const source = api.source(seedPath)!;
  expect(entrySource(source)).toMatchObject({
    category: "paper-reading",
    tags: ["IMU", "论文"],
    draft: true,
  });
  expect(source.slice(source.indexOf("\n---\n") + 5)).toBe(
    seedSource.slice(seedSource.indexOf("\n---\n") + 5)
  );
  await expect(page.locator("#document-title")).toHaveValue("当前编辑的正文");
  await expect(page.locator(".tiptap")).toContainText("不应该被替换");
});

test("deletes a GitHub article with a racing unrelated commit and retains its local draft", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  await connect(page);
  await page.locator("#remote-documents .document-open").click();
  await expect(page.locator("#document-title")).toHaveValue("远端记录");
  await page.locator("#publish-options > summary").click();
  await page.locator("#auto-sync").check();
  await page.locator("#publish-options > summary").click();
  await page.locator(".tiptap").fill("保留本机尚未同步的笔记。");
  await page
    .locator("#remote-documents .document-open")
    .click({ button: "right" });
  api.race = true;
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("menuitem", { name: "删除 GitHub 文章…" }).click();
  await expect(page.locator("#remote-documents .document-open")).toHaveCount(0);
  expect(api.files.has(seedPath)).toBe(false);
  expect(api.files.get("README.md")).toBe("readme-other-device");
  expect(api.calls.filter(call => call.method === "PATCH")).toHaveLength(2);
  await expect(page.locator(".tiptap")).toContainText("保留本机尚未同步");
  await expect(page.locator("#document-state")).toContainText("本机草稿");
  await page.locator("#publish-options > summary").click();
  await expect(page.locator("#auto-sync")).not.toBeChecked();
  await page.reload();
  await expect(page.locator(".tiptap")).toContainText("保留本机尚未同步");
});

test("refuses to delete or overwrite an article that changed on another device", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  await connect(page);
  await page
    .locator("#remote-documents .document-open")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "修改分类和标签" }).click();
  await expect(page.locator("#organize-tags")).toHaveValue("anime");
  await page.locator("#organize-tags").fill("保留的输入");
  api.mutateArticle();
  await page.locator("#organize-save").click();
  await expect(page.locator("#organize-error")).toContainText("其他设备已更新");
  await expect(page.locator("#organize-tags")).toHaveValue("保留的输入");
  await page.locator("#organize-cancel").click();
  await page
    .locator("#remote-documents .document-open")
    .click({ button: "right" });
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("menuitem", { name: "删除 GitHub 文章…" }).click();
  await expect(page.locator("#studio-error")).toContainText("其他设备已更新");
  expect(api.source(seedPath)).toContain("来自另一台设备的更新");
  expect(api.calls.filter(call => call.method !== "GET")).toHaveLength(0);
});

test("offers touch and keyboard article menus and an inline template without a right sidebar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#quick-category").selectOption("anime");
  await expect(page.locator("#bangumi-query")).toBeVisible();
  await expect(page.locator("#document-tags")).toBeVisible();
  await expect(page.locator(".studio-inspector")).toHaveCount(0);
  await write(page, "手机整理测试");
  await page.locator("#toggle-library").click();
  const more = page.getByRole("button", { name: "管理 手机整理测试" });
  await more.click();
  await expect(page.getByRole("menu", { name: "文章操作" })).toBeVisible();
  const box = await page.locator("#document-menu").boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await page.locator("#local-documents .document-open").press("Shift+F10");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#organize-dialog")).toBeVisible();
  await page.locator("#organize-category").selectOption("photo");
  await page.locator("#organize-save").click();
  await expect(page.locator("#quick-category")).toHaveValue("photo");
  await page.locator("#drawer-backdrop").click({ position: { x: 380, y: 30 } });
  await expect(page.locator("#gallery-add")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
});

test("deletes only the selected local record, cancels safely, and does not restore a pending autosave", async ({
  page,
}) => {
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await write(page, "保留的草稿", "这篇记录需要保留。");
  await page.locator("#new-document").click();
  await expect(page.locator("#document-title")).toHaveValue("");
  await write(page, "不需要的草稿", "这篇记录准备删除。");
  await expect(page.locator("#local-documents")).toContainText("不需要的草稿");
  page.once("dialog", dialog => dialog.dismiss());
  await page
    .locator("#article-options")
    .evaluate((details: HTMLDetailsElement) => {
      details.open = true;
    });
  await page.locator("#delete-local-document").click();
  await expect(page.locator("#document-title")).toHaveValue("不需要的草稿");
  await expect(page.locator("#local-documents .document-open")).toHaveCount(2);

  await page.locator("#document-title").fill("尚在等待自动保存的草稿");
  page.once("dialog", async dialog => {
    expect(dialog.message()).toContain("GitHub 和网站上的文章会保留");
    await dialog.accept();
  });
  await page
    .locator("#article-options")
    .evaluate((details: HTMLDetailsElement) => {
      details.open = true;
    });
  await page.locator("#delete-local-document").click();
  await expect(page.locator("#document-title")).toHaveValue("保留的草稿");
  await expect(page.locator("#local-documents .document-open")).toHaveCount(1);
  await page.reload();
  await expect(page.locator("#local-documents .document-open")).toHaveCount(1);
  await expect(page.locator("#document-title")).toHaveValue("保留的草稿");
  await expect(page.locator(".tiptap")).toContainText("这篇记录需要保留");
});

test("removes a local backup without deleting its GitHub article", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  await connect(page);
  await page.locator("#remote-documents .document-open").click();
  await expect(page.locator("#document-title")).toHaveValue("远端记录");
  page.once("dialog", dialog => dialog.accept());
  await page
    .locator("#article-options")
    .evaluate((details: HTMLDetailsElement) => {
      details.open = true;
    });
  await page.locator("#delete-local-document").click();
  await expect(page.locator("#local-documents")).not.toContainText("远端记录");
  await expect(page.locator("#remote-documents .document-open")).toHaveCount(1);
  expect(api.source(seedPath)).toBe(seedSource);
  expect(api.calls.filter(call => call.method !== "GET")).toHaveLength(0);
  await page.locator("#remote-documents .document-open").click();
  await expect(page.locator("#document-title")).toHaveValue("远端记录");
  await expect(page.locator(".tiptap")).toContainText("原始正文");
});

test("supports phone editing, settings, and a public Anime category", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await write(page, "手机记录", "在手机上也可以写下想法。");
  await page.locator("#article-options > summary").click();
  await expect(page.locator("#delete-local-document")).toBeVisible();
  await page.locator("#quick-category").selectOption("anime");
  await page.locator("#article-options > summary").click();
  await page.locator("#mode-preview").click();
  await expect(page.locator("#article-preview")).toContainText(
    "在手机上也可以"
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  await page.goto("/blog/anime/");
  await expect(page.locator("main h1")).toContainText("Anime");
  await page.goto("/");
  await expect(page.locator(".collection-anime")).toBeVisible();
});

test("highlights PDF text, saves page notes with the attachment, and restores annotations from GitHub", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  await connect(page);
  await page.locator("#quick-category").selectOption("paper-reading");
  await write(page, "Annotated paper");
  await page.locator("#paper-file").setInputFiles({
    name: "reading.pdf",
    mimeType: "application/pdf",
    buffer: testPdf(),
  });
  const reader = page.locator("#paper-annotation-reader [data-pdf-reader]");
  await expect(reader).toHaveAttribute("data-ready", "true");
  const text = reader
    .locator(".textLayer span")
    .filter({ hasText: "Temporal models" });
  await expect(text).toBeVisible();
  await text.evaluate(span => {
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await reader.locator("[data-pdf-highlight]").click();
  await expect(reader.locator(".pdf-mark")).toHaveCount(1);
  await reader.locator(".pdf-note textarea").fill("时序信息用于消除姿态歧义。");
  await reader.locator("[data-pdf-next]").click();
  await expect(reader.locator(".textLayer")).toContainText("A second page");
  await expect(reader).toHaveAttribute("data-ready", "true");
  await reader.locator("[data-pdf-page-note]").click();
  await reader
    .locator(".pdf-note textarea")
    .nth(1)
    .fill("这里需要补充对比实验。");
  await page.locator("#publish-button").click();
  await expect(page.locator("#sync-result")).toContainText("文章与图片已提交");
  const metadata = entrySource(
    api.source("src/content/posts/annotated-paper.md")!
  );
  expect(metadata.entry.paper.annotations).toHaveLength(2);
  expect(metadata.entry.paper.annotations[0]).toMatchObject({
    page: 1,
    kind: "highlight",
    quote: "Temporal models resolve ambiguity.",
    text: "时序信息用于消除姿态歧义。",
  });
  expect(metadata.entry.paper.annotations[1]).toMatchObject({
    page: 2,
    kind: "note",
    text: "这里需要补充对比实验。",
  });
  expect(metadata.entry.paper.annotations[0].documentId).toMatch(
    /^[a-f0-9]{64}$/
  );
  expect(metadata.entry.paper.annotations[0].rects[0].width).toBeGreaterThan(
    0.1
  );
  await page.evaluate(async () => {
    await new Promise<void>(resolve => {
      const request = indexedDB.open("yifan-writing-studio", 1);
      request.onsuccess = () => {
        const tx = request.result.transaction("documents", "readwrite");
        tx.objectStore("documents").clear();
        tx.oncomplete = () => {
          request.result.close();
          resolve();
        };
      };
    });
  });
  await page.reload();
  await page
    .locator("#remote-documents .document-open")
    .filter({ hasText: "annotated-paper" })
    .click();
  await expect(reader).toHaveAttribute("data-ready", "true");
  await expect(reader.locator(".pdf-note textarea").first()).toHaveValue(
    "时序信息用于消除姿态歧义。"
  );
  await expect(reader.locator(".pdf-mark")).toHaveCount(1);
  await reader.locator("[data-pdf-zoom]").selectOption("2");
  await expect(reader).toHaveAttribute("data-ready", "true");
  const rect = await reader.locator(".pdf-mark").evaluate(mark => ({
    left: (mark as HTMLElement).style.left,
    width: (mark as HTMLElement).style.width,
  }));
  expect(parseFloat(rect.width) / 100).toBeCloseTo(
    metadata.entry.paper.annotations[0].rects[0].width,
    4
  );
  await reader
    .getByRole("button", { name: "第 2 页 · 批注", exact: true })
    .click();
  await expect(reader.locator("[data-pdf-page]")).toHaveValue("2");
  await expect(reader.locator(".pdf-pin")).toHaveCount(1);
  const markup = await reader.evaluate(node => node.outerHTML);
  await page.route("**/documents/studio/public-reading.pdf", route =>
    route.fulfill({ contentType: "application/pdf", body: testPdf() })
  );
  await page.goto("/posts/sjtuzl-人工智能就业分析/");
  await page.evaluate(
    ({ markup, annotations }) => {
      const container = document.createElement("div");
      container.dataset.paperPdf = "/documents/studio/public-reading.pdf";
      container.dataset.paperAnnotations = JSON.stringify(annotations);
      container.innerHTML = markup;
      document.querySelector(".article-main")!.prepend(container);
      document.dispatchEvent(new Event("astro:page-load"));
    },
    { markup, annotations: metadata.entry.paper.annotations }
  );
  const publicReader = page.locator("[data-paper-pdf] [data-pdf-reader]");
  await expect(publicReader).toHaveAttribute("data-ready", "true");
  await expect(publicReader.locator(".pdf-note")).toHaveCount(2);
  await expect(publicReader.locator(".pdf-note").first()).toContainText(
    "时序信息用于消除姿态歧义。"
  );
  await expect(publicReader.locator(".pdf-tools")).toBeHidden();
  await expect(publicReader.locator("textarea")).toHaveCount(0);
  await expect(publicReader.getByRole("button", { name: /^删除/ })).toHaveCount(
    0
  );
  await publicReader
    .getByRole("button", { name: "第 2 页 · 批注", exact: true })
    .click();
  await expect(publicReader.locator(".pdf-pin")).toHaveCount(1);
});

test("supports region and position annotations on a phone and keeps marks bound to the right PDF", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#quick-category").selectOption("paper-reading");
  await page.locator("#paper-file").setInputFiles({
    name: "scan.pdf",
    mimeType: "application/pdf",
    buffer: testPdf(),
  });
  const reader = page.locator("#paper-annotation-reader [data-pdf-reader]");
  await expect(reader).toHaveAttribute("data-ready", "true");
  await reader.locator("[data-pdf-region]").click();
  await reader.locator(".pdf-sheet").scrollIntoViewIfNeeded();
  const box = (await reader.locator(".pdf-sheet").boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 35);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 70, { steps: 5 });
  await page.mouse.up();
  await expect(reader.locator(".pdf-note")).toHaveCount(1);
  await reader.locator(".pdf-note textarea").fill("框选图中的方法。");
  await reader.locator("[data-pdf-note]").click();
  await reader.locator(".pdf-sheet").click({ position: { x: 70, y: 100 } });
  await expect(reader.locator(".pdf-note")).toHaveCount(2);
  await reader.locator(".pdf-note textarea").nth(1).fill("图示位置的批注。");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  await page.locator("#paper-attachment-details > summary").click();
  await page.locator("#paper-file").setInputFiles({
    name: "different.pdf",
    mimeType: "application/pdf",
    buffer: testPdf("Different document content."),
  });
  await expect(reader).toHaveAttribute("data-ready", "true");
  await expect(reader.locator(".pdf-note")).toHaveCount(0);
  await expect(reader.locator(".pdf-annotations")).toContainText(
    "其他版本 PDF 的批注已保留"
  );
  await page.locator("#paper-attachment-details > summary").click();
  await page.locator("#paper-file").setInputFiles({
    name: "scan-again.pdf",
    mimeType: "application/pdf",
    buffer: testPdf(),
  });
  await expect(reader).toHaveAttribute("data-ready", "true");
  await expect(reader.locator(".pdf-note textarea").first()).toHaveValue(
    "框选图中的方法。"
  );
  await reader.getByRole("button", { name: "删除第 1 页批注" }).first().click();
  await expect(reader.locator(".pdf-note")).toHaveCount(1);
  await expect(page.locator("#save-status")).toHaveText("已自动保存在本机");
  await page.reload();
  await expect(reader).toHaveAttribute("data-ready", "true");
  await expect(reader.locator(".pdf-note")).toHaveCount(1);
  await expect(reader.locator(".pdf-note textarea")).toHaveValue(
    "图示位置的批注。"
  );
});

test("explains inaccessible PDF links and recovers by uploading without losing the written notes", async ({
  page,
}) => {
  await page.route("https://example.org/paper.pdf", route => route.abort());
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#quick-category").selectOption("paper-reading");
  await page.locator(".tiptap").fill("先记下实验结果。");
  await page.locator("#paper-source").fill("https://example.org/paper.pdf");
  await page.locator("#paper-attach").click();
  const reader = page.locator("#paper-annotation-reader [data-pdf-reader]");
  await expect(reader.locator("[data-pdf-status]")).toContainText(
    "请上传可正常打开的 PDF"
  );
  await page.locator("#paper-attachment-details > summary").click();
  await page.locator("#paper-file").setInputFiles({
    name: "reading.pdf",
    mimeType: "application/pdf",
    buffer: testPdf(),
  });
  await expect(reader).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".tiptap")).toContainText("先记下实验结果。");
});
