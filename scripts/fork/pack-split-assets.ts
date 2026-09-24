#!/usr/bin/env bun
// Fork-only: pack the code-split plan and review builds into ONE text file
// the CLI embeds (apps/hook/dist/app-split.txt), read by loadSplitBundle() in
// packages/server/app-shell.ts.
//
// Format:
//   line 1: SPLIT_BUNDLE_MAGIC
//   line 2: JSON header { plan?, review?, files: [path, contentType, encoding, start, length][] }
//   rest:   every file body concatenated; start/length are UTF-16 offsets into it.
// Text files are stored verbatim, binary files as base64, so the whole bundle
// is a string Bun can embed with `with { type: "text" }` and the loader only
// has to parse the small header at startup.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { extname, join, relative } from "path";
import { SPLIT_BUNDLE_MAGIC, splitAssetContentType } from "../../packages/server/app-shell";

const ROOT = join(import.meta.dir, "../..");
const APPS = { plan: join(ROOT, "apps/hook/dist/split"), review: join(ROOT, "apps/review/dist/split") };
const OUT = join(ROOT, "apps/hook/dist/app-split.txt");
const TEXT_EXT = new Set([".js", ".mjs", ".css", ".html", ".json", ".svg", ".map", ".txt", ".webmanifest"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const header: { plan?: string; review?: string; files: [string, string, "utf8" | "base64", number, number][] } = { files: [] };
const bodies: string[] = [];
const seen = new Map<string, Buffer>();
let offset = 0;

for (const [app, dir] of Object.entries(APPS) as ["plan" | "review", string][]) {
  const indexPath = join(dir, "index.html");
  if (!existsSync(indexPath)) {
    console.warn(`[pack-split] ${relative(ROOT, dir)} missing; ${app} will use the single-file UI`);
    continue;
  }
  header[app] = readFileSync(indexPath, "utf8");
  for (const file of walk(dir)) {
    if (file === indexPath) continue;
    const path = "/" + relative(dir, file).split("\\").join("/");
    const bytes = readFileSync(file);
    const previous = seen.get(path);
    if (previous) {
      // Content-hashed names: the same name must mean the same bytes.
      if (!previous.equals(bytes)) throw new Error(`[pack-split] ${path} differs between builds`);
      continue;
    }
    seen.set(path, bytes);
    const encoding = TEXT_EXT.has(extname(file)) ? "utf8" : "base64";
    const body = bytes.toString(encoding);
    header.files.push([path, splitAssetContentType(path), encoding, offset, body.length]);
    bodies.push(body);
    offset += body.length;
  }
  // Every asset the shell references must be in the bundle.
  for (const [, ref] of header[app]!.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    if (!seen.has(ref) && ref !== "/favicon.png") throw new Error(`[pack-split] ${app} references missing ${ref}`);
  }
}

writeFileSync(OUT, `${SPLIT_BUNDLE_MAGIC}\n${JSON.stringify(header)}\n${bodies.join("")}`);
const mb = (statSync(OUT).size / 1e6).toFixed(1);
console.log(`[pack-split] ${header.files.length} files -> ${relative(ROOT, OUT)} (${mb} MB)`);
