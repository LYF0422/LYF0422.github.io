import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { syncCatalog } from "./sync-bangumi.mjs";

test("publishes popular anime and games with searchable aliases and local covers", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-test-"));
  try {
    const cover = await sharp({
      create: { width: 20, height: 30, channels: 3, background: "#abcabc" },
    })
      .png()
      .toBuffer();
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push(url);
      assert.equal(new Headers(init.headers).has("authorization"), false);
      if (url.startsWith("https://lain.bgm.tv"))
        return new Response(cover, {
          headers: { "Content-Type": "image/png" },
        });
      const query = JSON.parse(init.body);
      assert.equal(query.sort, "heat");
      const type = query.filter.type[0];
      return Response.json({
        data: [1, 2].map(id => ({
          id: type * 100 + id,
          type,
          name: `Original ${type}-${id}`,
          name_cn: `作品 ${id}`,
          infobox: [
            { key: "别名", value: [{ v: "Alias" }] },
            { key: "导演", value: "Director" },
          ],
          images: { common: "https://lain.bgm.tv/pic/cover/l/test.jpg" },
          summary: "简介",
        })),
      });
    };
    const catalog = await syncCatalog({
      root,
      perType: 2,
      fetcher,
      delayMs: 0,
    });
    assert.deepEqual(catalog.counts, { anime: 2, game: 2 });
    assert.equal(catalog.covered, 4);
    assert.equal(catalog.subjects[0].aliases[0], "Alias");
    const detail = JSON.parse(
      await readFile(join(root, "public/bangumi/subjects/201.json"), "utf8")
    );
    assert.equal(detail.image, "/bangumi/covers/201.webp");
    assert.equal(detail.facts[0].value, "Director");
    assert.equal(
      (await sharp(join(root, "public/bangumi/covers/201.webp")).metadata())
        .format,
      "webp"
    );
    const before = await readFile(
      join(root, "public/bangumi/catalog.json"),
      "utf8"
    );
    await assert.rejects(
      syncCatalog({
        root,
        perType: 2,
        delayMs: 0,
        fetcher: async () => Response.json({ data: [] }),
      }),
      /Incomplete catalog/
    );
    assert.equal(
      await readFile(join(root, "public/bangumi/catalog.json"), "utf8"),
      before
    );
    assert.deepEqual(await readdir(join(root, "public")), ["bangumi"]);
    // Reuse existing covers on a later image outage, with no external image URLs in the index.
    const refreshed = await syncCatalog({
      root,
      perType: 2,
      delayMs: 0,
      fetcher: (url, init) =>
        url.startsWith("https://lain.bgm.tv")
          ? Promise.resolve(new Response("offline", { status: 502 }))
          : fetcher(url, init),
    });
    assert.equal(refreshed.covered, 4);
    assert.ok(
      refreshed.subjects.every(item => item.image.startsWith("/bangumi/"))
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not publish a first catalog with broken or unexpected cover sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-test-"));
  try {
    const fetcher = async (url, init) => {
      assert.ok(url.startsWith("https://api.bgm.tv/"));
      const type = JSON.parse(init.body).filter.type[0];
      return Response.json({
        data: [
          {
            id: type,
            type,
            name: "作品",
            infobox: [],
            images: { common: "https://example.com/image.png" },
          },
        ],
      });
    };
    await assert.rejects(
      syncCatalog({ root, perType: 1, delayMs: 0, fetcher }),
      /covers available/
    );
    assert.deepEqual(await readdir(join(root, "public")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supplements a capped heat search with ranked works without duplicate entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-test-"));
  try {
    const cover = await sharp({
      create: { width: 10, height: 15, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const fetcher = async (url, init) => {
      if (url.startsWith("https://lain.bgm.tv"))
        return new Response(cover, {
          headers: { "content-type": "image/png" },
        });
      const query = new URL(url);
      const type = init.body
        ? JSON.parse(init.body).filter.type[0]
        : Number(query.searchParams.get("type"));
      const record = id => ({
        id: type * 100 + id,
        type,
        name: `Work ${id}`,
        infobox: [],
        images: { common: "https://lain.bgm.tv/pic/cover/test.png" },
      });
      if (init.body)
        return Response.json({
          data: query.searchParams.get("offset") === "0" ? [record(1)] : [],
        });
      assert.equal(query.searchParams.get("sort"), "rank");
      return Response.json({ data: [record(1), record(2), record(3)] });
    };
    const data = await syncCatalog({ root, perType: 2, fetcher, delayMs: 0 });
    assert.deepEqual(
      data.subjects.map(row => row.id),
      [201, 202, 401, 402]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
