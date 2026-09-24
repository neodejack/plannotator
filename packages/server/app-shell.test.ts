import { afterEach, describe, expect, test } from "bun:test";
import { gunzipSync } from "bun";
import { APP_ASSET_PREFIX, SPLIT_BUNDLE_MAGIC, buildAppShell, loadSplitBundle, serveAppShell, withAppShell } from "./app-shell";

const BIG_JS = `console.log("app");/*${"x".repeat(150_000)}*/`;
const BIG_CSS = `body{color:red}/*${"y".repeat(150_000)}*/`;
const PAGE = `<!DOCTYPE html><html><head>
<script>window.small = 1</script>
<script type="module" crossorigin>${BIG_JS}</script>
<style rel="stylesheet" crossorigin>${BIG_CSS}</style>
</head><body><div id="root"></div></body></html>`;

describe("buildAppShell", () => {
  test("moves large module script and style to hashed assets, byte-identical", () => {
    const shell = buildAppShell(PAGE);
    const html = new TextDecoder().decode(shell.html);
    expect(html.length).toBeLessThan(1000);
    // The small classic script stays inline.
    expect(html).toContain("<script>window.small = 1</script>");
    const js = html.match(/<script type="module" crossorigin src="([^"]+\.js)"><\/script>/)?.[1];
    const css = html.match(/<link rel="stylesheet" crossorigin href="([^"]+\.css)">/)?.[1];
    expect(js?.startsWith(APP_ASSET_PREFIX)).toBe(true);
    expect(css?.startsWith(APP_ASSET_PREFIX)).toBe(true);
    expect(new TextDecoder().decode(shell.assets.get(js!)!.body)).toBe(BIG_JS);
    expect(new TextDecoder().decode(shell.assets.get(css!)!.body)).toBe(BIG_CSS);
  });

  test("different content gets a different asset URL (plan and review can be cached side by side)", () => {
    const a = [...buildAppShell(PAGE).assets.keys()];
    const b = [...buildAppShell(PAGE.replace('"app"', '"review"')).assets.keys()];
    expect(a.find((p) => p.endsWith(".js"))).not.toBe(b.find((p) => p.endsWith(".js")));
  });

  test("a page with nothing large inline is served unchanged", () => {
    const small = "<html><head><script type=\"module\">1</script></head></html>";
    const shell = buildAppShell(small);
    expect(new TextDecoder().decode(shell.html)).toBe(small);
    expect(shell.assets.size).toBe(0);
  });
});

describe("withAppShell server", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  function start() {
    server = Bun.serve(
      withAppShell(PAGE, {
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/api/big") return Response.json({ data: "z".repeat(5000) });
          if (url.pathname === "/api/small") return Response.json({ ok: true });
          if (url.pathname === "/api/stream") {
            return new Response("data: " + "e".repeat(5000) + "\n\n", {
              headers: { "Content-Type": "text/event-stream" },
            });
          }
          return serveAppShell(req, PAGE);
        },
      }),
    );
    return `http://127.0.0.1:${server.port}`;
  }

  // A remote client reaches the server under its tailnet name; Bun derives
  // req.url's hostname from the Host header.
  const remote = { Host: "runner.example.ts.net", "Accept-Encoding": "gzip" };

  test("shell revalidates by ETag and assets are immutable", async () => {
    const base = start();
    const first = await fetch(base + "/");
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const etag = first.headers.get("etag")!;
    const html = await first.text();
    const again = await fetch(base + "/", { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);

    const js = html.match(/src="([^"]+)"/)![1];
    const asset = await fetch(base + js);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toBe(BIG_JS);

    // A stale tab asking for an older build's asset gets a 404, not the app.
    const missing = await fetch(base + APP_ASSET_PREFIX + "nope.js");
    expect(missing.status).toBe(404);
  });

  test("gzips large text responses for remote clients only", async () => {
    const base = start();
    const remoteBig = await fetch(base + "/api/big", { headers: remote, decompress: false });
    expect(remoteBig.headers.get("content-encoding")).toBe("gzip");
    const json = JSON.parse(new TextDecoder().decode(gunzipSync(new Uint8Array(await remoteBig.arrayBuffer()))));
    expect(json.data.length).toBe(5000);

    const localBig = await fetch(base + "/api/big", { headers: { "Accept-Encoding": "gzip" }, decompress: false });
    expect(localBig.headers.get("content-encoding")).toBeNull();

    const remoteSmall = await fetch(base + "/api/small", { headers: remote, decompress: false });
    expect(remoteSmall.headers.get("content-encoding")).toBeNull();
    expect(await remoteSmall.json()).toEqual({ ok: true });

    const remoteAsset = await fetch(base + (await (await fetch(base + "/")).text()).match(/src="([^"]+)"/)![1], {
      headers: remote,
      decompress: false,
    });
    expect(remoteAsset.headers.get("content-encoding")).toBe("gzip");
  });

  test("event streams are never buffered or compressed", async () => {
    const base = start();
    const res = await fetch(base + "/api/stream", { headers: remote, decompress: false });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect((await res.text()).startsWith("data: ")).toBe(true);
  });
});

describe("loadSplitBundle", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  // Same layout scripts/fork/pack-split-assets.ts writes.
  function bundle(files: [string, string, "utf8" | "base64", string][], html: { plan?: string; review?: string }) {
    let offset = 0;
    const header = { ...html, files: files.map(([p, t, e, body]) => { const row = [p, t, e, offset, body.length]; offset += body.length; return row; }) };
    return `${SPLIT_BUNDLE_MAGIC}\n${JSON.stringify(header)}\n${files.map((f) => f[3]).join("")}`;
  }

  test("serves embedded text and binary assets byte-identically, immutable", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 1, 2]);
    const shellHtml = '<html><head><script type="module" crossorigin src="/_app/index-a.js"></script></head></html>';
    const ui = loadSplitBundle(
      bundle(
        [
          ["/_app/index-a.js", "text/javascript; charset=utf-8", "utf8", 'import("./chunk-é.js")'],
          ["/_app/sprite-b.png", "image/png", "base64", Buffer.from(png).toString("base64")],
        ],
        { plan: shellHtml },
      ),
    );
    expect(ui.plan).toBe(shellHtml);
    expect(ui.review).toBeUndefined();

    server = Bun.serve(withAppShell(ui.plan!, { hostname: "127.0.0.1", port: 0, fetch: (req) => serveAppShell(req, ui.plan!) }));
    const base = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(base + "/")).text()).toBe(shellHtml);
    const js = await fetch(base + "/_app/index-a.js");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(await js.text()).toBe('import("./chunk-é.js")');
    const img = await fetch(base + "/_app/sprite-b.png", { headers: { Host: "runner.example.ts.net", "Accept-Encoding": "gzip" }, decompress: false });
    expect(img.headers.get("content-type")).toBe("image/png");
    // Already-compressed media is not gzipped again.
    expect(img.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(png);
  });

  test("an unrecognized bundle yields no split UI, so the single-file pages are used", () => {
    expect(loadSplitBundle("")).toEqual({});
    expect(loadSplitBundle("something else\n{}\n")).toEqual({});
  });
});
