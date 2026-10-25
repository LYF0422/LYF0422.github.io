import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rm,
  copyFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

const api = "https://api.bgm.tv";
const userAgent =
  "YifanBlog/1.0 (https://github.com/LYF0422/LYF0422.github.io)";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = (value, limit = 6000) =>
  typeof value === "string" ? value.slice(0, limit) : "";
const wikiValue = value =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .map(item => text(item?.v, 500))
          .filter(Boolean)
          .join("、")
      : "";

export function subjectRecord(source, image) {
  const wanted =
    source.type === 2
      ? ["导演", "动画制作", "原作"]
      : ["开发", "开发商", "发行", "发行商", "游戏类型", "游玩人数"];
  const infobox = Array.isArray(source.infobox) ? source.infobox : [];
  const aliases = infobox
    .filter(item => item.key === "别名")
    .flatMap(item =>
      Array.isArray(item.value)
        ? item.value.map(part => text(part?.v, 300))
        : [text(item.value, 300)]
    )
    .filter(Boolean)
    .slice(0, 20);
  return {
    detail: {
      id: source.id,
      type: source.type,
      name: text(source.name_cn || source.name, 300),
      originalName: text(source.name, 300),
      image,
      date: text(source.date, 50),
      platform: text(source.platform, 100),
      summary: text(source.summary),
      episodes: Number.isFinite(source.eps)
        ? source.eps
        : Number(source.total_episodes) || 0,
      facts: infobox
        .filter(item => wanted.includes(item.key))
        .slice(0, 4)
        .map(item => ({
          label: item.key,
          value: wikiValue(item.value).slice(0, 500),
        })),
    },
    index: {
      id: source.id,
      type: source.type,
      name: text(source.name, 300),
      name_cn: text(source.name_cn, 300),
      aliases,
      image,
    },
  };
}

async function bytesLimited(response, limit) {
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Response exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

// A complete snapshot is staged before replacing the last usable catalog.
export async function syncCatalog({
  root = process.cwd(),
  perType = 200,
  fetcher = fetch,
  delayMs = 350,
  log = () => {},
} = {}) {
  if (!Number.isInteger(perType) || perType < 1 || perType > 300)
    throw new Error("perType must be 1–300");
  const output = join(root, "public", "bangumi");
  await mkdir(join(root, "public"), { recursive: true });
  const stage = await mkdtemp(join(root, "public", ".bangumi-sync-"));
  await mkdir(join(stage, "subjects"));
  await mkdir(join(stage, "covers"));
  let nextRequest = Promise.resolve();
  const request = async (url, init = {}) => {
    const turn = nextRequest;
    nextRequest = turn.then(() => pause(delayMs));
    await turn;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetcher(url, {
          ...init,
          headers: { "User-Agent": userAgent, ...init.headers },
          redirect: "error",
          signal: AbortSignal.timeout(25_000),
        });
        if (
          [429, 500, 502, 503, 504].includes(response.status) &&
          attempt < 2
        ) {
          await response.body?.cancel();
          await pause(delayMs ? 2000 * (attempt + 1) : 0);
          continue;
        }
        return response;
      } catch (error) {
        if (attempt === 2) throw error;
        await pause(delayMs ? 2000 * (attempt + 1) : 0);
      }
    }
    throw new Error("Request failed");
  };
  const json = async (path, init) =>
    JSON.parse(
      (
        await bytesLimited(
          await request(`${api}${path}`, init),
          5 * 1024 * 1024
        )
      ).toString()
    );
  try {
    const selected = [];
    for (const type of [2, 4]) {
      const seen = new Set();
      for (
        let offset = 0;
        seen.size < perType && offset < perType * 3;
        offset += 50
      ) {
        const page = await json(
          `/v0/search/subjects?limit=50&offset=${offset}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              keyword: "",
              sort: "heat",
              filter: { type: [type], nsfw: false },
            }),
          }
        );
        if (!Array.isArray(page.data) || !page.data.length) break;
        for (const subject of page.data) {
          if (
            subject.type !== type ||
            subject.nsfw ||
            !Number.isSafeInteger(subject.id) ||
            subject.id <= 0 ||
            !subject.name ||
            seen.has(subject.id)
          )
            continue;
          selected.push(subject);
          seen.add(subject.id);
          if (seen.size === perType) break;
        }
      }
      if (seen.size < perType)
        throw new Error(
          `Incomplete catalog for type ${type}: ${seen.size}/${perType}; previous catalog retained`
        );
      log(`Selected ${seen.size} popular ${type === 2 ? "anime" : "games"}`);
    }
    const records = new Array(selected.length);
    let cursor = 0,
      covered = 0,
      reusedCovers = 0;
    const worker = async () => {
      while (cursor < selected.length) {
        const position = cursor++;
        let source = selected[position];
        if (!Array.isArray(source.infobox))
          source = await json(`/v0/subjects/${source.id}`);
        if (
          source.id !== selected[position].id ||
          source.type !== selected[position].type ||
          source.nsfw ||
          !source.name
        )
          throw new Error("Invalid subject detail; previous catalog retained");
        const relativeImage = `/bangumi/covers/${source.id}.webp`;
        const coverFile = join(stage, "covers", `${source.id}.webp`);
        let image = "";
        try {
          const url = new URL(source.images?.common || source.images?.large);
          if (
            !["https:", "http:"].includes(url.protocol) ||
            url.hostname !== "lain.bgm.tv" ||
            url.port ||
            url.username ||
            url.password ||
            !/^\/(?:r\/\d+\/)?pic\/cover\//.test(url.pathname)
          )
            throw new Error("Unsupported cover source");
          url.protocol = "https:";
          const response = await request(url.href, {
            headers: { Accept: "image/*" },
          });
          if (
            !/^image\/(jpeg|png|webp|gif|avif)(;|$)/.test(
              response.headers.get("content-type") || ""
            )
          )
            throw new Error("Invalid cover format");
          const bytes = await bytesLimited(response, 5 * 1024 * 1024);
          await sharp(bytes, { limitInputPixels: 40_000_000 })
            .rotate()
            .resize({
              width: 360,
              height: 480,
              fit: "inside",
              withoutEnlargement: true,
            })
            .webp({ quality: 78 })
            .toFile(coverFile);
          image = relativeImage;
        } catch {
          try {
            await copyFile(
              join(output, "covers", `${source.id}.webp`),
              coverFile
            );
            image = relativeImage;
            reusedCovers++;
          } catch {
            /* A missing cover never turns into a browser request to Bangumi. */
          }
        }
        if (image) covered++;
        const record = subjectRecord(source, image);
        records[position] = record.index;
        await writeFile(
          join(stage, "subjects", `${source.id}.json`),
          JSON.stringify(record.detail) + "\n"
        );
        if ((position + 1) % 50 === 0)
          log(`Prepared ${position + 1}/${selected.length} subjects`);
      }
    };
    const results = await Promise.allSettled([worker(), worker(), worker()]);
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    if (covered < selected.length * 0.9)
      throw new Error(
        `Only ${covered}/${selected.length} covers available; previous catalog retained`
      );
    const catalog = {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "https://bgm.tv",
      selection: "public subjects sorted by collection count",
      counts: { anime: perType, game: perType },
      covered,
      subjects: records,
    };
    await writeFile(
      join(stage, "catalog.json"),
      JSON.stringify(catalog) + "\n"
    );
    const backup = `${stage}-previous`;
    let moved = false;
    try {
      await rename(output, backup);
      moved = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(stage, output);
    } catch (error) {
      if (moved) await rename(backup, output);
      throw error;
    }
    if (moved) await rm(backup, { recursive: true, force: true });
    log(
      `Catalog ready: ${records.length} subjects, ${covered} covers (${reusedCovers} retained from previous snapshot)`
    );
    return catalog;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  syncCatalog({ log: message => process.stdout.write(`${message}\n`) }).catch(
    error => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  );
}
