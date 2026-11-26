# Nexium Studio

A local desktop code editor built with **Tauri 2 + Rust** on the outside and **React 19 + TypeScript + Monaco** on the inside. It opens a folder from your disk, edits real files through a Monaco editor, and ships an AI assistant that runs on **NVIDIA NIM** — the assistant reads, searches and writes the files in the folder you have open, streaming its answer token by token while it works.

The interface is built from three values per theme — a page colour, an ink and an accent — with every surface, hairline and overlay mixed from them; the default Nexium theme is pure black with white ink, bundled Inter and JetBrains Mono. Colour is spent on two things only: the theme accent (selections, focus, caret) and code — each theme carries a syntax palette for keywords, strings, numbers, types, tags, attributes and comments, and themes without a palette of their own draw keywords and tags in their accent, so the code carries some of the chosen theme's colour without losing the reading colours of strings, numbers and comments.

---

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Getting an NVIDIA API key](#getting-an-nvidia-api-key)
- [Scripts](#scripts)
- [How the assistant works](#how-the-assistant-works)
- [Model verification and fallback](#model-verification-and-fallback)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Architecture](#architecture)
- [Project layout](#project-layout)
- [Security model](#security-model)
- [Where data lives](#where-data-lives)
- [Building a release](#building-a-release)
- [Browser-only development](#browser-only-development)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## Features

### Editor workspace

- **Open or start a project** from the title bar's **File** menu (or the Explorer header, or the empty state). **Open Project…** picks an existing folder; **New Project…** asks for a name and location in a native save dialog, creates the folder in Rust (`create_workspace`), and opens it empty. The folder tree is read on the Rust side and streamed to the UI as a snapshot.
- **Explorer** with per-extension file icons, folders collapsed by default, inline rename, a right-click context menu (Ask AI about this file/folder, New File, New Folder, Rename, Copy Path, Delete) and a hide toggle. Delete always opens a confirmation dialog naming the target — Cancel is focused, Escape and a backdrop click cancel, and folders warn that everything inside goes with them.
- **Editor bar**: the open file as a raised tab with dirty marker and close button, the path as mono breadcrumbs beside it (hidden for root-level files where it would repeat the tab), and, grouped on the right, the Preview toggle and the Save control with its ⌘S keycap (disabled while the buffer is clean).
- **Status bar** in six segments: transient notices (when there is one), branch with a change-count badge (opens Source Control), relative path, language, `Ln/Col` from the Monaco caret, `UTF-8`, and the assistant model (opens Settings).
- **Source control panel** (Git): the branch, every staged and unstaged change, per-file stage/unstage, stage/unstage all, and a commit box. Git runs as a subprocess on the Rust side, in the folder you have open; the panel is read-only about history — no history rewriting, no force operations.
- **Markdown preview**: opening a `.md`, `.markdown` or `.mdx` file shows a **Preview** toggle in the tab strip that splits the pane — rendered document beside the editor, rendered from the live buffer with the same component map as assistant replies. Scrolling either side moves the other to the same source line, anchored on the rendered blocks rather than a flat percentage.
- **Font files**: `.woff2`, `.woff`, `.ttf` and `.otf` have no text to edit, so selecting one opens a specimen in the editor area instead of an empty pane: the bytes are read in Rust (`read_media_file`, the same 16 MB-capped binary path as images, now also mapping `font/woff2`, `font/woff`, `font/ttf` and `font/otf`) and injected as an `@font-face` data URL, then the face is drawn with “The quick brown fox jumps over the lazy dog”, an alphabet/digit sample and a 13/17/21 px ladder, with a footer for the file's extension, size and path. The browser demo has no face bytes, so it shows the same specimen in the bundled mono font and says so.
- **SVG preview**: the same **Preview** toggle appears for `.svg` files and splits the pane with the image the browser draws from the live buffer, sized to fit a 16 px grid with its intrinsic dimensions in the pane header. It is rendered through a `data:` URL in an `<img>`, so a file's own scripts and external references never touch the editor.
- **Image files**: opening a `.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`, `.bmp`, `.ico` or `.avif` puts the image itself in the editor area — there is no text to edit, so Save and the Preview toggle are hidden, and a footer shows its dimensions, format and path. The bytes are read in Rust (`read_media_file`, limited to the open folder and 16 MB) and handed to the webview as a data URL, so the webview never reads the disk itself.
- **Node built-ins in the editor**: the TypeScript worker has no `@types/node`, so `node:path`, `node:fs`, `node:fs/promises`, `node:os`, `node:url`, `node:util`, `node:crypto`, `node:events`, `node:child_process`, `node:stream`, `node:buffer`, `node:module`, `node:http`/`https`, `node:assert`, `node:zlib`, `node:worker_threads`, `node:tty` plus the `process`, `Buffer`, `require`, `__dirname` globals are declared in the worker's ambient lib. Without that, a build config importing `node:path` showed “Cannot find module 'node:path'” (TS 2307) even though `tsc` resolves it. The declarations are intentionally loose; the real check is still `tsc` during the build.
- **Syntax highlighting for every text type**: Monaco ships 84 grammars (TypeScript/JavaScript, Rust, Python, Go, Java, Kotlin, Swift, C/C++, C#, PHP, Ruby, Shell, PowerShell, SQL, YAML, XML/HTML/SVG, CSS/SCSS/Less, Markdown/MDX, Dockerfile, …), the app adds a TOML grammar of its own (Cargo.toml, pyproject.toml), and paths Monaco does not know are mapped onto the closest grammar — `.env*`/`.conf`/`.properties` → INI, `.vue`/`.svelte`/`.astro` → HTML, `Cargo.lock` → TOML, `bun.lock` → JSON, `Makefile`/`.mk`/gemfile/ignore files → Shell. Anything left stays plain text rather than guessing.
- **Monaco** with a `nexium` theme rebuilt from the active palette: full-line gutter-less highlighting driven by the theme's own syntax palette (keywords, strings, numbers, types, variables, functions, tags, attribute names/values, comments — dark, light and per-theme palettes such as Dracula, Nord, Gruvbox, Solarized, Tokyo Night, Monokai, Catppuccin, Rosé Pine, One Dark, GitHub Dark/Light, Night Owl, Kanagawa, Everforest, Cobalt2 and Zenburn), a self-contained rule set with nothing inherited from `vs-dark`/`vs`, 2px cursor, indent guides, bracket colourisation from the same palette, and automatic language detection for any extension Monaco knows (plus `.tsx`/`.jsx`/`.mts`/`.cts`/`.mjs`/`.cjs` mapped onto the TypeScript and JavaScript modes). Nexium, Graphite, Daylight, Paper, Glacier, Forest, Ocean and Sunset share one syntax palette, so for them keywords and tags are drawn in the theme accent (nudged toward the ink until they clear a 4.5:1 contrast ratio) while strings, numbers, types, attributes and comments keep their own colours; the hand-made palettes already match their themes and are used as-is. A neutral accent (Nexium, Graphite, Daylight) has no hue to lend and leaves the palette untouched.
- **Custom title bar**: the native Windows decorations are disabled (`"decorations": false`). The header is identity until the project chip is clicked: clicking it reveals the **File**, **Edit**, **View** and **Help** menu bar and opens File, and closing the menu hides the bar again. File carries the project actions plus **Reveal in Explorer**, Edit carries Undo, Redo, Find and Find and Replace for the active editor, View shows or hides the Explorer, Source Control, the assistant and the Markdown/SVG preview (disabled when the open file has none), and Help opens **About Nexium** (version from the desktop shell, or “Development build” in the browser) in a modal that closes on Escape, its button or a backdrop click. The header also owns the relative path, dragging regions and minimize, maximize/restore and close buttons; file actions on the open file still live one row below, so the title bar never competes with the editor.
- **No native right-click menu**: the webview's own context menu (Reload, Save as, Print, Inspect) is suppressed for the whole window in `src/main.tsx`, so right-clicking the title bar, sidebars, status bar or settings never drops a browser menu into the app. Only the platform menu goes away — the app's own menus still open where they belong (Explorer rows, Monaco in the editor) and their keyboard equivalents (Ctrl+X/C/V, Ctrl+S) are untouched.
- **Browser shortcuts belong to the editor**: WebView2 handles Ctrl+F, Ctrl+H, Ctrl+P and F5 itself, before the page sees them, which put its own find bar across the top of the window instead of Monaco's. `hand_shortcuts_to_the_page` (in `src-tauri/src/lib.rs`) turns those browser accelerators off through `ICoreWebView2Settings3::AreBrowserAcceleratorKeysEnabled`, so Find and Find & Replace open as Monaco's floating widget over the code and the text-editing keys (Ctrl+X/C/V/A/Z, arrows, Home/End) are untouched. Ctrl+R and F5 are re-implemented in `src/main.tsx` as a plain page reload, because the shell's dev server runs without HMR; Ctrl+P, Ctrl+U and F12 are no longer handled by the webview.
- **Right sidebar**: the assistant lives in its own 340 px sidebar, with a rail on the window edge that only opens and closes it; full screen, Settings and hide sit in the panel header, where the actions belong.
- **Full-screen assistant**: the chat can take over the whole window, hiding the activity rail, explorer, editor and status bar and centring a 760px column — with an explorer toggle so you can still browse while you talk to it. `Escape` or the minimise button returns to the editor.

### Assistant

- **Real streaming**, not a static spinner: assistant text, reasoning and tool activity all arrive incrementally from Rust over Tauri events (`agent-delta`, `agent-step`).
- **Tool calling on your real files**: `list_files`, `read_file`, `write_file`, `search_text` — each call is shown as a step note ("Reading src/App.tsx", "Searching for `useEffect`"), and writes are persisted to disk and pushed to the open editor through the `workspace:file-changed` event.
- **AI inline completions**: typing pauses for a moment and the selected model is asked for the next few tokens of the file — its answer appears as grey ghost text at the caret, `Tab` accepts it and `Escape` dismisses it, and nothing is inserted on its own. The provider (`src/lib/inlineCompletion.ts`) sends only the ~2.6 KB before the cursor and ~600 bytes after it, debounces keystrokes by 700 ms, drops any answer that newer typing has already superseded, caches answers per cursor position, and silently gives up when the model is slow, errors or the free tier rate-limits. It is driven by the key and model verified in Settings and never runs without both.
- **Ask AI from the right-click menu**: right-clicking inside the editor offers **Ask AI about this file**, and highlighting code turns the menu selection-aware: **Explain this selection**, **Refactor this selection**, **Find bugs in this selection** and **Document this selection** each seed the composer with that question plus the highlighted lines; the explorer's menu offers the same for the file or folder under the pointer. Each one opens the assistant if it was hidden and pre-fills the composer with a ready prompt — the highlighted lines travel inside the message with their path and line range, while file and folder prompts name the path for the assistant's own tools — caret at the end, nothing sent until you press Enter.
- **Markdown rendering** of replies (GFM tables, lists, code blocks, inline code) through a monochrome component map — no raw HTML is ever injected.
- **Auto-follow while generating**, which pauses the moment you scroll up and offers a "jump to latest" chevron instead of fighting you.
- **Stop button** that cancels the in-flight request on the Rust side (`nim_cancel`), so a runaway generation cannot keep writing files.
- **Model switcher inside the composer**: pick any verified model without leaving the chat; the menu opens upward and shows each model's measured latency.
- **Stall handling**: if a model produces no data for five minutes, the request is retried once with your fastest verified model and a step note explains the swap.

### Settings

- The **Settings** page (left rail, gear) is the single home for the assistant: an **AI assistant** section with a **Connection** card (masked key entry, save and verify, test connection, remove key) and a **Models** card (verified models with latency, fastest-first, radio pick). Verification probes every catalogue model with a real 1-token request.
- An **Appearance** page with twenty-four themes — Nexium, Graphite, Daylight, Paper, Glacier, Dracula, Nord, Forest, Ocean, Sunset, Rosé Pine, Gruvbox, Solarized, Tokyo Night, Monokai, Catppuccin, One Dark, GitHub Dark, GitHub Light, Night Owl, Kanagawa, Everforest, Cobalt2 and Zenburn — picked from a card grid and applied instantly. Themes set a page colour, an ink and an accent on `<html>`; every panel, hairline, overlay and the Monaco palette are mixed from those three, so light themes stay legible and the choice is remembered in `localStorage` (`nexium-theme`).
- A **Fonts** page that shows the two faces the window actually uses, at the weights it ships: **JetBrains Mono** (the editor, diffs, the explorer and every monospaced label) and **Inter** (panels, menus, the assistant). Each face lists its weights and renders “The quick brown fox jumps over the lazy dog” in that face and weight, so the shapes can be compared at a glance; it is a reference page, not a picker — the app keeps its bundled faces rather than borrowing installed system fonts.
- Settings takes over the window: the left sidebar becomes a list of option pages (**Appearance**, **Fonts**, **AI assistant**, **Source control**) with the back arrow above it, and the editor area shows the selected page only. Opening settings closes the left panel (explorer or source control) and the assistant, hiding the assistant rail, and closing the tab lives off that state — nothing stays technically open behind the settings page; leaving settings reopens whichever panel was showing and the assistant if it had been open.
- A **Source control** page: the git identity git uses for commits (`user.name` / `user.email`), read from the effective config and shown as `configured` or `not set`. Saving writes both values to the global git config, which is where commits look for an author; validation rejects an empty name or an address without `@`.
- Settings are stored locally and never leave the machine except as the `Authorization` header of your own NIM requests.

---

## Requirements

| Requirement | Notes |
| --- | --- |
| **Windows 10/11** | The custom title bar is tuned for Windows; Tauri itself runs elsewhere but this app is developed and tested on Windows. |
| **WebView2 runtime** | Preinstalled on Windows 11 and current Windows 10. If the window is blank, install the Evergreen runtime from Microsoft. |
| **Node.js 20.19+ or 22.12+** | Required by Vite 8. The repo ships a `bun.lock`; `bun` or `npm` 10+ both work. |
| **Rust (stable) + MSVC toolchain** | `rustup default stable` and the "Desktop development with C++" workload from Visual Studio Build Tools. |
| **NVIDIA API key** | Only needed for the assistant; the editor works without one. |

---

## Quick start

```bash
# 1. install the frontend dependencies (the repo ships a bun.lock; npm works too)
bun install        # or: npm install

# 2. run the app (Vite on 127.0.0.1:5173 + the Tauri window)
npm run desktop
```

The first `npm run desktop` compiles the Rust crate, which takes a few minutes. Later runs start in seconds.

Then:

1. Click the folder icon in the **Explorer** header (or the empty state) and pick a project folder.
2. Open the assistant from the activity rail, press **Settings**, paste your `nvapi-…` key and hit **Verify**.
3. Wait for the model list — models are probed with a real request, so only the ones that actually answer appear, sorted fastest first.
4. Ask it to change something. It will read files, make the edit and the editor will refresh.

---

## Getting an NVIDIA API key

1. Go to <https://build.nvidia.com> and sign in.
2. Open **API Keys** and create one; it looks like `nvapi-xxxxxxxx…`.
3. Paste it into **Settings** inside the app.

Keys are stored in the WebView's `localStorage`, are only read by the app's own Rust code, and are sent only to `https://integrate.api.nvidia.com`. The free tier is rate-limited (roughly 40 requests per minute), so very long agent runs can hit a 429 — see [Troubleshooting](#troubleshooting).

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server only, at <http://127.0.0.1:5173>. Runs the UI in the browser against a demo workspace (see [Browser-only development](#browser-only-development)). |
| `npm run desktop` | `tauri dev` — starts Vite, compiles the Rust crate and opens the real window. |
| `npm run dev:desktop` | The Vite half of `tauri dev`, run in `desktop` mode: same proxy and port, **no HMR** — the shell can edit this project without a saved file reloading the window. |
| `npm run build` | `tsc --noEmit && vite build` — type-checks the whole frontend and writes `dist/`. |
| `npm run desktop:build` | `tauri build` — release build, installers under `src-tauri/target/release/bundle/`. |
| `npm run preview` | Serves the built `dist/` (still using the `/nim` proxy). |
| `npm run tauri -- <args>` | Escape hatch to any Tauri CLI command. |

The window is pinned to port 5173 (`strictPort: true`) because `tauri.conf.json` points its `devUrl` there — a second `npm run desktop` will fail with *"Port 5173 is already in use"* instead of quietly moving to another port.

---

## How the assistant works

Nothing about the assistant happens in the webview except rendering. The API key, the HTTP client, the tool loop and all filesystem access live in Rust (`src-tauri/src/agent.rs`, `nim.rs`, `workspace.rs`).

1. The UI sends the conversation plus the workspace root to the `nim_agent` command.
2. Rust calls `POST /v1/chat/completions` on `integrate.api.nvidia.com` with the tool schema, streams deltas back as `agent-delta` events, and shows reasoning separately from the answer.
3. When the model calls a tool, Rust executes it against the open folder, emits the result as an `agent-step` note (and `workspace:file-changed` for writes), then loops back to the model with the tool output.
4. When the model stops calling tools, the final message is returned and the UI settles on it. If it spends every step on tools, the loop asks once more with the tools removed — "answer with what you have already read" — so a long exploration still ends in prose instead of an error note.

Hard limits, chosen so a confused model can never spin forever or rewrite a huge file:

| Limit | Value |
| --- | --- |
| Agent loop steps per request | 8 (then one tool-free answer) |
| Characters of context sent per request | 24 000 |
| Tool output kept per call | 40 000 chars |
| Characters a single `write_file` may write | 200 000 |
| Silence before the request is considered stalled | 300 s |
| Total request budget | 900 s |
| File the editor will open | 2 MB |
| Entries in the explorer snapshot | 5 000 |

Folders that would swamp the tree or the model (`node_modules`, `.git`, `target`, `dist`, `build`, `.next`, `.svelte-kit`, `.turbo`, `.venv`, `__pycache__`) are skipped when the workspace is read.

---

## Model verification and fallback

NVIDIA's model catalogue is not a capability list: a model can exist and still reject chat completions, be offline, or be unusably slow. So **Verify** in Settings probes each catalogue model with a minimal 1-token request and keeps only the ones that answer, recording the round-trip time.

- The picker is ordered fastest-first, with the measured latency shown next to each model.
- Verification results and latencies are cached until you verify again.
- If the selected model sends no data for five minutes, the request is retried once with the fastest verified model instead of leaving you on a dead model.

---

## Source control

Open the branch icon in the activity rail. The panel reads `git status --porcelain=v1 -z --untracked-files=all` in the open folder — the untracked flag matters, otherwise git reports a new folder as one `?? folder/` entry and its files would never appear — and shows:

- the current branch (or `HEAD <sha>` when detached, `no commits yet` on a fresh repo), a change count in the header badge and a `clean` marker;
- **Staged** and **Changes** groups with counts, each rendered as a folder tree: directories show a folder icon and how many changed files sit below them, files are indented under their folder with their porcelain status in a small badge (`M`, `A`, `D`, `R`, `C`, `U` for untracked). Clicking a file opens its diff in the editor (deleted files are struck through and not clickable);
- a per-row **Stage** / **Unstage** action on hover, plus **Stage all** / **Unstage all** per group;
- a commit card: the message field explains what is staged, the **Commit** button enables once something is staged and a message is written (`Ctrl`/`Cmd` + `Enter` submits), and a successful commit clears the message, reloads the list and falls back to the “Working tree clean” state. The caret beside it opens the commit options — **Commit** and **Commit & Sync**; the panel only ever lists local commits, so syncing is what sends them to the remote: it pushes the current branch to its upstream, or sets `origin` as the upstream when the branch has none, and nothing is pulled, merged or rebased. A **Generate** button at the top right of the message field writes the message with the assistant's selected model from the staged file list and the lines around each change; it is disabled until a model is configured and something is staged, and a failure is reported in the line under the field instead of overwriting the message.

A change opens as a read-only side-by-side diff in the editor area, titled `HEAD → staged` for a staged change (the index against `HEAD`) or `HEAD → working tree` for everything else (the file on disk against `HEAD`), with the file's own language, the app's fonts and the active `nexium` theme; the header carries the path and a close button that returns to the editor. A new file, or any file in a repository without commits, diffs against empty. The two sides are Monaco models owned by the diff pane: they are created per open and disposed after the widget is gone, so opening and closing diffs repeatedly leaks nothing.

Every action returns the fresh status, so the panel never shows a stale tree. Saving a file or the assistant writing one refreshes it too. If the folder is not a repository the panel says so and suggests `git init`; git errors (missing identity, empty index, hooks) are shown verbatim in the panel footer. Nothing is ever committed automatically, and no history-rewriting command is reachable from the UI.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl`/`Cmd` + `S` | Save the active file |
| `Ctrl`/`Cmd` + `F` | Find in the active file — Monaco's widget, floating over the code |
| `Ctrl`/`Cmd` + `H` | Find and replace in the active file (adds the replace row to the same widget) |
| `Ctrl`/`Cmd` + `R`, `F5` | Reload the desktop window (the shell runs Vite without HMR) |
| `Escape` | Leave full-screen assistant mode, close the explorer's inline draft, or dismiss a context menu |
| `Enter` (in the composer) | Send the message |
| `Shift` + `Enter` | New line in the composer |
| `Enter` / `Escape` (in the explorer draft) | Commit / cancel a new file or rename |
| `Ctrl`/`Cmd` + `Enter` (in the commit box) | Commit the staged changes |

---

## Architecture

```
┌───────────────────── WebView (React) ─────────────────────┐
│  App.tsx  ── shell, tabs, status bar, full-screen mode    │
│  Explorer · CodeEditor (Monaco) · AiAssistant · Settings  │
│  lib/tauriBridge.ts  (typed invoke wrappers + isTauri)    │
└───────────────▲───────────────────────────┬───────────────┘
                │ events                    │ invoke
                │ agent-delta/step          │ nim_agent, read_workspace_file …
┌───────────────┴───────────────────────────▼───────────────┐
│                    Rust core (src-tauri)                  │
│  workspace.rs  safe path joining, tree, read/write/search │
│  nim.rs        catalogue, streaming chat, probes, cancel  │
│  agent.rs      tool loop, system prompt, event emission   │
└───────────────────────────┬───────────────────────────────┘
                            │ HTTPS (key never reaches JS)
                 integrate.api.nvidia.com
```

Design decisions worth knowing before changing things:

- **Filesystem and credentials stay in Rust.** The webview cannot read arbitrary paths; every command resolves paths through `workspace::safe_join`, which rejects `..`, absolute paths and drive prefixes so nothing outside the open folder can be touched.
- **The webview sends relative paths only.** Tools and editor commands share the same resolution rules, so a model and a click behave identically.
- **Errors cross the bridge as plain strings.** Tauri rejects with `Err(String)`, so `toError()` in `tauriBridge.ts` normalises them instead of letting `instanceof Error` hide real failures.
- **No HTML injection in chat.** Markdown is rendered by `react-markdown` + `remark-gfm` with a monochrome component map; raw HTML is not enabled.
- **One source of truth for the theme.** `src/index.css` defines the `--color-line` tokens and the layered black surfaces; components use those tokens plus hairline borders rather than ad-hoc colours.

---

## Project layout

```
Nexium-IDE/
├── index.html                  # Vite entry
├── package.json                # scripts + frontend deps
├── vite.config.ts              # 127.0.0.1:5173 (strict), /nim proxy, Monaco helpers
├── tsconfig.json               # strict, noUnused*, isolatedModules
├── public/fonts/               # bundled Inter + JetBrains Mono (woff2)
├── src/
│   ├── App.tsx                 # shell: header, rail, explorer, tabs, editor, status bar, settings route
│   ├── index.css               # theme tokens mixed from --nx-bg/--nx-fg/--nx-accent, fonts, base styles
│   ├── components/
│   │   ├── ActivityRail.tsx    # 52px icon rail (explorer, source control, settings)
│   │   ├── AssistantRail.tsx   # 52px rail on the right (assistant toggle)
│   │   ├── ConfirmDialog.tsx   # modal guard for permanent actions
│   │   ├── Explorer.tsx        # tree, icons, inline draft, context menu wiring
│   │   ├── ExplorerContextMenu.tsx
│   │   ├── AppearanceSettings.tsx # twenty-four-theme picker with live previews
│   │   ├── FontsSettings.tsx   # the bundled faces, shown with the pangram
│   │   ├── CodeEditor.tsx      # Monaco host, theme "nexium" built from the palette
│   │   ├── AiAssistant.tsx     # chat panel and full-screen mode, composer, model menu
│   │   ├── MarkdownMessage.tsx # markdown → monochrome components
│   │   ├── MarkdownPreview.tsx # rendered markdown beside the editor, line-synced
│   │   ├── SvgPreview.tsx      # rendered SVG beside the editor
│   │   ├── ImagePreview.tsx    # png/jpeg/gif/webp/bmp/ico/avif drawn in the editor
│   │   ├── FontPreview.tsx     # woff2/woff/ttf/otf drawn as a specimen
│   │   ├── SettingsPage.tsx    # key entry, verification, latency list
│   │   ├── SourceControlPanel.tsx # branch, changes, staging, commit box
│   │   ├── DiffView.tsx        # read-only side-by-side diff of one change
│   │   └── WindowControls.tsx  # custom minimise / maximise / close
│   └── lib/
│       ├── themes.ts           # the twenty-four themes, persistence, applyTheme()
│       ├── tauriBridge.ts      # invoke wrappers, isTauri(), toError()
│       ├── workspaceFs.ts      # browser demo workspace + shared fs types
│       ├── workspaceModels.ts  # Monaco model registry per open file
│       ├── languages.ts        # path → Monaco language id
│       ├── media.ts            # image and font paths → data URL from Rust
│       ├── monacoSetup.ts      # worker setup and theme
│       ├── git.ts              # status/stage/commit wrappers + browser demo repo
│       ├── nim.ts              # model catalogue, verification, chat calls
│       ├── assistantPrompt.ts  # right-click selection/file prompts for the composer
│       ├── inlineCompletion.ts # ghost-text AI completions in the editor
│       └── assistantSettings.ts# localStorage persistence
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json         # window (undecorated, centered), dev/build hooks, bundle targets
    ├── capabilities/default.json # core + dialog + window permissions
    └── src/
        ├── main.rs             # thin binary wrapper
        ├── lib.rs              # commands, builder, dialog plugin, state
        ├── workspace.rs        # safe_join, tree snapshot, read/write/search, tests
        ├── git.rs              # porcelain parser, diff sides, stage/unstage, commit
        ├── nim.rs              # NIM client, streaming SSE parser, probes, cancellation
        └── agent.rs            # tool schema, tool loop, step notes, write events
```

---

## Security model

- The API key is typed into the UI, persisted in `localStorage`, and passed to Rust per request. It is **never** placed in a URL, a log line or a file on disk by the app.
- Every filesystem command is confined to the folder you opened (`safe_join`); `delete_workspace_entry` and `rename_workspace_entry` refuse anything that resolves outside it.
- Tauri capabilities are minimal: `core:default`, `dialog:default`, and only the five window permissions the custom title bar needs (`minimize`, `toggle-maximize`, `is-maximized`, `close`, `start-dragging`).
- Assistant output is rendered as Markdown without HTML, so a model cannot inject markup or script into the window.
- Writes performed by the assistant go through the same path checks as your own edits, and the UI is told which file changed so the editor never shows stale content. Deleting asks for confirmation first and is the only destructive action in the app.
- Source control shells out to `git` inside the open folder, only ever with `status --untracked-files=all`, `show` (read-only, for the diff sides), `add`, `restore`, `reset`, `rm --cached`, `commit -m` and `push` (with `GIT_TERMINAL_PROMPT=0`, so a credential prompt fails instead of blocking the window); paths are passed after `--` so they cannot be read as options.

---

## Where data lives

| Data | Location |
| --- | --- |
| API key, chosen model, verified models, latencies | WebView `localStorage`, key `nexium.assistant.nim` |
| Conversation | In memory for the session (cleared when the window closes) |
| Your project files | Untouched on disk until you or the assistant saves |

Reset the assistant by clearing that `localStorage` key (or pasting a new key in Settings). Nothing else is written outside your project folder.

---

## Building a release

```bash
npm run desktop:build
```

The installer and binaries are produced under `src-tauri/target/release/bundle/` (MSI and NSIS on Windows). The release profile uses `lto = true`, `codegen-units = 1` and `opt-level = "s"` to keep the binary small; the first release build is slow, subsequent ones reuse the cache.

---

## Browser-only development

`npm run dev` runs the UI without Tauri. In that mode:

- `isTauri()` is false, so filesystem calls fall back to an in-memory demo workspace (`workspaceFs.ts`) — you can click around, open files and edit them, but nothing is written to disk.
- The custom window buttons render nothing (there is no window to control).
- Assistant requests go through the Vite `/nim` proxy to `integrate.api.nvidia.com`, because NVIDIA's API sends no CORS headers. The proxy also exists in `vite preview`, so a built `dist/` can be tested the same way.

This mode is for UI work; anything involving real files, permissions or window behaviour must be checked in `npm run desktop`.

---

## Tests

```bash
cd src-tauri
cargo test --lib
```

The Rust suite covers path sandboxing (`safe_join` rejects escapes), workspace reads/writes and the NIM SSE parser. One test is marked `#[ignore]` because it performs a live request against NVIDIA's API with a deliberately bogus key; run it explicitly when you want to check the authorisation error path:

```bash
cargo test --lib -- --ignored
```

The frontend has no unit-test suite; `npm run build` runs the strict TypeScript check that guards the UI.

---

## Troubleshooting

**"Port 5173 is already in use."**
Another `npm run desktop` (or a stray `vite`) is still running. Close the app window and stop the old process, then run again. The port is pinned on purpose so the Tauri window never points at a dead URL.

**The window is blank / white.**
WebView2 is missing or broken. Install the Microsoft Edge WebView2 Evergreen runtime and relaunch.

**`cargo` not found, or a linker error during the first build.**
Install Rust with rustup and the MSVC build tools ("Desktop development with C++"). Then `npm run desktop` again.

**The assistant says the key is invalid (401).**
The key is truncated or revoked. Create a fresh one at <https://build.nvidia.com> → API Keys and verify again.

**429 / "rate limit" during a long task.**
The free tier allows roughly 40 requests per minute, and an agent turn spends several (one per tool step). Wait a minute, ask for a smaller change, or use a faster model from the composer's model menu.

**No models in the list after Verify.**
Verification only keeps models that answered a real probe. If every probe failed, the key or the network is the problem — check "test connection" first.

**A model goes silent mid-answer.**
After five minutes without data the request retries once on your fastest verified model. If it still stalls, stop and switch models.

**The root of the window can't be dragged.**
Dragging only works on the title bar's empty areas, the brand and the breadcrumb (`data-tauri-drag-region`); buttons are excluded on purpose.

---

## Limitations

- One folder per window; there is no multi-root workspace.
- No integrated terminal, debugger, git panel or extensions.
- Monaco's TypeScript worker only sees the files the app hands it, so imports from unopened packages resolve only through the bundled ambient shim for `lucide-react`.
- The assistant writes whole files (`write_file` replaces the file), not patches.
- The custom title bar is Windows-shaped: no double-click-to-maximize, and the resize borders come from the native frame that stays underneath.
- Editing is local-only; there is no sync, account or cloud storage.
