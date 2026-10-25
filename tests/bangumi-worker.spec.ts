import { test, expect } from "@playwright/test";
import worker from "../workers/site";

const origin = "https://lyf0422-github-io.yifan-liu-51f.workers.dev";
const originalFetch = globalThis.fetch;
const requests: { url: string; init?: RequestInit }[] = [];
const pending: Promise<unknown>[] = [];
const assets = { fetch: async () => new Response("static site") };
const context = { waitUntil: (task: Promise<unknown>) => pending.push(task) };
const invoke = (path: string, init?: RequestInit) =>
  worker.fetch(
    new Request(`${origin}${path}`, init),
    { ASSETS: assets },
    context
  );

test.beforeEach(() => {
  requests.length = 0;
  pending.length = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.startsWith("https://lain.bgm.tv/"))
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/jpeg" },
      });
    return Response.json({
      id: 100,
      type: 2,
      images: { common: "http://lain.bgm.tv/r/400/pic/cover/l/test.jpg" },
    });
  };
});
test.afterEach(async () => {
  await Promise.all(pending);
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, "caches");
});

test("serves the static site normally and only permits public read routes", async () => {
  expect(await (await invoke("/studio/")).text()).toBe("static site");
  expect(
    (await invoke("/api/bangumi/v0/subjects/100", { method: "POST" })).status
  ).toBe(405);
  expect((await invoke("/api/bangumi/users/me")).status).toBe(404);
  expect((await invoke("/api/bangumi/search/subject/test?type=1")).status).toBe(
    400
  );
  expect((await invoke("/api/bangumi/search/subject/%ZZ?type=2")).status).toBe(
    400
  );
  expect(
    (await invoke("/api/bangumi/v0/subjects/100?url=https://example.com"))
      .status
  ).toBe(400);
  expect(requests).toHaveLength(0);
});

test("normalizes public search, supports CORS and never forwards browser credentials", async () => {
  const response = await invoke(
    "/api/bangumi/search/subject/%E5%8A%A8%E7%94%BB?type=2&max_results=999&token=private",
    {
      headers: {
        Origin: "https://lyf0422.github.io",
        Authorization: "Bearer private",
        Cookie: "session=private",
      },
    }
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  expect(requests[0].url).toBe(
    "https://api.bgm.tv/search/subject/%E5%8A%A8%E7%94%BB?type=2&responseGroup=small&max_results=12"
  );
  const headers = new Headers(requests[0].init?.headers);
  expect(headers.has("authorization")).toBe(false);
  expect(headers.has("cookie")).toBe(false);
  expect(headers.get("user-agent")).toContain("LYF0422");
});

test("caches successful subject requests and serves bounded image responses from the official cover host", async () => {
  const entries = new Map<string, Response>();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async (request: Request) => entries.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          entries.set(request.url, response);
        },
      },
    },
  });
  await invoke("/api/bangumi/v0/subjects/100");
  await Promise.all(pending);
  expect((await invoke("/api/bangumi/v0/subjects/100")).status).toBe(200);
  expect(requests).toHaveLength(1);
  const cover = await invoke("/api/bangumi/covers/100");
  expect(cover.headers.get("content-type")).toBe("image/jpeg");
  expect(cover.headers.get("cache-control")).toBe("public, max-age=604800");
  expect(new Uint8Array(await cover.arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3])
  );
  expect(requests.at(-1)?.url).toBe(
    "https://lain.bgm.tv/r/400/pic/cover/l/test.jpg"
  );
  expect(requests.at(-1)?.init?.redirect).toBe("error");
});

test("rejects arbitrary image hosts, invalid image types and oversized upstream responses", async () => {
  let image = "https://example.com/private";
  let oversized = false;
  globalThis.fetch = async input =>
    String(input).startsWith("https://api.bgm.tv")
      ? Response.json({ images: { common: image } })
      : new Response("<html>error</html>", {
          headers: {
            "Content-Type": oversized ? "image/jpeg" : "text/html",
            "Content-Length": oversized ? "6000000" : "18",
          },
        });
  expect((await invoke("/api/bangumi/covers/100")).status).toBe(404);
  image = "https://lain.bgm.tv/pic/cover/l/test.jpg";
  expect((await invoke("/api/bangumi/covers/100")).status).toBe(502);
  oversized = true;
  expect((await invoke("/api/bangumi/covers/100")).status).toBe(502);
});

test("returns uncached failures that allow the browser to use its alternate route", async () => {
  globalThis.fetch = async () => {
    throw new Error("upstream unavailable");
  };
  const response = await invoke("/api/bangumi/v0/subjects/100");
  expect(response.status).toBe(502);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(await response.text()).not.toContain("upstream unavailable");
});
