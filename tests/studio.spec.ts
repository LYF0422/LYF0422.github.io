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

test.beforeEach(async ({ page }) => {
  await page.route("https://api.crossref.org/works/**", route => route.fulfill({status:404,contentType:"application/json",body:"{}"}));
  // Keep all tests independent of the site's evolving public paper cache.
  await page.route("**/documents/studio/arxiv/index.json", route => route.fulfill({
    contentType: "application/json", body: JSON.stringify({version:1,papers:{}}),
  }));
});

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
    addPost(path: string, source: string) {
      const sha = hash(source);
      blobs.set(sha, {
        content: Buffer.from(source).toString("base64"),
        encoding: "base64",
      });
      files.set(path, sha);
      trees.set(treeSha, new Map(files));
    },
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

function scholarlyPdf(embedded = true, padding = 0, xmp = "") {
  const lines = [
    [20, 735, "Learning Motion from Sparse Sensors"],
    [11, 705, "Alice Example, Bob Researcher"],
    [9, 685, "Published 2024 - DOI: 10.1234/sparse.2024"],
    [12, 650, "Abstract"],
    [
      10,
      630,
      "We study temporal models for motion estimation from sparse sensors.",
    ],
    [
      10,
      615,
      "A controlled comparison evaluates accuracy and computational cost.",
    ],
    [12, 580, "1 Introduction"],
    ...Array.from({ length: 22 }, (_, i) => [
      10,
      560 - i * 18,
      "Temporal context improves motion estimation under sparse observations.",
    ]),
  ];
  const stream = lines
    .map(([size, y, text]) => `BT /F1 ${size} Tf 45 ${y} Td (${text}) Tj ET`)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Title (Learning Motion from Sparse Sensors) /Author (Alice Example, Bob Researcher) /Keywords (motion estimation; sparse sensors) >>",
  ];
  if (xmp) {
    objects[0] = "<< /Type /Catalog /Pages 2 0 R /Metadata 7 0 R >>";
    objects.push(`<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xmp)} >>\nstream\n${xmp}\nendstream`);
  }
  if (padding) objects.push(`<< /Length ${padding} >>\nstream\n${" ".repeat(padding)}\nendstream`);
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
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${embedded ? "/Info 6 0 R" : ""} >>\nstartxref\n${start}\n%%EOF\n`
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
  if (!await page.locator("#writing-paper").isVisible()) await page.locator("#paper-notes-toggle").click();
  await page.locator("#paper-settings-toggle").click();
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
  if (!await page.locator("#writing-paper").isVisible()) await page.locator("#paper-notes-toggle").click();
  await page.locator("#paper-settings-toggle").click();
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
  await expect(page.locator("#entry-dialog")).toBeVisible();
  await page.locator("#entry-dialog-name").fill("新记录");
  await page.locator("#entry-dialog-save").click();
  await expect(page.locator("#entry-dialog")).toBeHidden();
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
  await expect(page.locator("#entry-dialog")).toBeVisible();
  await page.locator("#entry-dialog-name").fill("新记录");
  await page.locator("#entry-dialog-save").click();
  await expect(page.locator("#entry-dialog")).toBeHidden();
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

test("extracts PDF paper information, collapses import controls, and saves editable metadata", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  await connect(page);
  await page.locator("#quick-category").selectOption("paper-reading");
  await page.locator("#paper-file").setInputFiles({
    name: "download-123.pdf",
    mimeType: "application/pdf",
    buffer: scholarlyPdf(),
  });
  await expect(page.locator("#document-title")).toHaveValue(
    "Learning Motion from Sparse Sensors"
  );
  await expect(page.locator("#document-description")).toHaveValue(
    /We study temporal models/
  );
  await expect(page.locator("#paper-authors")).toHaveValue(
    "Alice Example, Bob Researcher"
  );
  await expect(page.locator("#paper-year")).toHaveValue("2024");
  await expect(page.locator("#paper-doi")).toHaveValue("10.1234/sparse.2024");
  await expect(page.locator("#paper-abstract")).toHaveValue(
    /controlled comparison/
  );
  await expect(page.locator("#paper-source")).toBeHidden();
  await expect(page.locator("#entry-comment")).toBeHidden();
  await expect(page.locator("#paper-settings-toggle")).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  if (!await page.locator("#writing-paper").isVisible()) await page.locator("#paper-notes-toggle").click();
  await page.locator("#paper-settings-toggle").click();
  await expect(page.locator("#paper-authors")).toBeVisible();
  await page.locator("#paper-authors").fill("My corrected author list");
  await page.locator("#paper-year").fill("");
  await page.locator("#document-tags").fill("");
  await page.locator("#document-title").fill("My reading notes");
  await page.locator("#document-description").fill("My own introduction.");
  if (!await page.locator("#writing-paper").isVisible()) await page.locator("#paper-notes-toggle").click();
  await page.locator("#paper-settings-toggle").click();
  await page.locator("#publish-button").click();
  await expect(page.locator("#sync-result")).toContainText("文章与图片已提交");
  const metadata = entrySource(
    api.source("src/content/posts/my-reading-notes.md")!
  );
  expect(metadata.entry.paper).toMatchObject({
    title: "Learning Motion from Sparse Sensors",
    authors: "My corrected author list",
    year: "",
    doi: "10.1234/sparse.2024",
  });
  await page.reload();
  await expect(page.locator("[data-pdf-reader]")).toHaveAttribute(
    "data-ready",
    "true"
  );
  await expect(page.locator("#document-title")).toHaveValue("My reading notes");
  await expect(page.locator("#document-description")).toHaveValue(
    "My own introduction."
  );
  await expect(page.locator("#paper-authors")).toHaveValue(
    "My corrected author list"
  );
  await expect(page.locator("#paper-year")).toHaveValue("");
  await expect(page.locator("#document-tags")).toHaveValue("");
});

test("infers a paper title and authors from the first page while preserving a custom blog title", async ({
  page,
}) => {
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#quick-category").selectOption("paper-reading");
  await page.locator("#document-title").fill("My existing title");
  await page.locator("#paper-file").setInputFiles({
    name: "scan-name.pdf",
    mimeType: "application/pdf",
    buffer: scholarlyPdf(false),
  });
  await expect(page.locator("#paper-authors")).toHaveValue(
    "Alice Example, Bob Researcher"
  );
  await expect(page.locator("#document-title")).toHaveValue(
    "My existing title"
  );
  await expect(page.locator("#paper-metadata-status")).toContainText(
    "已自动读取"
  );
  await page.locator("#paper-notes-toggle").click();
  await page.locator("#document-title").fill("");
  await page.locator("#paper-file").setInputFiles({
    name: "another-download.pdf",
    mimeType: "application/pdf",
    buffer: scholarlyPdf(false),
  });
  await expect(page.locator("#document-title")).toHaveValue(
    "Learning Motion from Sparse Sensors"
  );
});

test("keeps PDF selection aligned with canvas glyphs through zoom and large-screen reading", async ({
  page,
}) => {
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#quick-category").selectOption("paper-reading");
  await page.locator("#paper-file").setInputFiles({
    name: "reading.pdf",
    mimeType: "application/pdf",
    buffer: testPdf(),
  });
  const reader = page.locator("#paper-annotation-reader [data-pdf-reader]");
  await expect(reader).toHaveAttribute("data-ready", "true");
  const aligned = async (scope: typeof reader) => {
    const metrics = await scope.evaluate(root => {
      const canvas = root.querySelector("canvas")!;
      const sheet = root.querySelector(".pdf-sheet")!.getBoundingClientRect();
      const span = root
        .querySelector(".textLayer span")!
        .getBoundingClientRect();
      const data = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let left = canvas.width,
        right = 0,
        top = canvas.height,
        bottom = 0;
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          const index = (y * canvas.width + x) * 4;
          if (
            data[index] < 160 &&
            data[index + 1] < 160 &&
            data[index + 2] < 160
          ) {
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      const ratio = canvas.width / sheet.width;
      return {
        density: ratio,
        selectionLeft: span.left - sheet.left,
        selectionRight: span.right - sheet.left,
        selectionTop: span.top - sheet.top,
        selectionBottom: span.bottom - sheet.top,
        glyphLeft: left / ratio,
        glyphRight: right / ratio,
        glyphTop: top / ratio,
        glyphBottom: bottom / ratio,
      };
    });
    expect(metrics.density).toBeGreaterThanOrEqual(1.49);
    expect(Math.abs(metrics.selectionLeft - metrics.glyphLeft)).toBeLessThan(4);
    // The selection includes glyph side bearings, which scale with the text.
    expect(Math.abs(metrics.selectionRight - metrics.glyphRight)).toBeLessThan(
      Math.max(4, (metrics.glyphRight - metrics.glyphLeft) * 0.01)
    );
    expect(metrics.selectionTop).toBeLessThan(metrics.glyphTop + 3);
    expect(metrics.selectionBottom).toBeGreaterThan(metrics.glyphBottom - 3);
  };
  await aligned(reader);
  for (const zoom of ["1.5", "2"]) {
    await reader.locator("[data-pdf-zoom]").selectOption(zoom);
    await expect(reader).toHaveAttribute("data-ready", "true");
    await aligned(reader);
  }
  await reader.locator("[data-pdf-zoom]").selectOption("1");
  await expect(reader).toHaveAttribute("data-ready", "true");
  const inlineWidth = (await reader.locator(".pdf-sheet").boundingBox())!.width;
  await reader.locator("[data-pdf-expand]").click();
  const expanded = page.locator(".pdf-reader-dialog [data-pdf-reader]");
  await expect(
    page.getByRole("dialog", { name: "PDF 大屏阅读" })
  ).toBeVisible();
  await expect
    .poll(
      async () => (await expanded.locator(".pdf-sheet").boundingBox())!.width
    )
    .toBeGreaterThan(inlineWidth + 100);
  await expect(expanded).toHaveAttribute("data-ready", "true");
  await aligned(expanded);
  await expanded.locator("[data-pdf-page-note]").click();
  await expanded
    .locator(".pdf-note textarea")
    .fill("Notes written while reading in the large view.");
  await expanded.locator("[data-pdf-clear]").click();
  await expanded.locator("[data-pdf-expand]").click();
  await expect(page.locator(".pdf-reader-dialog")).toHaveCount(0);
  await expect(reader.locator(".pdf-note textarea")).toHaveValue(
    "Notes written while reading in the large view."
  );
  await reader.locator("[data-pdf-expand]").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".pdf-reader-dialog")).toHaveCount(0);
  await expect(reader.locator("[data-pdf-expand]")).toBeFocused();
});

test("selects PDF highlights on the page to delete them and can undo a deletion", async ({
  page,
}) => {
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#quick-category").selectOption("paper-reading");
  await page.locator("#paper-file").setInputFiles({
    name: "reading.pdf",
    mimeType: "application/pdf",
    buffer: testPdf(),
  });
  const reader = page.locator("[data-pdf-reader]");
  await expect(reader).toHaveAttribute("data-ready", "true");
  await reader
    .locator(".textLayer span")
    .first()
    .evaluate(span => {
      const range = document.createRange();
      range.selectNodeContents(span);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await reader.locator("[data-pdf-highlight]").click();
  await reader.locator(".pdf-note textarea").fill("Keep this annotation.");
  await reader.locator("[data-pdf-clear]").click();
  await reader.locator(".textLayer span").first().scrollIntoViewIfNeeded();
  const mark = (await reader.locator(".pdf-mark").boundingBox())!;
  await page.mouse.click(mark.x + mark.width / 2, mark.y + mark.height / 2);
  await expect(reader.locator("[data-pdf-delete]")).toBeVisible();
  await reader.locator("[data-pdf-delete]").click();
  await expect(reader.locator(".pdf-note")).toHaveCount(0);
  await reader.locator("[data-pdf-undo]").click();
  await expect(reader.locator(".pdf-note textarea")).toHaveValue(
    "Keep this annotation."
  );
  await reader.getByRole("button", { name: "删除第 1 页批注" }).click();
  await expect(reader.locator(".pdf-mark")).toHaveCount(0);
  await expect(page.locator("#save-status")).toHaveText("已自动保存在本机");
  await page.reload();
  await expect(reader).toHaveAttribute("data-ready", "true");
  await expect(reader.locator(".pdf-note")).toHaveCount(0);
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
  if (!await page.locator("#writing-paper").isVisible()) await page.locator("#paper-notes-toggle").click();
  await page.locator("#paper-settings-toggle").click();
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
  if (!await page.locator("#writing-paper").isVisible()) await page.locator("#paper-notes-toggle").click();
  await page.locator("#paper-settings-toggle").click();
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
    "浏览器未能下载 PDF"
  );
  if (!await page.locator("#writing-paper").isVisible()) await page.locator("#paper-notes-toggle").click();
  await page.locator("#paper-settings-toggle").click();
  await page.locator("#paper-file").setInputFiles({
    name: "reading.pdf",
    mimeType: "application/pdf",
    buffer: testPdf(),
  });
  await expect(reader).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".tiptap")).toContainText("先记下实验结果。");
});

test("opens the article's edit link in the studio and loads that article after connecting", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  await page.goto("/posts/sjtuzl-人工智能就业分析/");
  const edit = page.getByRole("link", { name: "编辑文章", exact: true });
  const href = (await edit.getAttribute("href"))!;
  const target = new URL(href, "http://127.0.0.1:4322");
  const path = target.searchParams.get("edit")!;
  expect(target.pathname).toBe("/studio/");
  expect(path).toBe("src/content/posts/sjtuzl-人工智能就业分析.md");
  await expect(edit).not.toHaveAttribute("target", "_blank");
  await expect(edit).toHaveAttribute("data-astro-reload");
  api.addPost(path, seedSource.replace("远端记录", "从文章页继续编辑"));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(edit).toBeVisible();
  await edit.click();
  await expect(page).toHaveURL(/\/studio\/\?edit=/);
  await expect(page.locator("#connect-dialog")).toBeVisible();
  await page.locator("#github-token").fill(token);
  await page.locator("#confirm-connect").click();
  await expect(page.locator("#document-title")).toHaveValue("从文章页继续编辑");
  await expect(page.locator(".tiptap")).toContainText("原始正文");
  await expect(page).toHaveURL("http://127.0.0.1:4322/studio/");
  expect(api.calls.every(call => call.method === "GET")).toBe(true);
});

test("opens a requested article with a saved session while preserving the current draft", async ({
  page,
}) => {
  await mockGitHub(page);
  await connect(page);
  await write(page, "尚未发布的草稿", "返回文章编辑前写下的内容。");
  await page.goto(`/studio/?edit=${encodeURIComponent(seedPath)}`);
  await expect(page.locator("#document-title")).toHaveValue("远端记录");
  await expect(page.locator("#connect-dialog")).not.toBeVisible();
  await expect(page.locator("#local-documents")).toContainText(
    "尚未发布的草稿"
  );
  await expect(page).toHaveURL("http://127.0.0.1:4322/studio/");
});

test("prefers unsynchronized local changes when entering an article's edit link", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  await connect(page);
  await page.locator("#remote-documents .document-open").click();
  await expect(page.locator("#document-title")).toHaveValue("远端记录");
  await write(page, "本机尚未同步的标题", "保留本机修改。");
  await page.evaluate(() =>
    sessionStorage.removeItem("writing-studio-session")
  );
  const calls = api.calls.length;
  await page.goto(`/studio/?edit=${encodeURIComponent(seedPath)}`);
  await expect(page.locator("#document-title")).toHaveValue(
    "本机尚未同步的标题"
  );
  await expect(page.locator(".tiptap")).toContainText("保留本机修改");
  await expect(page.locator("#connect-dialog")).not.toBeVisible();
  expect(api.calls.slice(calls)).toHaveLength(0);
  await expect(page).toHaveURL("http://127.0.0.1:4322/studio/");
  await page.goto("/studio/");
  await expect(page.locator("#document-title")).toHaveValue(
    "本机尚未同步的标题"
  );
});

test("reports moved articles and rejects invalid edit paths without replacing the current draft", async ({
  page,
}) => {
  const api = await mockGitHub(page);
  await connect(page);
  await write(page, "保留的草稿");
  await page.goto("/studio/?edit=src%2Fcontent%2Fposts%2Fdeleted.md");
  await expect(page.locator("#studio-error")).toContainText("已被移动或删除");
  await expect(page.locator("#document-title")).toHaveValue("保留的草稿");
  const calls = api.calls.length;
  await page.goto("/studio/?edit=src%2Fcontent%2Fposts%2F..%2F..%2FREADME.md");
  await expect(page.locator("#studio-error")).toContainText("文章路径无效");
  await expect(page.locator("#document-title")).toHaveValue("保留的草稿");
  expect(
    api.calls.slice(calls).some(call => call.path.includes("/git/blobs/"))
  ).toBe(false);
});

test("shares canonical article URLs and returns to an internal listing", async ({
  page,
}) => {
  await page.goto("/posts/sjtuzl-人工智能就业分析/");
  const canonical = await page
    .locator('link[rel="canonical"]')
    .getAttribute("href");
  const platforms = [
    ["https://wa.me/", "text"],
    ["https://www.facebook.com/sharer.php", "u"],
    ["https://x.com/intent/post", "url"],
    ["https://t.me/share/url", "url"],
    ["https://pinterest.com/pin/create/button/", "url"],
    ["mailto:", "body"],
  ];
  for (const [prefix, parameter] of platforms) {
    const href = await page
      .locator(`a[href^="${prefix}"]`)
      .getAttribute("href");
    expect(new URL(href!).searchParams.get(parameter)).toBe(canonical);
  }
  await expect(page.locator("#back-button")).toHaveAttribute("href", "/blog/");
  await page.evaluate(() =>
    sessionStorage.setItem(
      "backUrl",
      "/search?q=%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD"
    )
  );
  await page.reload();
  await expect(page.locator("#back-button")).toHaveAttribute(
    "href",
    "/search?q=%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD"
  );
  await page.evaluate(() =>
    sessionStorage.setItem("backUrl", "https://example.org/elsewhere")
  );
  await page.reload();
  await expect(page.locator("#back-button")).toHaveAttribute("href", "/blog/");
});

test("creates a paper in a modal from an arXiv URL and reopens its cached PDF without contacting arXiv", async ({ page }) => {
  const api = await mockGitHub(page);
  let downloads = 0;
  await page.route("https://arxiv.org/**", route => {
    downloads++;
    expect(route.request().url()).toBe("https://arxiv.org/pdf/2406.07550");
    return route.fulfill({contentType:"application/pdf", body:scholarlyPdf()});
  });
  await connect(page);
  await write(page, "保留的笔记", "创建论文前的正文。");
  const before = await page.locator("#local-documents .document-open").count();
  await page.locator("#new-entry").click();
  await expect(page.locator("#entry-dialog")).toBeVisible();
  await expect(page.locator("#document-title")).toHaveValue("保留的笔记");
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-source").fill("[论文](https://arxiv.org/pdf/2406.07550)");
  await page.locator("#entry-dialog-identify").click();
  await expect(page.locator("#entry-dialog-name")).toHaveValue("Learning Motion from Sparse Sensors");
  await expect(page.locator("#entry-dialog-authors")).toHaveValue("Alice Example, Bob Researcher");
  await expect(page.locator("#entry-dialog-year")).toHaveValue("2024");
  await expect(page.locator("#entry-dialog-description")).toHaveValue(/We study temporal models/);
  await expect(page.locator("#entry-dialog-save")).toBeEnabled();
  await page.locator("#entry-dialog-save").click();
  const reader = page.locator("#paper-annotation-reader [data-pdf-reader]");
  await expect(reader).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#writing-paper")).toBeHidden();
  await expect(page.locator("#writing-toolbar")).toBeHidden();
  await expect(page.locator("#local-documents .document-open")).toHaveCount(before + 1);
  await reader.locator("[data-pdf-page-note]").click();
  await reader.locator(".pdf-note textarea").fill("批注应该保留。");
  await page.locator("#local-documents .document-open").filter({hasText:"Learning Motion"}).click({button:"right"});
  await page.getByRole("menuitem", {name:"修改文章信息…", exact:true}).click();
  await expect(page.locator("#entry-dialog-name")).toHaveValue("Learning Motion from Sparse Sensors");
  await page.locator("#entry-dialog-name").fill("修改后的论文笔记");
  await page.locator("#entry-dialog-authors").fill("Corrected Author");
  await page.locator("#entry-dialog-year").fill("");
  await page.locator("#entry-dialog-tags").fill("时序模型，IMU");
  await page.locator("#entry-dialog-save").click();
  await expect(reader).toHaveAttribute("data-ready", "true");
  await expect(reader.locator(".pdf-note textarea")).toHaveValue("批注应该保留。");
  await page.locator("#publish-button").click();
  await expect(page.locator("#sync-result")).toContainText("文章与图片已提交");
  const metadata = entrySource(api.source("src/content/posts/修改后的论文笔记.md")!);
  expect(metadata.entry.paper).toMatchObject({sourceUrl:"https://arxiv.org/abs/2406.07550", authors:"Corrected Author", year:""});
  expect(metadata.entry.paper.pdfUrl).toMatch(/^\/documents\/studio\/.+\.pdf$/);
  expect(metadata.entry.paper.annotations).toHaveLength(1);
  expect([...api.files.keys()].filter(path=>path.startsWith("public/documents/studio/"))).toHaveLength(1);
  await page.reload();
  await expect(reader).toHaveAttribute("data-ready", "true");
  await expect(reader.locator(".pdf-note textarea")).toHaveValue("批注应该保留。");
  expect(downloads).toBe(1);
  await expect(page.locator("#paper-reader-title")).toHaveText("修改后的论文笔记");
  await page.locator("#edit-entry-info").click();
  await expect(page.locator("#entry-dialog-year")).toHaveValue("");
  await page.locator("#entry-dialog-name").fill("取消的修改");
  await page.locator("#entry-dialog-cancel").click();
  await expect(page.locator("#paper-reader-title")).toHaveText("修改后的论文笔记");
});

test("keeps the active draft when paper import fails or is canceled, and accepts a PDF instead", async ({ page }) => {
  await page.route("https://arxiv.org/**", route=>route.abort());
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await write(page,"原文章", "不要更改这些内容。");
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-name").fill("手动标题");
  await page.locator("#entry-dialog-source").fill("https://arxiv.org/abs/2406.07550");
  await page.locator("#entry-dialog-identify").click();
  await expect(page.locator("#entry-dialog-error")).toContainText("浏览器未能下载 PDF");
  await expect(page.locator("#entry-dialog-name")).toHaveValue("手动标题");
  await expect(page.locator("#document-title")).toHaveValue("原文章");
  await page.locator("#entry-dialog-file").setInputFiles({name:"local-paper.pdf", mimeType:"application/pdf", buffer:scholarlyPdf()});
  await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息");
  await expect(page.locator("#entry-dialog-name")).toHaveValue("手动标题");
  await page.locator("#entry-dialog-cancel").click();
  await expect(page.locator("#local-documents .document-open")).toHaveCount(1);
  await expect(page.locator(".tiptap")).toContainText("不要更改这些内容。");
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-file").setInputFiles({name:"local-paper.pdf", mimeType:"application/pdf", buffer:scholarlyPdf()});
  await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息");
  await page.locator("#entry-dialog-save").click();
  await expect(page.locator("[data-pdf-reader]")).toHaveAttribute("data-ready","true");
  await expect(page.locator("#writing-paper")).toBeHidden();
});

test("rejects HTML returned by a PDF URL and ignores canceled downloads without creating a record", async ({ page }) => {
  await page.route("https://example.org/error.pdf", route=>route.fulfill({contentType:"text/html",body:"<html>A sign-in page</html>"}));
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-source").fill("https://example.org/error.pdf");
  await page.locator("#entry-dialog-identify").click();
  await expect(page.locator("#entry-dialog-error")).toContainText("不是 PDF 文件");
  let complete!: ()=>void;
  const gate = new Promise<void>(resolve=>complete=resolve);
  await page.route("https://example.org/slow.pdf",async route=>{await gate;await route.fulfill({contentType:"application/pdf",body:scholarlyPdf()}).catch(()=>{});});
  await page.locator("#entry-dialog-source").fill("https://example.org/slow.pdf");
  await page.locator("#entry-dialog-identify").click();
  await expect(page.locator("#entry-dialog-save")).toBeDisabled();
  await page.locator("#entry-dialog-cancel").click();
  complete();
  await page.locator("#new-entry").click();
  await expect(page.locator("#entry-dialog-name")).toHaveValue("");
  await expect(page.locator("#entry-dialog-error")).toBeHidden();
  await page.locator("#entry-dialog-category").selectOption("notes");
  await page.locator("#entry-dialog-name").fill("普通记录");
  await page.locator("#entry-dialog-save").click();
  await expect(page.locator("#document-title")).toHaveValue("普通记录");
  await expect(page.locator("#local-documents .document-open")).toHaveCount(2);
});

test("creates paper records from the dialog on a phone and restores the reader after editing metadata", async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#toggle-library").click();
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-file").setInputFiles({name:"paper.pdf",mimeType:"application/pdf",buffer:scholarlyPdf()});
  await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息");
  const dialog = page.locator("#entry-dialog");
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.locator("#entry-dialog-save").click();
  const reader=page.locator("[data-pdf-reader]");
  await expect(reader).toHaveAttribute("data-ready","true");
  await expect(page.locator("#writing-paper")).toBeHidden();
  await reader.locator("[data-pdf-page-note]").click();
  await reader.locator(".pdf-note textarea").fill("手机阅读批注。");
  await page.locator("#edit-entry-info").click();
  await page.locator("#entry-dialog-name").fill("手机上的论文笔记");
  await page.locator("#entry-dialog-save").click();
  await expect(reader).toHaveAttribute("data-ready","true");
  await expect(reader.locator(".pdf-note textarea")).toHaveValue("手机阅读批注。");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test("selects a work in the creation dialog without contacting Bangumi",async ({page})=>{
  const requests=await mockCatalog(page);
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("anime");
  await page.locator("#entry-dialog-source").fill("动画别名");
  await page.locator("#entry-dialog-identify").click();
  await page.locator("#entry-dialog-results button").click();
  await expect(page.locator("#entry-dialog-name")).toHaveValue("测试动画");
  await page.locator("#entry-dialog-save").click();
  await expect(page.locator("#bangumi-selected")).toContainText("测试动画");
  expect(requests.some(url=>url.startsWith("external:"))).toBe(false);
});

async function mockPaperImport(page: Page, options: { fail?: boolean; corrupt?: boolean } = {}) {
  const pdf = scholarlyPdf();
  const blobSha = createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${pdf.length}\0`), pdf])).digest("hex");
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  let requestId = "";
  let pollCount = 0;
  await page.route(`https://api.github.com${repository}/contents/.paper-imports/**`, async route => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    const headers = {"access-control-allow-origin":"*", "access-control-allow-methods":"GET,PUT,OPTIONS", "access-control-allow-headers":"*"};
    if (route.request().method() === "OPTIONS") return route.fulfill({status:204,headers});
    if (route.request().method() === "PUT") {
      const data = route.request().postDataJSON();
      const task = JSON.parse(Buffer.from(data.content,"base64").toString("utf8"));
      expect(task).toMatchObject({version:1,id:"2406.07550"});
      expect(data.branch).toBe("main");
      expect(Object.keys(task).sort()).toEqual(["id","requestId","version"]);
      requestId = task.requestId;
      return route.fulfill({status:201,headers,contentType:"application/json",body:JSON.stringify({commit:{sha:"request-commit"}})});
    }
    pollCount++;
    if(pollCount===1) return route.fulfill({status:404,headers,contentType:"application/json",body:JSON.stringify({message:"Not ready"})});
    const result = {id:"2406.07550",requestId,path:"/documents/studio/arxiv/2406.07550.pdf",size:pdf.length,sha256:options.corrupt ? "0".repeat(64) : sha256,blobSha,...(options.fail ? {error:"arXiv returned HTTP 503"}: {})};
    return route.fulfill({headers,contentType:"application/json",body:JSON.stringify({encoding:"base64",content:Buffer.from(JSON.stringify(result)).toString("base64")})});
  });
  await page.route(`https://api.github.com${repository}/git/blobs/${blobSha}`,route=>route.fulfill({contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify({encoding:"base64",content:pdf.toString("base64")})}));
  return { get requestId(){return requestId;} };
}

test("gets an arXiv PDF through GitHub when the browser cannot download it",async({page})=>{
  const api=await mockGitHub(page);
  const job=await mockPaperImport(page);
  await page.route("https://arxiv.org/**",route=>route.abort());
  await connect(page);
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-source").fill("https://arxiv.org/abs/2406.07550");
  await page.locator("#entry-dialog-identify").click();
  await expect(page.locator("#entry-dialog-import-error")).toBeVisible();
  await expect(page.locator("#entry-dialog-import-error")).toContainText("浏览器未能下载");
  await page.locator("#entry-dialog-github").click();
  await expect(page.locator("#entry-dialog-import-status")).toContainText("GitHub 正在获取");
  await page.locator("#entry-dialog-name").fill("保留手动填写的标题");
  await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息",{timeout:15000});
  expect(job.requestId).toMatch(/^[a-f0-9-]{36}$/);
  await expect(page.locator("#entry-dialog-name")).toHaveValue("保留手动填写的标题");
  await expect(page.locator("#entry-dialog-authors")).toHaveValue("Alice Example, Bob Researcher");
  await page.locator("#entry-dialog-save").click();
  await expect(page.locator("[data-pdf-reader]")).toHaveAttribute("data-ready","true");
  await page.locator("#publish-button").click();
  await expect(page.locator("#sync-result")).toContainText("文章与图片已提交");
  const data=entrySource(api.source("src/content/posts/保留手动填写的标题.md")!);
  expect(data.entry.paper.pdfUrl).toBe("/documents/studio/arxiv/2406.07550.pdf");
  expect([...api.files.keys()].filter(path=>path.startsWith("public/documents/studio/"))).toEqual(["public/documents/studio/arxiv/2406.07550.pdf"]);
});

test("imports cached arXiv papers from the site without any arXiv request or GitHub connection",async({page})=>{
  const pdf=scholarlyPdf();
  let arxivRequests=0;
  await page.route("https://arxiv.org/**",route=>{arxivRequests++;return route.abort();});
  await page.route("**/documents/studio/arxiv/index.json",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({version:1,papers:{"2406.07550":{path:"/documents/studio/arxiv/2406.07550.pdf",size:pdf.length,sha256:createHash("sha256").update(pdf).digest("hex")}}})}));
  await page.route("**/documents/studio/arxiv/2406.07550.pdf",route=>route.fulfill({contentType:"application/pdf",body:pdf}));
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-source").fill("https://arxiv.org/pdf/2406.07550");
  await page.locator("#entry-dialog-identify").click();
  await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息");
  await page.locator("#entry-dialog-save").click();
  await expect(page.locator("[data-pdf-reader]")).toHaveAttribute("data-ready","true");
  expect(arxivRequests).toBe(0);
});

test("connects to GitHub over the import dialog and continues without discarding entered information",async({page})=>{
  await mockGitHub(page);
  await mockPaperImport(page);
  await page.route("https://arxiv.org/**",route=>route.abort());
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-source").fill("https://arxiv.org/pdf/2406.07550");
  await page.locator("#entry-dialog-github").click();
  await expect(page.locator("#connect-dialog")).toBeVisible();
  await expect(page.locator("#entry-dialog")).toBeVisible();
  await page.locator("#github-token").fill(token);
  await page.locator("#confirm-connect").click();
  await expect(page.locator("#connect-dialog")).toBeHidden();
  await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息",{timeout:15000});
  await expect(page.locator("#entry-dialog-source")).toHaveValue("https://arxiv.org/pdf/2406.07550");
  await page.locator("#entry-dialog-save").click();
  await expect(page.locator("[data-pdf-reader]")).toHaveAttribute("data-ready","true");
});

test("shows server download failures next to the URL and preserves the article and entered title",async({page})=>{
  await mockGitHub(page);
  await mockPaperImport(page,{fail:true});
  await page.route("https://arxiv.org/**",route=>route.abort());
  await connect(page);
  await write(page,"当前文章","保留正文。");
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-name").fill("手动论文标题");
  await page.locator("#entry-dialog-source").fill("https://arxiv.org/pdf/2406.07550");
  await page.locator("#entry-dialog-github").click();
  await expect(page.locator("#entry-dialog-import-error")).toContainText("arXiv returned HTTP 503",{timeout:15000});
  await expect(page.locator("#entry-dialog-name")).toHaveValue("手动论文标题");
  await page.locator("#entry-dialog-cancel").click();
  await expect(page.locator("#document-title")).toHaveValue("当前文章");
  await expect(page.locator(".tiptap")).toContainText("保留正文。");
});

test("rejects a corrupted server PDF before saving it",async({page})=>{
  await mockGitHub(page);
  await mockPaperImport(page,{corrupt:true});
  await page.route("https://arxiv.org/**",route=>route.abort());
  await connect(page);
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-source").fill("https://arxiv.org/pdf/2406.07550");
  await page.locator("#entry-dialog-github").click();
  await expect(page.locator("#entry-dialog-import-error")).toContainText("校验未通过",{timeout:15000});
  await page.locator("#entry-dialog-cancel").click();
  await expect(page.locator("#local-documents .document-open")).toHaveCount(1);
});

for (const [source, pdf] of [
  ["<http://arxiv.org/abs/2406.07550/>", "https://arxiv.org/pdf/2406.07550"],
  ["https://arxiv.org/html/2406.07550.pdf/?download=1", "https://arxiv.org/pdf/2406.07550"],
  ["https://openaccess.thecvf.com/content/CVPR2024/html/Example_Test_CVPR_2024_paper.html", "https://openaccess.thecvf.com/content/CVPR2024/papers/Example_Test_CVPR_2024_paper.pdf"],
  ["https://papers.neurips.cc/paper_files/paper/2024/hash/example-Abstract-Conference.html", "https://papers.neurips.cc/paper_files/paper/2024/file/example-Paper-Conference.pdf"],
  ["https://proceedings.mlr.press/v235/example24a.html", "https://proceedings.mlr.press/v235/example24a/example24a.pdf"],
  ["https://aclanthology.org/2024.acl-long.1", "https://aclanthology.org/2024.acl-long.1.pdf"],
]) {
  test(`locates the PDF from a supported paper page: ${source}`, async ({ page }) => {
    let downloads = 0;
    await page.route(pdf, route => {
      downloads++;
      return route.fulfill({contentType: "application/pdf", body: scholarlyPdf()});
    });
    await page.goto("/studio/");
    await page.locator("#try-writing").click();
    await page.locator("#new-entry").click();
    await page.locator("#entry-dialog-category").selectOption("paper-reading");
    await page.locator("#entry-dialog-source").fill(source);
    await page.locator("#entry-dialog-identify").click();
    await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息");
    await expect(page.locator("#entry-dialog-name")).toHaveValue("Learning Motion from Sparse Sensors");
    await page.locator("#entry-dialog-save").click();
    await expect(page.locator("[data-pdf-reader]")).toHaveAttribute("data-ready", "true");
    expect(downloads).toBe(1);
  });
}

test("finds a paper PDF in webpage metadata without executing or loading page content", async ({ page }) => {
  const calls: string[] = [];
  await page.route("https://publisher.example/**", route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path === "/articles/example")
      return route.fulfill({contentType: "text/html", body: `
        <base href="https://unwanted.example/">
        <meta name="citation_pdf_url" content="javascript:alert(1)">
        <meta name="citation_pdf_url" content="../downloads/main?format=pdf&amp;id=123">
        <script>window.untrustedPaperScript = true</script>
        <img src="https://publisher.example/unwanted-image.png">
        <iframe src="https://publisher.example/unwanted-frame"></iframe>
        <a href="/supplement.pdf">PDF</a>
      `});
    if (path === "/downloads/main")
      return route.fulfill({contentType:"application/pdf", body:scholarlyPdf()});
    return route.abort();
  });
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-source").fill("https://publisher.example/articles/example");
  await page.locator("#entry-dialog-identify").click();
  await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息");
  await page.locator("#entry-dialog-save").click();
  await expect(page.locator("[data-pdf-reader]")).toHaveAttribute("data-ready", "true");
  expect(calls).toEqual(["/articles/example", "/downloads/main"]);
  expect(await page.evaluate(() => (window as any).untrustedPaperScript)).toBeUndefined();
});

test("follows a webpage PDF download button without treating reference links as the paper", async ({ page }) => {
  await page.route("https://publisher.example/article", route => route.fulfill({contentType:"text/html",body:'<a href="/reference.pdf">Related study</a><a href="/download?id=123">Download PDF</a>'}));
  await page.route("https://publisher.example/download?id=123", route => route.fulfill({contentType:"application/pdf",body:scholarlyPdf()}));
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-source").fill("https://publisher.example/article");
  await page.locator("#entry-dialog-identify").click();
  await expect(page.locator("#entry-dialog-name")).toHaveValue("Learning Motion from Sparse Sensors");
});

for (const contentType of ["application/pdf", "text/plain"]) {
  test(`imports a direct PDF without a file extension or an extra download (${contentType})`, async ({ page }) => {
    let downloads = 0;
    await page.route("https://publisher.example/download?id=123", route => {
      downloads++;
      return route.fulfill({contentType, body:scholarlyPdf()});
    });
    await page.goto("/studio/");
    await page.locator("#try-writing").click();
    await page.locator("#new-entry").click();
    await page.locator("#entry-dialog-category").selectOption("paper-reading");
    await page.locator("#entry-dialog-source").fill("https://publisher.example/download?id=123");
    await page.locator("#entry-dialog-identify").click();
    await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息");
    await page.locator("#entry-dialog-save").click();
    await expect(page.locator("[data-pdf-reader]")).toHaveAttribute("data-ready", "true");
    expect(downloads).toBe(1);
  });
}

test("preserves entered metadata and accepts an upload when a webpage has no public PDF", async ({ page }) => {
  await page.route("https://publisher.example/article", route => route.fulfill({contentType:"text/html",body:'<a href="javascript:alert(1)">PDF</a><a href="/reference.pdf">Related paper</a>'}));
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-name").fill("保留的标题");
  await page.locator("#entry-dialog-source").fill("https://publisher.example/article");
  await page.locator("#entry-dialog-identify").click();
  await expect(page.locator("#entry-dialog-import-error")).toContainText("已读取这个网页，但没有找到公开的 PDF");
  await page.locator("#entry-dialog-file").setInputFiles({name:"paper.pdf",mimeType:"application/pdf",buffer:scholarlyPdf()});
  await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息");
  await expect(page.locator("#entry-dialog-name")).toHaveValue("保留的标题");
  await page.locator("#entry-dialog-save").click();
  await expect(page.locator("[data-pdf-reader]")).toHaveAttribute("data-ready", "true");
});

test("explains a blocked webpage request without reporting a damaged PDF", async ({ page }) => {
  await page.route("https://publisher.example/article", route => route.abort());
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-source").fill("https://publisher.example/article");
  await page.locator("#entry-dialog-identify").click();
  await expect(page.locator("#entry-dialog-import-error")).toContainText("浏览器无法读取这个论文网页");
  await expect(page.locator("#entry-dialog-save")).toBeEnabled();
});

const acmDoi = "10.1145/3349624.3356768";
const acmPdf = `https://dl.acm.org/doi/pdf/${acmDoi}`;
const acmTitle = "RadHAR: Human Activity Recognition from Point Clouds Generated through a Millimeter-wave Radar";
async function mockDoiMetadata(page: Page, doi = acmDoi) {
  await page.route("https://api.crossref.org/works/**", route => route.fulfill({
    contentType: "application/json", body: JSON.stringify({message:{
      DOI: doi, title:["RadHAR"],
      subtitle:["Human Activity Recognition from Point Clouds Generated through a Millimeter-wave Radar"],
      author:[{given:"Akash Deep",family:"Singh"},{given:"Sandeep Singh",family:"Sandha"}],
      published:{"date-parts":[[2019,10,7]]},
      "container-title":["Proceedings of the 3rd ACM Workshop on Millimeter-wave Networks and Sensing Systems"],
      publisher:"Association for Computing Machinery",page:"51-56",
    }}),
  }));
}

for (const source of [
  `[https://dl.acm.org/doi/epdf/${acmDoi}](https://dl.acm.org/doi/epdf/${acmDoi})`,
  `https://dl.acm.org/doi/${acmDoi}`,
  acmPdf,
  `https://doi.org/${acmDoi}`,
]) {
  test(`recognizes ACM links and imports their PDF with matching DOI information: ${source}`, async ({ page }) => {
    await mockDoiMetadata(page);
    const urls: string[] = [];
    await page.route("https://dl.acm.org/**", route => {
      urls.push(route.request().url());
      expect(route.request().url()).toBe(acmPdf);
      return route.fulfill({contentType:"application/pdf",body:scholarlyPdf()});
    });
    await page.goto("/studio/");
    await page.locator("#try-writing").click();
    await page.locator("#new-entry").click();
    await page.locator("#entry-dialog-category").selectOption("paper-reading");
    await page.locator("#entry-dialog-source").fill(source);
    await page.locator("#entry-dialog-identify").click();
    await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息");
    await expect(page.locator("#entry-dialog-name")).toHaveValue(acmTitle);
    await expect(page.locator("#entry-dialog-year")).toHaveValue("2019");
    await expect(page.locator("#entry-dialog-authors")).toHaveValue("Akash Deep Singh, Sandeep Singh Sandha");
    await expect(page.locator("#entry-dialog-doi")).toHaveValue(acmDoi);
    await expect(page.locator("#entry-dialog-venue")).toHaveValue("Proceedings of the 3rd ACM Workshop on Millimeter-wave Networks and Sensing Systems");
    await expect(page.locator("#entry-dialog-publisher")).toHaveValue("Association for Computing Machinery");
    await expect(page.locator("#entry-dialog-pages")).toHaveValue("51-56");
    await expect(page.locator("#entry-dialog-github")).toBeHidden();
    await expect(page.locator("#entry-dialog-original")).toHaveAttribute("href",`https://dl.acm.org/doi/${acmDoi}`);
    await page.locator("#entry-dialog-save").click();
    await expect(page.locator("#entry-dialog")).toBeHidden();
    await expect(page.locator("[data-pdf-reader]")).toHaveAttribute("data-ready","true");
    expect(urls).toEqual([acmPdf]);
  });
}

test("retains DOI information and manual fields after an ACM 403, then accepts a local PDF", async ({ page }) => {
  await mockDoiMetadata(page);
  await page.route(acmPdf,route=>route.fulfill({status:403,contentType:"text/html",body:"<html>Please complete access verification</html>"}));
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await write(page,"原有笔记","保留的正文。");
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-name").fill("我的 RadHAR 阅读记录");
  await page.locator("#entry-dialog-source").fill(`https://dl.acm.org/doi/epdf/${acmDoi}`);
  await page.locator("#entry-dialog-identify").click();
  await expect(page.locator("#entry-dialog-import-error")).toContainText("ACM 未提供可供本站读取的 PDF（HTTP 403）");
  await expect(page.locator("#entry-dialog-name")).toHaveValue("我的 RadHAR 阅读记录");
  await expect(page.locator("#entry-dialog-year")).toHaveValue("2019");
  await expect(page.locator("#entry-dialog-doi")).toHaveValue(acmDoi);
  await expect(page.locator("#document-title")).toHaveValue("原有笔记");
  await page.locator("#entry-dialog-file").setInputFiles({name:"radhar.pdf",mimeType:"application/pdf",buffer:scholarlyPdf()});
  await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息");
  await expect(page.locator("#entry-dialog-name")).toHaveValue("我的 RadHAR 阅读记录");
  await page.locator("#entry-dialog-save").click();
  await expect(page.locator("#entry-dialog")).toBeHidden();
  await expect(page.locator("[data-pdf-reader]")).toHaveAttribute("data-ready","true");
});

test("reports an ACM HTML verification response as an access problem", async ({ page }) => {
  await mockDoiMetadata(page);
  await page.route(acmPdf,route=>route.fulfill({contentType:"text/html",body:"<html>Please verify your browser</html>"}));
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-source").fill(`https://dl.acm.org/doi/epdf/${acmDoi}`);
  await page.locator("#entry-dialog-identify").click();
  await expect(page.locator("#entry-dialog-import-error")).toContainText("ACM 未提供可供本站读取的 PDF");
  await expect(page.locator("#entry-dialog-import-error")).not.toContainText("损坏");
  await expect(page.locator("#entry-dialog-name")).toHaveValue(acmTitle);
});

for (const metadataFailure of ["unavailable", "mismatched"]) {
  test(`imports the PDF when DOI metadata is ${metadataFailure}`, async ({ page }) => {
    if (metadataFailure === "unavailable")
      await page.route("https://api.crossref.org/works/**", route=>route.abort());
    else await mockDoiMetadata(page,"10.1145/0000000.0000000");
    await page.route(acmPdf,route=>route.fulfill({contentType:"application/pdf",body:scholarlyPdf()}));
    await page.goto("/studio/");
    await page.locator("#try-writing").click();
    await page.locator("#new-entry").click();
    await page.locator("#entry-dialog-category").selectOption("paper-reading");
    await page.locator("#entry-dialog-source").fill(`https://dl.acm.org/doi/epdf/${acmDoi}`);
    await page.locator("#entry-dialog-identify").click();
    await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息");
    await expect(page.locator("#entry-dialog-name")).toHaveValue("Learning Motion from Sparse Sensors");
    await expect(page.locator("#entry-dialog-doi")).toHaveValue(acmDoi);
  });
}

async function mockJournalMetadata(page: Page, title = "Learning Motion from Sparse Sensors") {
  await page.route("https://api.crossref.org/works/**", route => route.fulfill({
    contentType:"application/json",body:JSON.stringify({message:{
      DOI:"10.1234/sparse.2024",title:[title],author:[{given:"Alice",family:"Example"}],
      published:{"date-parts":[[2024]]},"container-title":["Journal of Motion Research"],
      publisher:"Example Publisher",volume:"42",issue:"3",page:"101-112",
    }}),
  }));
}

test("imports and publishes a 25 MB PDF with intact bytes and restores its annotations", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const api=await mockGitHub(page);
  const pdf=scholarlyPdf(true,25*1024*1024);
  const path=testInfo.outputPath("large-paper.pdf");
  await writeFile(path,pdf);
  await connect(page);
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-name").fill("Large paper verification");
  await page.locator("#entry-dialog-file").setInputFiles(path);
  await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息",{timeout:30000});
  await page.locator("#entry-dialog-save").click();
  await expect(page.locator("#entry-dialog")).toBeHidden();
  const reader=page.locator("[data-pdf-reader]");
  await expect(reader).toHaveAttribute("data-ready","true");
  await reader.locator("[data-pdf-page-note]").click();
  await reader.locator(".pdf-note textarea").fill("大文件批注。");
  await page.locator("#publish-button").click();
  await expect(page.locator("#sync-result")).toContainText("文章与图片已提交",{timeout:30000});
  const data=entrySource(api.source("src/content/posts/large-paper-verification.md")!);
  const binary=api.calls.find(call=>call.method==="POST" && call.path===`${repository}/git/blobs` && call.data.encoding==="base64")!;
  const uploaded=Buffer.from(binary.data.content,"base64");
  expect(uploaded.length).toBe(pdf.length);
  expect(createHash("sha256").update(uploaded).digest("hex")).toBe(createHash("sha256").update(pdf).digest("hex"));
  expect(data.entry.paper.annotations[0].text).toBe("大文件批注。");
  await page.reload();
  await expect(reader).toHaveAttribute("data-ready","true",{timeout:30000});
  await expect(reader.locator(".pdf-note textarea")).toHaveValue("大文件批注。");
});

test("accepts a cached arXiv PDF larger than 20 MB",async({page})=>{
  test.setTimeout(60_000);
  const pdf=scholarlyPdf(true,21*1024*1024);
  await page.route("https://arxiv.org/**",route=>route.abort());
  await page.route("**/documents/studio/arxiv/index.json",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({version:1,papers:{"2406.07550":{path:"/documents/studio/arxiv/2406.07550.pdf",size:pdf.length,sha256:createHash("sha256").update(pdf).digest("hex")}}})}));
  await page.route("**/documents/studio/arxiv/2406.07550.pdf",route=>route.fulfill({contentType:"application/pdf",body:pdf}));
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-source").fill("https://arxiv.org/abs/2406.07550");
  await page.locator("#entry-dialog-identify").click();
  await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息",{timeout:30000});
  await page.locator("#entry-dialog-save").click();
  await expect(page.locator("[data-pdf-reader]")).toHaveAttribute("data-ready","true");
});

test("keeps the 100 MB limit on streamed downloads and retains entered information",async({page})=>{
  await page.route("https://publisher.example/oversize.pdf",route=>route.fulfill({contentType:"application/pdf",headers:{"content-length":String(101*1024*1024)},body:scholarlyPdf()}));
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-name").fill("保留的标题");
  await page.locator("#entry-dialog-source").fill("https://publisher.example/oversize.pdf");
  await page.locator("#entry-dialog-identify").click();
  await expect(page.locator("#entry-dialog-import-error")).toContainText("PDF 最大支持 100 MB");
  await expect(page.locator("#entry-dialog-name")).toHaveValue("保留的标题");
});

test("reads publication fields embedded in PDF XMP when DOI lookup is unavailable",async({page})=>{
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><prism:publicationName>Embedded Journal</prism:publicationName><dc:publisher>Embedded Publisher</dc:publisher><prism:volume>12</prism:volume><prism:issueIdentifier>4</prism:issueIdentifier><prism:pageRange>20-30</prism:pageRange><prism:publicationDate>2025-03-01</prism:publicationDate></rdf:Description></rdf:RDF></x:xmpmeta>';
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-file").setInputFiles({name:"embedded.pdf",mimeType:"application/pdf",buffer:scholarlyPdf(true,0,xmp)});
  await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息");
  await expect(page.locator("#entry-dialog-venue")).toHaveValue("Embedded Journal");
  await expect(page.locator("#entry-dialog-publisher")).toHaveValue("Embedded Publisher");
  await expect(page.locator("#entry-dialog-volume")).toHaveValue("12");
  await expect(page.locator("#entry-dialog-issue")).toHaveValue("4");
  await expect(page.locator("#entry-dialog-pages")).toHaveValue("20-30");
  await expect(page.locator("#entry-dialog-year")).toHaveValue("2025");
});

test("fills journal information from an uploaded PDF DOI, publishes it, and preserves edits and cleared values",async({page})=>{
  const api=await mockGitHub(page);
  await mockJournalMetadata(page);
  await connect(page);
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-name").fill("Journal paper verification");
  await page.locator("#entry-dialog-file").setInputFiles({name:"paper.pdf",mimeType:"application/pdf",buffer:scholarlyPdf()});
  await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息");
  await expect(page.locator("#entry-dialog-venue")).toHaveValue("Journal of Motion Research");
  await page.locator("#entry-dialog .paper-publication-fields summary").click();
  await expect(page.locator("#entry-dialog-volume")).toHaveValue("42");
  await expect(page.locator("#entry-dialog-issue")).toHaveValue("3");
  await expect(page.locator("#entry-dialog-pages")).toHaveValue("101-112");
  await page.locator("#entry-dialog-save").click();
  await expect(page.locator("#entry-dialog")).toBeHidden();
  await expect(page.locator("#paper-reader-publication")).toContainText("Journal of Motion Research");
  await page.locator("#publish-button").click();
  await expect(page.locator("#sync-result")).toContainText("文章与图片已提交");
  expect(entrySource(api.source("src/content/posts/journal-paper-verification.md")!).entry.paper).toMatchObject({venue:"Journal of Motion Research",publisher:"Example Publisher",volume:"42",issue:"3",pages:"101-112"});
  await page.locator("#edit-entry-info").click();
  await page.locator("#entry-dialog-venue").fill("My corrected journal");
  if (!await page.locator("#entry-dialog-pages").isVisible()) await page.locator("#entry-dialog .paper-publication-fields summary").click();
  await page.locator("#entry-dialog-pages").fill("");
  await page.locator("#entry-dialog-save").click();
  await expect(page.locator("#entry-dialog")).toBeHidden();
  await page.locator("#publish-button").click();
  await expect(page.locator("#sync-result")).toContainText("文章与图片已提交");
  await expect.poll(()=>entrySource(api.source("src/content/posts/journal-paper-verification.md")!).entry.paper).toMatchObject({venue:"My corrected journal",pages:""});
  await expect(page.locator("#publish-button")).toBeEnabled();
  await page.reload();
  await expect(page.locator("[data-pdf-reader]")).toHaveAttribute("data-ready","true");
  await page.locator("#edit-entry-info").click();
  await expect(page.locator("#entry-dialog-venue")).toHaveValue("My corrected journal");
  await expect(page.locator("#entry-dialog-pages")).toHaveValue("");
});

test("does not assign the venue of a different paper found through a referenced DOI",async({page})=>{
  await mockJournalMetadata(page,"An unrelated paper about image classification");
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#new-entry").click();
  await page.locator("#entry-dialog-category").selectOption("paper-reading");
  await page.locator("#entry-dialog-file").setInputFiles({name:"preprint.pdf",mimeType:"application/pdf",buffer:scholarlyPdf()});
  await expect(page.locator("#entry-dialog-import-status")).toContainText("已读取论文信息");
  await expect(page.locator("#entry-dialog-venue")).toHaveValue("");
  await expect(page.locator("#entry-dialog-publisher")).toHaveValue("");
});

test("fills publication metadata through the existing paper upload controls",async({page})=>{
  await mockJournalMetadata(page);
  await page.goto("/studio/");
  await page.locator("#try-writing").click();
  await page.locator("#quick-category").selectOption("paper-reading");
  await page.locator("#paper-file").setInputFiles({name:"paper.pdf",mimeType:"application/pdf",buffer:scholarlyPdf()});
  await expect(page.locator("#paper-venue")).toHaveValue("Journal of Motion Research");
  await expect(page.locator("#paper-volume")).toHaveValue("42");
  await expect(page.locator("#paper-reader-publication")).toContainText("Journal of Motion Research");
});
