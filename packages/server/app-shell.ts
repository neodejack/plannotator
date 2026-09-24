/**
 * App-shell serving for remote sessions (fork-only).
 *
 * The UI is built as ONE self-contained HTML file (24 MB for the plan/annotate
 * app, 18 MB for review) and every server used to send all of it, uncompressed
 * and uncacheable, on every page load. Over a slow link (e.g. a Tailscale
 * connection to a remote runner) that is a ~10 s open for every session.
 *
 * This module keeps the build untouched and splits the page at runtime:
 *
 *   - the big inline `<script type="module">` and `<style>` bodies are moved to
 *     content-hashed URLs under `/_app/` and served `immutable`, so the browser
 *     keeps them forever and the plan and review apps (which share one origin
 *     and one `/` URL) are cached side by side instead of evicting each other;
 *   - the remaining ~1 KB shell is served `no-cache` with an ETag;
 *   - text responses (the shell, the assets, and JSON API payloads such as
 *     `/api/diff`) are gzipped for non-loopback requests.
 *
 * Loopback requests are served exactly as before apart from the cache headers,
 * so local sessions pay no compression cost.
 */

import { gzipSync } from "bun";

export const APP_ASSET_PREFIX = "/_app/";

/** Inline bodies smaller than this stay inline (not worth a request). */
const EXTRACT_MIN_CHARS = 100_000;
/** Responses smaller than this are not worth compressing. */
const COMPRESS_MIN_BYTES = 1024;
const COMPRESSIBLE_TYPE = /json|javascript|text\/(html|css|plain)|svg\+xml/i;

type Bytes = Uint8Array<ArrayBuffer>;

interface ShellAsset {
  body: Bytes;
  type: string;
  gzip?: Bytes;
}

export interface AppShell {
  /** HTML served for `/` and SPA routes: the original page with big inline bodies replaced by references. */
  html: Bytes;
  htmlGzip?: Bytes;
  etag: string;
  assets: Map<string, ShellAsset>;
}

const shells = new Map<string, AppShell>();

/**
 * Split a single-file HTML page into a small shell plus hashed assets. Pure
 * apart from memoization; a page with nothing large inline is returned as-is.
 */
export function buildAppShell(source: string): AppShell {
  const encoder = new TextEncoder();
  const assets = new Map<string, ShellAsset>();
  // A browser ends a <script>/<style> raw-text element at the first matching
  // close tag, so this non-greedy match splits the page exactly where the HTML
  // parser would.
  const html = source.replace(
    /<(script|style)([^>]*)>([\s\S]*?)<\/\1>/g,
    (whole, tag: string, attrs: string, body: string) => {
      if (body.length < EXTRACT_MIN_CHARS) return whole;
      const isScript = tag === "script";
      // The build emits exactly one module script; inline and external module
      // scripts are both deferred, so moving it keeps execution order. Leave
      // anything else inline rather than reason about classic-script timing.
      if (isScript && !/\btype\s*=\s*["']?module\b/i.test(attrs)) return whole;
      const bytes = encoder.encode(body) as Bytes;
      const ext = isScript ? "js" : "css";
      const path = `${APP_ASSET_PREFIX}${Bun.hash(bytes).toString(36)}.${ext}`;
      assets.set(path, { body: bytes, type: isScript ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" });
      return isScript
        ? `<script${attrs} src="${path}"></script>`
        : `<link rel="stylesheet" crossorigin href="${path}">`;
    },
  );
  const htmlBytes = encoder.encode(html) as Bytes;
  return { html: htmlBytes, etag: `"${Bun.hash(htmlBytes).toString(36)}"`, assets };
}

function getAppShell(source: string): AppShell {
  let shell = shells.get(source);
  if (!shell) {
    shell = buildAppShell(source);
    shells.set(source, shell);
  }
  return shell;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function wantsGzip(req: Request, url: URL): boolean {
  if (isLoopbackHost(url.hostname)) return false;
  return /\bgzip\b/i.test(req.headers.get("accept-encoding") ?? "");
}

function gzipped(body: Bytes, headers: Headers, status = 200): Response {
  headers.set("Content-Encoding", "gzip");
  headers.delete("Content-Length");
  return new Response(body, { status, headers });
}

/** Serve the app shell for `/` and SPA routes (the servers' catch-all). */
export function serveAppShell(req: Request, source: string): Response {
  const shell = getAppShell(source);
  const headers = new Headers({
    "Content-Type": "text/html",
    "Cache-Control": "no-cache",
    ETag: shell.etag,
    Vary: "Accept-Encoding",
  });
  if (req.headers.get("if-none-match") === shell.etag) {
    return new Response(null, { status: 304, headers });
  }
  if (wantsGzip(req, new URL(req.url))) {
    shell.htmlGzip ??= gzipSync(shell.html, { level: 6 });
    return gzipped(shell.htmlGzip, headers);
  }
  return new Response(shell.html, { headers });
}

function serveAppAsset(req: Request, url: URL, source: string): Response {
  const asset = getAppShell(source).assets.get(url.pathname);
  if (!asset) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  const headers = new Headers({
    "Content-Type": asset.type,
    // The name is the content hash: a different build is a different URL.
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    Vary: "Accept-Encoding",
  });
  if (wantsGzip(req, url)) {
    asset.gzip ??= gzipSync(asset.body, { level: 6 });
    return gzipped(asset.gzip, headers);
  }
  return new Response(asset.body, { headers });
}

async function compressResponse(req: Request, url: URL, res: Response): Promise<Response> {
  if (req.method === "HEAD" || !res.body || res.status === 204 || res.status === 304) return res;
  if (res.headers.has("Content-Encoding")) return res;
  const type = res.headers.get("Content-Type") ?? "";
  // Streams (SSE) and binary bodies pass through untouched.
  if (!COMPRESSIBLE_TYPE.test(type) || /event-stream/i.test(type)) return res;
  if (!wantsGzip(req, url)) return res;
  const body = new Uint8Array(await res.arrayBuffer());
  const headers = new Headers(res.headers);
  if (body.byteLength < COMPRESS_MIN_BYTES) {
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  }
  headers.append("Vary", "Accept-Encoding");
  return gzipped(gzipSync(body, { level: 6 }), headers, res.status);
}

type FetchHandler = (this: unknown, req: Request, server: unknown) => unknown;

/**
 * Wrap a Bun.serve options object: `/_app/*` assets are answered before the
 * server's own handler runs, and its text responses are gzipped for remote
 * clients. Everything else (websocket upgrades, SSE, errors) is unchanged.
 * Typed as Bun's own options so the wrapped literal keeps its inference.
 */
export function withAppShell<WebSocketData = undefined, R extends string = never>(
  source: string,
  options: Bun.Serve.Options<WebSocketData, R>,
): Bun.Serve.Options<WebSocketData, R> {
  const inner = (options as { fetch?: FetchHandler }).fetch;
  if (!inner) return options;
  const fetch: FetchHandler = async function (this: unknown, req, server) {
    const url = new URL(req.url);
    if (url.pathname.startsWith(APP_ASSET_PREFIX) && (req.method === "GET" || req.method === "HEAD")) {
      return serveAppAsset(req, url, source);
    }
    const res = await inner.call(this, req, server);
    // A websocket upgrade returns undefined; anything that is not a
    // Response is Bun's business.
    if (!(res instanceof Response)) return res;
    return compressResponse(req, url, res);
  };
  return { ...options, fetch } as Bun.Serve.Options<WebSocketData, R>;
}
