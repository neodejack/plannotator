# Fork notes (neodejack/plannotator)

Personal fork of [backnotprop/plannotator](https://github.com/backnotprop/plannotator)
that makes remote sessions (plannotator running on a remote runner, opened from
another machine over Tailscale) open in well under a second.

## What the fork changes

Upstream serves the whole UI as one self-contained HTML file (24.7 MB for
plan/annotate/last, 18 MB for review), uncompressed and uncacheable, on every
page load: ~10 s per open over a 2-3 MB/s link.

| | first open | later opens (alternating annotate-last / review) |
|---|---|---|
| upstream | 10.5 s / 7.8 s | same |
| fork | 0.9 s / 0.8 s | 0.3 s / 0.35 s |

Measured with Chromium throttled to 2.5 MB/s and 40 ms RTT, real servers,
restarted on one fixed port between opens.

1. **Cacheable app shell** (`packages/server/app-shell.ts`). `/` returns a ~1 KB
   HTML shell (`no-cache` + ETag). Scripts, styles, and assets live under
   content-hashed `/_app/` URLs served `immutable`, so the browser keeps them
   across sessions and the plan and review apps are cached side by side.
   Text responses, including JSON API payloads such as `/api/diff`, are gzipped
   for non-loopback requests; loopback (local) sessions are not compressed.
2. **Code-split UI build** (`apps/{hook,review}/vite.split.config.ts`,
   `scripts/fork/`). Alongside the upstream single-file build, both apps are
   also built code-split, so diagrams, math, and most syntax-highlighting
   grammars only load when a page uses them. `scripts/fork/pack-split-assets.ts`
   packs both builds into `apps/hook/dist/app-split.txt`, which the binary
   embeds. The CLI serves the split UI when present, otherwise the single-file
   UI (still split at runtime by step 1).

Set `PLANNOTATOR_SINGLE_FILE_UI=1` to force the single-file pages.

Caching depends on a stable origin: remote mode always uses port 19432 and
`urlHost: "auto"` advertises the runner's MagicDNS name, so the URL is the same
every session. `--tailscale` sessions use a random port unless
`PLANNOTATOR_PORT` is set, which would defeat the cache.

Only the Bun server is changed; the Pi extension server is not.

### Upstream files touched

Everything else is new files, so upstream merges should rarely conflict.

- `packages/server/{index,review,annotate}.ts`: `Bun.serve(withAppShell(htmlContent, {...}))`
  and the SPA catch-all `return serveAppShell(req, htmlContent)`, plus one import each.
- `packages/server/package.json`: the `./app-shell` export.
- `apps/hook/server/index.ts`: the split bundle import and choosing
  `planHtmlContent` / `reviewHtmlContent`.
- `apps/hook/package.json`, `apps/review/package.json`: `build` scripts also
  run the split build and the pack step.

## Pulling in upstream updates

One-time setup:

```bash
git remote add upstream https://github.com/backnotprop/plannotator.git
```

Then, for each update:

```bash
git fetch upstream
git checkout main
git merge upstream/main          # or: git rebase upstream/main
# resolve conflicts, if any, in the files listed above
bun install
bun test packages/server/app-shell.test.ts
scripts/fork/build-binary.sh
```

If an upstream change adds another `Bun.serve` server that serves the UI,
wrap it the same way.

## Building and installing

The runner is macOS on Apple silicon, like the laptop, so build locally and
copy the binary over:

```bash
bun upgrade                                     # needs bun >= 1.3.14
scripts/fork/build-binary.sh --install <user>@zilis-mac-mini.tail57dfdc.ts.net
```

That builds `dist/plannotator-fork` and installs it as
`~/.local/bin/plannotator-fork` on the runner. Point the Amp plugin at it by
setting, in the environment Amp runs with on the runner:

```bash
export PLANNOTATOR_BIN="$HOME/.local/bin/plannotator-fork"
```

The official `~/.local/bin/plannotator` stays untouched: unset
`PLANNOTATOR_BIN` to go back, and re-running the official installer never
overwrites the fork. Alternatively, copy the fork binary over
`~/.local/bin/plannotator` (the plugin's default), knowing the official
installer would replace it.

The laptop needs nothing installed; it only runs the browser.
