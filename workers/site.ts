// Only public Bangumi search, subject data and covers are served here.
// GitHub tokens and browser cookies must never be forwarded upstream.
const prefix = "/api/bangumi";
const api = "https://api.bgm.tv";
const userAgent =
  "YifanBlog/1.0 (https://github.com/LYF0422/LYF0422.github.io)";
interface Environment {
  ASSETS: { fetch(request: Request): Promise<Response> };
}
interface Context {
  waitUntil(promise: Promise<unknown>): void;
}
class ServiceError extends Error {
  constructor(
    message: string,
    public status = 502
  ) {
    super(message);
  }
}

async function readLimited(response: Response, limit: number) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new ServiceError("作品资料过大，请稍后重试。");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceError("作品资料为空。");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new ServiceError("作品资料过大，请稍后重试。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function fetchPublic(url: string, accept: string) {
  const response = await fetch(url, {
    headers: { Accept: accept, "User-Agent": userAgent },
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ServiceError(
      response.status === 404 ? "未找到公开条目。" : "Bangumi 暂时无法读取。",
      [404, 429].includes(response.status) ? response.status : 502
    );
  }
  return response;
}

async function readJson(path: string) {
  const response = await fetchPublic(`${api}${path}`, "application/json");
  const bytes = await readLimited(response, 2 * 1024 * 1024);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function route(url: URL) {
  const path = url.pathname.slice(prefix.length);
  const subject = path.match(/^\/v0\/subjects\/([1-9]\d{0,8})$/);
  const cover = path.match(/^\/covers\/([1-9]\d{0,8})$/);
  if (subject || cover) {
    if (url.search) throw new ServiceError("请求参数无效。", 400);
    const id = (subject || cover)![1];
    return {
      path: `/v0/subjects/${id}`,
      cover: Boolean(cover),
      ttl: cover ? 604800 : 21600,
      key: `${prefix}${cover ? "/covers" : "/v0/subjects"}/${id}`,
    };
  }
  const search = path.match(/^\/search\/subject\/([^/]+)$/);
  if (search) {
    let keyword: string;
    try {
      keyword = decodeURIComponent(search[1]).trim();
    } catch {
      throw new ServiceError("检索词无效。", 400);
    }
    const type = url.searchParams.get("type");
    if (!keyword || keyword.length > 200 || !["2", "4"].includes(type ?? ""))
      throw new ServiceError("请输入作品名称并选择动画或游戏。", 400);
    const query = `/search/subject/${encodeURIComponent(keyword)}?type=${type}&responseGroup=small&max_results=12`;
    return { path: query, cover: false, ttl: 300, key: `${prefix}${query}` };
  }
  throw new ServiceError("接口不存在。", 404);
}

async function loadRoute(target: ReturnType<typeof route>) {
  const data = await readJson(target.path);
  if (!data || typeof data !== "object")
    throw new ServiceError("作品资料格式无效。");
  if (!target.cover) return Response.json(data);
  const image = data.images?.common || data.images?.large;
  if (!image) throw new ServiceError("此条目暂无封面。", 404);
  const url = new URL(image);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname !== "lain.bgm.tv" ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/(?:r\/\d+\/)?pic\/cover\//.test(url.pathname)
  )
    throw new ServiceError("封面来源暂不支持。", 404);
  url.protocol = "https:";
  const response = await fetchPublic(url.href, "image/*");
  const type = response.headers.get("content-type")?.split(";")[0].trim();
  if (!type || !/^image\/(?:jpeg|png|webp|gif|avif)$/.test(type)) {
    await response.body?.cancel();
    throw new ServiceError("封面格式暂不支持。");
  }
  const bytes = await readLimited(response, 5 * 1024 * 1024);
  return new Response(bytes, { headers: { "Content-Type": type } });
}

export default {
  async fetch(request: Request, env: Environment, context: Context) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${prefix}/`))
      return env.ASSETS.fetch(request);
    // This read-only API contains public data and accepts no credentials.
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    if (request.method !== "GET")
      return Response.json(
        { error: "仅支持读取公开资料。" },
        { status: 405, headers: { ...headers, Allow: "GET, OPTIONS" } }
      );
    try {
      const target = route(url);
      const cache =
        typeof caches !== "undefined"
          ? (caches as CacheStorage & { default?: Cache }).default
          : undefined;
      const key = new Request(new URL(target.key, url.origin).href);
      const cached = await cache?.match(key);
      if (cached) return cached;
      const result = await loadRoute(target);
      const response = new Response(result.body, {
        headers: {
          ...Object.fromEntries(result.headers),
          ...headers,
          "Cache-Control": `public, max-age=${target.ttl}`,
        },
      });
      if (cache)
        context.waitUntil(cache.put(key, response.clone()).catch(() => {}));
      return response;
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof ServiceError
              ? error.message
              : "作品资料服务暂不可用，请稍后重试。",
        },
        {
          status: error instanceof ServiceError ? error.status : 502,
          headers: { ...headers, "Cache-Control": "no-store" },
        }
      );
    }
  },
};
