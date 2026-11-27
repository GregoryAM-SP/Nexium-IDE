<p align="center">
  <img src="public/nexium.svg" width="112" height="112" alt="Nexium Studio icon">
</p>

<h1 align="center">Nexium Studio</h1>

A local desktop code editor built with **Tauri 2 + Rust** on the outside and **React 19 + TypeScript + Monaco** on the inside. It opens a folder from your disk, edits real files through a Monaco editor, and ships an AI assistant that runs on **any OpenAI-compatible provider** — NVIDIA NIM, Groq, Gemini, OpenRouter, Mistral, a local Ollama and about ninety more presets — the assistant reads, searches and writes the files in the folder you have open, streaming its answer token by token while it works.

The interface is built from three values per theme — a page colour, an ink and an accent — with every surface, hairline and overlay mixed from them; the default Nexium theme is pure black with white ink, bundled Inter and JetBrains Mono. Colour is spent on two things only: the theme accent (selections, focus, caret) and code — each theme carries a syntax palette for keywords, strings, numbers, types, tags, attributes and comments, and themes without a palette of their own draw keywords and tags in their accent, so the code carries some of the chosen theme's colour without losing the reading colours of strings, numbers and comments.

---

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Connecting a provider](#connecting-a-provider)
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
- **Source control panel** (Git): the branch, every staged and unstaged change, per-file stage/unstage, stage/unstage all, a commit box, and a **Tags** list to create, push and delete version tags. Git runs as a subprocess on the Rust side, in the folder you have open; the panel is read-only about history — no history rewriting, no force operations.
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
- **Tool calling on your real files**: `list_files`, `read_file`, `search_text`, `edit_file` (replaces one exact, unique piece of text, and matches LF text against CRLF files) and `write_file` (new files or full rewrites). Each call appears as a step with its own icon and a clickable file path. Accepted writes are saved to disk and pushed to the open editor through the `workspace:file-changed` event.
- **Review before writing**: every edit the assistant proposes appears in the chat as a compact diff with **Accept** and **Reject** (and a button to open it in the full diff view). Nothing reaches the disk until you accept it. A rejected edit is reported back to the model, which is told not to repeat it. The composer's **Review edits / Auto-apply edits** toggle (remembered in `localStorage`) skips the review when you trust the run.
- **One timeline per turn**: text, thinking and tool steps appear in the order they happened, and consecutive steps are grouped. Earlier turns go back to the model with a short note of the files they read or changed, so it does not start from scratch each turn. The open file is added to the assistant's single system prompt instead of being sent as a second one.
- **Message actions**: Retry re-asks the last question in place of the failed or unwanted answer, Copy copies an answer as Markdown, and code blocks have **Copy** and **Insert** (at the editor cursor, as one undoable edit). **New session** (the pen icon) starts a fresh conversation; the previous one is saved and keeps running if it was working. A run that ends with work left (see **Runs to completion**) offers **Continue**.
- **Objectives**: for a request that needs more than one change or touches several files, the assistant first writes a short checklist of objectives (2–6 items) and ticks them off as it works. The **Objectives** card closes the turn, below its text, with an `n/m` count and a progress bar. It shows one objective at a time: the one being worked on (spinning while the run works), else the next one, or "All n objectives done". Click it to list every objective as pending, in progress or done, and click again to go back to one. While the run works the card stays in view at the bottom of the chat. Questions and single small edits get no checklist. The list goes back to the model with the turn, so **Continue** or "keep going" picks up the unfinished items.
- **Sessions**: every conversation is a session, saved in a SQLite database (see [Where data lives](#where-data-lives)) per project folder, so it is still there after a restart; opening a folder reopens its latest session. The session name in the assistant's header opens the list of the project's sessions: switch between them, **rename**, **archive** (hidden until **Show archived**, and reversible) or **delete** (asks first; removes the session and its messages for good). A session's name comes from its first message.
- **Sessions working side by side**: several sessions can run at the same time, each with its own Stop, approvals and progress; the header shows how many others are working. They coordinate so one does not undo or refactor another's work:
  - A file a session edits is **locked** to it while it runs. Another session that tries to edit it is told who holds it and works around it (other files first, or a note asking for what it needs); the lock is released when the run ends.
  - Each session starts with a picture of the others: what they are working on (their open objectives), which files they hold, and their recent changes and notes. While it works, changes and notes from the others arrive with its tool results, with a warning when they touched a file it had read.
  - A whole-file rewrite is refused if the file changed since the session read it (or it never read it), so a stale copy can never overwrite someone else's change.
  - `session_status` lets the model check on the others at any time, and `message_sessions` leaves them a note (for example "renamed `login()` to `signIn()`").
- **Commands**: the assistant can run the project's tests, type-check, build or lint with `run_command` to check its own work. Each command is shown for **Run** / **Reject** like an edit (or runs straight away with Auto-approve), in the project folder, non-interactive (`CI=1`, no input), and is stopped after 120 s by default (600 s at most) or when you press Stop, along with anything it started. The output (its start and, mostly, its end) and exit code go back to the model.
- **Works like an engineer**: the system prompt sets a workflow (understand the code first, plan with objectives, make focused changes in the project's own style, verify with the project's checks, then summarise what changed and how it was checked). If a run changed code but never ran anything, it is asked once to check its work before it finishes. `read_file` can read a line range of a long file.
- **Runs to completion**: a run keeps going until the task is done instead of stopping to ask. While objectives are open, a model that stops is sent back to the next objective (twice at most in a row), and the run may go past the usual 30 turns up to 120 as long as tools keep succeeding. A reply cut off by the length limit, or by a dropped connection after text arrived, is continued where it stopped, so the answer reads as one. A request that fails before anything arrives (network error, timeout, rate limit, 5xx) is retried twice with a short wait, shown as a note. In long runs the oldest tool output is trimmed so the conversation stays within the model's context window.
- **Context meter and condensing**: a small ring in the composer shows how full the model's context window will be with the next message (≈ tokens, estimated at about 3.5 characters per token). It counts the conversation, the open file, the assistant's tools and policy, and room for the reply; click it for the numbers. When a send, or a reply that just arrived, takes the chat past **80%**, the older turns are summarised by the model (asked to answer without reasoning, so it takes seconds) and the latest two exchanges, or just the last one if two would still be too big, stay word for word. The summary replaces those turns in what the model sees; in the chat they stay visible but dimmed, under an **Earlier messages condensed** divider that expands to show the summary. **Condense now** in the meter does it on demand. If the summary request fails, the oldest turns are dropped instead so the next request still fits. The window size comes from the provider's model list (`context_length`, `context_window`, `max_model_len`, …); where a provider does not report it, it is assumed (32k, or 8k for local servers) and can be set under **Settings → AI providers → Context window**.
- **AI inline completions**: typing pauses for a moment and the selected model is asked for the next few tokens of the file — its answer appears as grey ghost text at the caret, `Tab` accepts it and `Escape` dismisses it, and nothing is inserted on its own. The provider (`src/lib/inlineCompletion.ts`) sends only the ~2.6 KB before the cursor and ~600 bytes after it, debounces keystrokes by 700 ms, drops any answer that newer typing has already superseded, caches answers per cursor position, and silently gives up when the model is slow, errors or the free tier rate-limits. It is driven by the key and model verified in Settings and never runs without both.
- **Ask AI from the right-click menu**: right-clicking inside the editor offers **Ask AI about this file**, and highlighting code turns the menu selection-aware: **Explain this selection**, **Refactor this selection**, **Find bugs in this selection** and **Document this selection** each seed the composer with that question plus the highlighted lines; the explorer's menu offers the same for the file or folder under the pointer. Each one opens the assistant if it was hidden and pre-fills the composer with a ready prompt — the highlighted lines travel inside the message with their path and line range, while file and folder prompts name the path for the assistant's own tools — caret at the end, nothing sent until you press Enter.
- **Markdown rendering** of replies (GFM tables, lists, code blocks, inline code) through a monochrome component map — no raw HTML is ever injected.
- **Auto-follow while generating**, which pauses the moment you scroll up and offers a "jump to latest" chevron instead of fighting you.
- **Stop button** that cancels the in-flight request on the Rust side (`ai_cancel`), so a runaway generation cannot keep writing files.
- **Model switcher inside the composer**: pick any verified model without leaving the chat; the menu opens upward and shows each model's measured latency.
- **Stall handling**: if a model produces no data for five minutes, the request is retried once with your fastest tested model (on any connected provider) and a step note explains the swap.

### Settings

- **AI providers** (Settings → AI providers) is where the assistant is set up. The top of the page picks the **assistant model** and the **inline-completions model** (a small, fast one is best; by default the assistant's) from every connected provider, with a **Test** button. Below, a searchable provider list with filters (All, Connected, Free, Routers, Trial, Local) sits beside the selected provider's details:
  - a note on its free offer and anything to watch for (training on prompts, card or verification required), and a **Get a key** link;
  - the **API key** (stored in Windows Credential Manager; hidden for local servers, optional where an anonymous tier exists);
  - the **base URL**, prefilled where it is known and editable. Keys only ever go to `https://` URLs or to `localhost`;
  - **Models**: **Load models** fetches the provider's `/models` list; tick the models the assistant may use (they appear in the composer's model menu, grouped by provider), filter the list (with a `:free only` toggle for routers), add an id by hand, and **Test models** times each ticked model with a 1-token request.
  - **Add custom provider** takes a name and any OpenAI-compatible base URL.
- An **Appearance** page with twenty-four themes — Nexium, Graphite, Daylight, Paper, Glacier, Dracula, Nord, Forest, Ocean, Sunset, Rosé Pine, Gruvbox, Solarized, Tokyo Night, Monokai, Catppuccin, One Dark, GitHub Dark, GitHub Light, Night Owl, Kanagawa, Everforest, Cobalt2 and Zenburn — picked from a card grid and applied instantly. Themes set a page colour, an ink and an accent on `<html>`; every panel, hairline, overlay and the Monaco palette are mixed from those three, so light themes stay legible and the choice is remembered in `localStorage` (`nexium-theme`).
- A **Fonts** page that shows the two faces the window actually uses, at the weights it ships: **JetBrains Mono** (the editor, diffs, the explorer and every monospaced label) and **Inter** (panels, menus, the assistant). Each face lists its weights and renders “The quick brown fox jumps over the lazy dog” in that face and weight, so the shapes can be compared at a glance; it is a reference page, not a picker — the app keeps its bundled faces rather than borrowing installed system fonts.
- Settings takes over the window: the left sidebar becomes a list of option pages (**Appearance**, **Fonts**, **AI providers**, **Source control**) with the back arrow above it, and the editor area shows the selected page only. Opening settings closes the left panel (explorer or source control) and the assistant, hiding the assistant rail, and closing the tab lives off that state — nothing stays technically open behind the settings page; leaving settings reopens whichever panel was showing and the assistant if it had been open.
- A **Source control** page: the git identity git uses for commits (`user.name` / `user.email`), read from the effective config and shown as `configured` or `not set`. Saving writes both values to the global git config, which is where commits look for an author; validation rejects an empty name or an address without `@`.
- Settings are stored locally and never leave the machine except as the `Authorization` header of your own requests to the provider you chose.

---

## Requirements

| Requirement | Notes |
| --- | --- |
| **Windows 10/11** | The custom title bar is tuned for Windows; Tauri itself runs elsewhere but this app is developed and tested on Windows. |
| **WebView2 runtime** | Preinstalled on Windows 11 and current Windows 10. If the window is blank, install the Evergreen runtime from Microsoft. |
| **Node.js 20.19+ or 22.12+** | Required by Vite 8. The repo ships a `bun.lock`; `bun` or `npm` 10+ both work. |
| **Rust (stable) + MSVC toolchain** | `rustup default stable` and the "Desktop development with C++" workload from Visual Studio Build Tools. |
| **A provider** | Only needed for the assistant; the editor works without one. A free key from any listed provider, or a local Ollama / LM Studio, is enough. |

---

## Quick start

```bash
# 1. install the frontend dependencies (the repo ships a bun.lock; npm works too)
bun install        # or: npm install

# 2. run the app (Vite on a free random port + the Tauri window)
npm run desktop
```

The first `npm run desktop` compiles the Rust crate, which takes a few minutes. Later runs start in seconds.

Then:

1. Click the folder icon in the **Explorer** header (or the empty state) and pick a project folder.
2. Open **Settings → AI providers**, pick a provider (for example Groq, Google AI Studio, OpenRouter or a local Ollama), paste its key and press **Load models**.
3. Tick a model or two; the first one becomes the assistant's model.
4. Ask the assistant to change something. It reads files, proposes the edit as a diff, and the editor refreshes once you accept it.

---

## Connecting a provider

Every provider speaks the OpenAI chat-completions API, so connecting one is a key, a base URL and a list of models. The built-in list (`src/lib/providers.ts`) is the chat-capable part of the *Free AI APIs — Complete Deduplicated List* (verified Nov 8, 2026):

- **Free tier**: NVIDIA NIM, Google AI Studio (Gemini), Groq, Cerebras, Cloudflare Workers AI, Mistral, Cohere, Hugging Face, Kilo Code Gateway, LLM7.io, OVHcloud, Z.ai, SambaNova, SiliconFlow, ModelScope, DashScope, SEA-LION, OpenTyphoon, Ollama Cloud, Novita, Aion Labs, Arli AI and more.
- **Routers** (one key, many models): OpenRouter, Requesty, AIHubMix, Vercel AI Gateway, Vyce AI, Api.Airforce and more.
- **Trial credit**: xAI, DeepSeek, AI21, Upstage, Inception, Fireworks, Regolo and more.
- **Local**: Ollama, LM Studio, llama.cpp, GPT4All, Jan — no key, unlimited, private.

Providers whose OpenAI-compatible URL is not known ship without one and show **needs URL**; copy it from the provider's docs. Image, audio, OCR, search, translation and coding-IDE plans from that list are not chat APIs, so they are not included, and neither are dead or app-only offers (GitHub Models, Chutes, Kluster, OpenCode Zen) or non-OpenAI-compatible APIs (IBM watsonx).

Keys are stored in Windows Credential Manager (service `com.nexium.studio`, one entry per provider), are only read by the app's own Rust code, and are sent only to that provider's base URL. Free tiers are rate-limited, so very long agent runs can hit a 429 — switch models from the composer, or see [Troubleshooting](#troubleshooting). Free tiers change often; check the provider's pricing before relying on one.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server only, at <http://127.0.0.1:5173>. Runs the UI in the browser against a demo workspace (see [Browser-only development](#browser-only-development)). |
| `npm run desktop` | `scripts/desktop-dev.mjs` → `tauri dev`: asks the OS for a free port, starts Vite on it, compiles the Rust crate and opens the real window pointed at that port. Extra arguments go to `tauri dev`. |
| `npm run dev:desktop` | The Vite half of `tauri dev`, run in `desktop` mode: same proxy, **no HMR** — the shell can edit this project without a saved file reloading the window. |
| `npm run build` | `tsc --noEmit && vite build` — type-checks the whole frontend and writes `dist/`. |
| `npm run desktop:build` | `tauri build` — release build, installers under `src-tauri/target/release/bundle/`. |
| `npm run preview` | Serves the built `dist/` (still using the `/nim` proxy). |
| `npm run tauri -- <args>` | Escape hatch to any Tauri CLI command. |

`npm run desktop` runs Vite on a port the operating system picks at random each time (`scripts/desktop-dev.mjs`) and points the window at it through a `tauri dev --config` override, so two dev windows, or another project on 5173, never collide; `tauri.conf.json` keeps 5173 only as the fallback for a plain `tauri dev`. Vite still uses `strictPort`, so it fails loudly instead of drifting away from the port the window expects. Release builds open no port at all.

---

## How the assistant works

Nothing about the assistant happens in the webview except rendering. The HTTP client, the tool loop and all filesystem access live in Rust (`src-tauri/src/agent.rs`, `llm.rs`, `workspace.rs`); the UI passes the chosen provider's endpoint (name, base URL, key) with each request.

1. The UI sends the conversation and the provider endpoint to the `ai_agent` command.
2. Rust calls `POST {base URL}/chat/completions` with the tool schema, streams deltas back as `agent-delta` events, and shows reasoning separately from the answer.
3. When the model calls a tool, Rust executes it against the open folder, emits the result as an `agent-step` note (and `workspace:file-changed` for writes), then loops back to the model with the tool output. Every event carries the session id, so the UI routes it to the right session; Stop (`ai_cancel`) and approvals (`agent_decide`) are per session too.
4. For multi-step work the model calls `set_objectives` first, then again with the whole list whenever an objective starts or finishes. Rust checks the list (up to 12 items, statuses `pending` / `in_progress` / `done`) and sends it to the UI as a single `objectives` step that updates in place. While items are open, a file change, or three tool calls without an update, adds a one-line reminder of the checklist to the tool result, because smaller models otherwise keep working without ticking anything off.
5. When the model stops calling tools, the final message is returned and the UI settles on it, unless the reply was cut off (`finish_reason: length`, or the stream dropped mid-reply), in which case the loop asks for the rest, or objectives are still open, in which case it sends the model back to them. Failed requests are retried twice (3 s, 6 s; 10 s, 20 s for 429) when nothing had arrived yet. Before each turn, tool results and large write arguments older than the last 8 messages are shortened until the conversation fits the model's context window (passed from the UI). If it spends every step on tools, the loop asks once more with the tools removed — "answer with what you have already read" — so a long exploration still ends in prose instead of an error note.

Sessions coordinate through the database (`src-tauri/src/store.rs`, `run.rs`): a run claims each file before changing it (a claim held by another *running* session refuses the edit; claims are dropped when the run ends and on startup), logs `start`, `change`, `note` and `finish` entries to a per-project activity table, saves its objectives on the session, and before each tool result reads the activity other sessions added since its last look. Commands run through `src-tauri/src/command.rs` (`cmd /D /S /C` on Windows, `sh -c` in its own process group elsewhere; a timeout or Stop ends the whole process tree).

Hard limits, chosen so a confused model can never spin forever or rewrite a huge file:

| Limit | Value |
| --- | --- |
| Agent loop steps per request | 30; up to 120 while objectives are open and tools keep succeeding (then one tool-free answer, and a **Continue** button) |
| Continuations of a cut-off reply | 4 |
| Command time limit | 120 s by default, 600 s at most |
| Command output kept | first 2 000 and last 12 000 characters |
| Retries of a failed request | 2 |
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

A provider's `/models` list is not a capability list: a model can be listed and still reject chat completions, be offline, or be unusably slow — and routers list hundreds. So nothing is probed automatically: you tick the models you want, and **Test models** sends each ticked model (up to 40) a 1-token request and records the round-trip time.

- Latencies are shown in the provider's model list, the default-model pickers and the composer's model menu, and are kept until you test again.
- If the selected model sends no data for five minutes, the request is retried once with the fastest tested model on any connected provider instead of leaving you on a dead model.

---

## Source control

Open the branch icon in the activity rail. The panel reads `git status --porcelain=v1 -z --untracked-files=all` in the open folder — the untracked flag matters, otherwise git reports a new folder as one `?? folder/` entry and its files would never appear — and shows:

- the current branch (or `HEAD <sha>` when detached, `no commits yet` on a fresh repo), a change count in the header badge and a `clean` marker;
- **Staged** and **Changes** groups with counts, each rendered as a folder tree: directories show a folder icon and how many changed files sit below them, files are indented under their folder with their porcelain status in a small badge (`M`, `A`, `D`, `R`, `C`, `U` for untracked). Clicking a file opens its diff in the editor (deleted files are struck through and not clickable);
- a per-row **Stage** / **Unstage** action on hover, plus **Stage all** / **Unstage all** per group;
- a commit card: the message field explains what is staged, the **Commit** button enables once something is staged and a message is written (`Ctrl`/`Cmd` + `Enter` submits), and a successful commit clears the message, reloads the list and falls back to the “Working tree clean” state. The caret beside it opens the commit options — **Commit** and **Commit & Sync**; the panel only ever lists local commits, so syncing is what sends them to the remote: it pushes the current branch to its upstream, or sets `origin` as the upstream when the branch has none, and nothing is pulled, merged or rebased. A **Generate** button at the top right of the message field writes the message with the assistant's selected model from the staged file list and the lines around each change; it is disabled until a model is configured and something is staged, and a failure is reported in the line under the field instead of overwriting the message.

- a **Tags** section under the changes: the 100 newest tags (8 shown, **Show all** for the rest), each with its age; hover a tag to **push** it to `origin` or **delete** it (locally only, after a confirm — a tag already on the remote stays there). **New tag** opens a **Create tag** dialog: Patch / Minor / Major cards with the next versions after the newest `vX.Y.Z` tag (the patch one prefilled), the tag name, an optional message (which makes it an annotated tag) and **Push to origin**, on by default. It names the branch whose latest commit gets the tag, warns when there are uncommitted changes, rejects duplicates and names git would not accept as you type, and notes that pushing a version tag starts the release workflow ([Publishing a release from a tag](#publishing-a-release-from-a-tag)). `Ctrl`+`Enter` creates, `Escape` or a click outside cancels. A failure (for example a rejected push) is shown inside the dialog; the tag itself still exists locally and can be pushed again from its row.

**Status bar: branches, pull and push.** The branch name at the bottom left opens the branch picker (the change count beside it opens the panel):

- type to filter the branches and tags; local ones come first, newest first, then **Remote only** branches that no local branch tracks yet. Pick one to switch to it; a remote one (`origin/docs`) is checked out as a local branch that tracks it (`git switch --track`). Uncommitted changes come along, and Git refuses (the reason is shown in the picker) if they would be overwritten;
- type a name that does not exist yet and press `Enter` (or **Create branch … and switch to it**) to create a branch from the current commit; names are checked with `git check-ref-format --branch`.
- tags are listed too, under **Tags** (name, age, message, commit). Picking one checks out its commit (`git switch --detach refs/tags/<name>`): you are then on no branch, the status bar reads `v1.0.0 (detached)` and hides pull and push, and typing a new name creates a branch from there (for example a hotfix on an old release).

Next to it, **↓ n** pulls and **↑ n** pushes, with the number of commits each would move. The pull is fast-forward only (`git pull --ff-only`): it never creates a merge commit or rebases, and when both sides have new commits it stops and says to pull with `--rebase` or `--no-rebase` in the terminal. The push never forces. A branch with no upstream shows **Publish branch** instead, which pushes it to `origin` and tracks it there; with no remote at all neither is shown. To keep the ↓ count current the app fetches quietly (`git fetch --prune`, no prompts) when a repository with a remote opens and every five minutes. After a pull or a branch switch the explorer is reloaded, and open files without unsaved edits are reloaded from disk (files with unsaved edits are left alone). The result of each action appears on the left of the status bar.

**Publish to GitHub.** A repository with no remote shows **Publish to GitHub** in the status bar and a **Publish** button in the panel header; a folder that is not a repository yet offers it under the `git init` hint. The dialog creates the repository through the GitHub API (`POST /user/repos`, or `/orgs/<org>/repos` for an organisation you belong to): pick the owner, the name (prefilled from the folder, checked against GitHub's rules as you type), an optional description, and **Private** (the default) or **Public**. It is created empty (no README), added as `origin`, and the current branch is pushed and tracked; a folder that was not a repository gets `git init -b main` first, and with no commits yet nothing is pushed (commit, then **Publish branch**). A taken name, a missing scope or a refused organisation is explained in the dialog; afterwards it links to the new repository.

Sign-in lives in **Settings → Source control → GitHub**: paste a personal access token (classic, with the `repo` scope, plus `read:org` to publish to organisations; the link there opens GitHub's token page with those scopes ticked). It is checked against `GET /user`, then kept in the OS credential store (account `github-token`), never in the webview. Without a saved token the GitHub CLI's login is used (`gh auth token`), so `gh auth login` is enough. The same credentials are used for fetch, pull and push to `https://github.com/` remotes: git gets them as an HTTP header for `https://github.com/` only, through `GIT_CONFIG_*` environment variables, so the token is never on a command line or in a URL, and no other host sees it.

The commit button's main action is a setting: **Settings → Source control → Default commit action** chooses **Commit** (the default) or **Commit & Sync**. The button's label and icon and `Ctrl`+`Enter` follow it, an open panel updates the moment it changes, and the arrow beside the button still offers both.

Commits made from the panel credit Nexium as a co-author: the message ends with `Co-authored-by: Nexium <noreply@nexium-studio.invalid>`, so GitHub shows "Nexium" next to the author on each commit. The address is on the reserved `.invalid` domain and belongs to no GitHub account, so only the name appears (no avatar, and it is not counted on the repository's contributors page). The line joins any trailers already at the end of the message, so existing co-authors keep working, and it is never added twice. Turn it off under **Settings → Source control → Credit Nexium as a co-author**.

A change opens as a read-only side-by-side diff in the editor area, titled `HEAD → staged` for a staged change (the index against `HEAD`) or `HEAD → working tree` for everything else (the file on disk against `HEAD`), with the file's own language, the app's fonts and the active `nexium` theme; the header carries the path and a close button that returns to the editor. A new file, or any file in a repository without commits, diffs against empty. The two sides are Monaco models owned by the diff pane: they are created per open and disposed after the widget is gone, so opening and closing diffs repeatedly leaks nothing.

Every action returns the fresh status, so the panel never shows a stale tree. Saving a file or the assistant writing one refreshes it too. If the folder is not a repository the panel says so and suggests `git init`; git errors (missing identity, empty index, hooks) are shown verbatim in the panel footer. Nothing is ever committed automatically, and no history-rewriting command is reachable from the UI.

## Terminal

`Ctrl`/`Cmd` + backtick (the key above Tab) shows a terminal panel under the editor and hides it again; the panel's close button does the same. It is a real shell — `powershell.exe` on Windows, `$SHELL` (or `/bin/sh`) elsewhere — started in the open folder the first time the panel is opened and kept alive while hidden, so the scrollback and the working directory survive a toggle. `portable-pty` gives it a pseudo-terminal, so interactive programs, colours and resizing behave as they do in a console; output is streamed to the page as base64 and drawn by xterm.js, whose theme follows the app's. The shell ends when the window closes. In the browser preview the panel states that a shell only exists in the desktop app.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl`/`Cmd` + `S` | Save the active file |
| `Ctrl`/`Cmd` + `F` | Find in the active file — Monaco's widget, floating over the code |
| `Ctrl`/`Cmd` + `H` | Find and replace in the active file (adds the replace row to the same widget) |
| `Ctrl`/`Cmd` + backtick | Show or hide the terminal panel |
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
                │ agent-delta/step          │ ai_agent, read_workspace_file …
┌───────────────┴───────────────────────────▼───────────────┐
│                    Rust core (src-tauri)                  │
│  workspace.rs  safe path joining, tree, read/write/search │
│  llm.rs        any OpenAI-compatible provider, probes      │
│  agent.rs      tool loop, system prompt, event emission   │
│  run.rs        per-session run context, session overview  │
│  store.rs      SQLite: sessions, messages, activity, locks│
│  command.rs    run_command: shell, timeout, process tree  │
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
├── vite.config.ts              # 127.0.0.1 (strict port), /nim proxy, Monaco helpers
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
│       ├── llm.ts              # provider calls: models, probes, chat, agent
│       ├── assistantPrompt.ts  # right-click selection/file prompts for the composer
│       ├── inlineCompletion.ts # ghost-text AI completions in the editor
│       └── assistantSettings.ts# settings persistence (key → credential store)
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json         # window (undecorated, centered), dev/build hooks, bundle targets
    ├── capabilities/default.json # core + dialog + window permissions
    └── src/
        ├── main.rs             # thin binary wrapper
        ├── lib.rs              # commands, builder, dialog plugin, state
        ├── workspace.rs        # safe_join, tree snapshot, read/write/search, tests
        ├── git.rs              # porcelain parser, diff sides, stage/unstage, commit
        ├── llm.rs              # OpenAI-compatible client for every provider, probes
        ├── agent.rs            # tool schema, tool loop, step notes, write events
        ├── run.rs              # a run's session id, events, view of the other sessions
        ├── store.rs            # SQLite database: sessions, messages, activity, file locks
        └── command.rs          # run_command: shell, time limit, stopping the process tree
```

---

## Security model

- The API key is typed into the UI and, in the desktop app, stored in the operating system's credential store (Windows Credential Manager) rather than `localStorage`; a key left in `localStorage` by an older build is moved over on the next start. It is passed to Rust per request and **never** placed in a URL or a log line. The browser-only dev mode has no credential store and keeps the key in `localStorage`.
- A Content Security Policy (`app.security.csp` in `tauri.conf.json`) limits the window to its own scripts, styles, fonts and workers plus `data:`/`blob:` images, and blocks plugins, frames and form posts.
- Every command that touches the disk or runs git is `async` and runs on a background thread, so a slow `git push` or a large folder never freezes the window; git runs without a console window.
- Every filesystem command is confined to the folder you opened (`safe_join`); `delete_workspace_entry` and `rename_workspace_entry` refuse anything that resolves outside it.
- Tauri capabilities are minimal: `core:default`, `dialog:default`, and only the five window permissions the custom title bar needs (`minimize`, `toggle-maximize`, `is-maximized`, `close`, `start-dragging`).
- Assistant output is rendered as Markdown without HTML, so a model cannot inject markup or script into the window.
- Commands the assistant proposes run only after you press **Run** (unless Auto-approve is on), in the open folder, with no input, a time limit, and your own permissions; they are not sandboxed, so read them before running.
- Writes performed by the assistant go through the same path checks as your own edits, and the UI is told which file changed so the editor never shows stale content. Deleting asks for confirmation first and is the only destructive action in the app.
- The terminal is a real shell behind a pseudo-terminal. It is only available once a project is open and always starts in that project's folder (opening another project restarts it there); commands typed into it run with your own permissions and are not sandboxed.
- Source control shells out to `git` inside the open folder, only ever with `status --untracked-files=all`, `show` (read-only, for the diff sides), `add`, `restore`, `reset`, `rm --cached`, `commit -m`, `tag` (create or delete one local tag; names are checked with `check-ref-format`), `for-each-ref refs/tags refs/heads refs/remotes`, `fetch --prune`, `pull --ff-only`, `switch` (to a branch, `-c` to create one, `--track` for a remote one), `branch <name>`, `check-ref-format` and `push` (the current branch, or one `refs/tags/<name>`; never forced) (with `GIT_TERMINAL_PROMPT=0`, so a credential prompt fails instead of blocking the window); paths are passed after `--` so they cannot be read as options.

---

## Where data lives

| Data | Location |
| --- | --- |
| Provider API keys | OS credential store (Windows Credential Manager), service `com.nexium.studio`, account `api-key:<provider id>` |
| Chosen models, turned-on models per provider, base-URL overrides, custom providers, latencies | WebView `localStorage`, key `nexium.assistant.providers` (settings from older builds under `nexium.assistant.nim` are migrated) |
| GitHub token (if you add one) | OS credential store, service `com.nexium.studio`, account `github-token` |
| Sessions and their messages, the sessions' shared activity log, file locks | SQLite database `nexium.db` in the app data folder (on Windows `%APPDATA%\com.nexium.studio\nexium.db`), grouped by project folder; deleting a session removes its messages and activity. The browser-only dev mode keeps sessions in `localStorage` (`nexium.sessions`) |
| Your project files | Untouched on disk until you or the assistant saves |

Reset the assistant with **Remove key** in Settings (or by deleting the credential and clearing that `localStorage` key); delete `nexium.db` to forget every session. Nothing else is written outside your project folder.

---

## Building a release

```bash
npm run desktop:build
```

The installer and binaries are produced under `src-tauri/target/release/bundle/` (MSI and NSIS on Windows). The release profile uses `lto = true`, `codegen-units = 1` and `opt-level = "s"` to keep the binary small; the first release build is slow, subsequent ones reuse the cache.

### Publishing a release from a tag

`.github/workflows/release.yml` builds and publishes a GitHub release whenever a version tag is pushed:

```bash
git tag v1.0.0
git push origin v1.0.0
```

| Runner | Files attached to the release |
| --- | --- |
| `windows-latest` | `Nexium Studio_1.0.0_x64-setup.exe` (NSIS), `Nexium Studio_1.0.0_x64_en-US.msi` |
| `ubuntu-22.04` | `.deb`, `.rpm`, `.AppImage` |

- The version comes from the tag: `scripts/set-version.mjs` stamps it into `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` before building, so the files in the repository do not have to be bumped by hand (run the script locally if you want them to match).
- The release is created as a **draft**, both builds upload into it, and it is published only when both succeed. If one fails, the draft stays: fix the problem and re-run the failed job from the Actions tab, or run the workflow by hand (**Run workflow**, with the tag) to rebuild an existing tag.
- Tags with a pre-release part, such as `v1.1.0-beta.1`, are published as GitHub **pre-releases**. Windows Installer only accepts numeric versions, so pre-releases ship the `.exe` installer but no `.msi`.
- Linux builds run on Ubuntu 22.04, so the `.deb` and `.AppImage` also work on distributions with an older glibc. On Linux, API keys are kept in the desktop keyring (GNOME Keyring or KWallet, through the Secret Service API).
- The installers are not code-signed, so Windows SmartScreen will warn on first launch until a signing certificate is added.

### In-app updates

Installed copies update themselves from this repository's releases:

1. A few seconds after launch (and every 6 hours) the app fetches `https://github.com/GregoryAM-SP/Nexium-IDE/releases/latest/download/latest.json`.
2. If it names a newer version, the update downloads quietly in the background; the status bar shows **Update x.y.z · nn%**, then **x.y.z installs on close** with a **Restart now** button.
3. When you close the window, the update installs and the app exits: on Windows the NSIS installer runs in passive mode (a progress bar, no questions); on Linux the AppImage is replaced in place. **Restart now** installs and reopens the new version immediately.
4. **Help → Check for Updates…** checks on demand and reports when you are up to date.

Only stable releases are offered: GitHub's `releases/latest` skips pre-releases, so `v1.1.0-beta.1` reaches only people who download it by hand. The updater covers the Windows `.exe`/`.msi` installs and the Linux AppImage; `.deb` and `.rpm` installs update through a new package from the release page. Nothing is checked in `npm run desktop` (dev) builds.

**Signing.** Every update is signed, and the app refuses anything that does not verify against the public key in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). The matching private key is `~/.tauri/nexium.key` on the maintainer's machine; keep it safe — if it is lost, existing installs can no longer be updated. The release workflow needs it as repository secrets:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the contents of `~/.tauri/nexium.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the key's password (leave unset: this key has none) |

Because `bundle.createUpdaterArtifacts` is on, a local `npm run desktop:build` also needs the key, e.g. in PowerShell: `$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw ~/.tauri/nexium.key`.

---

## Browser-only development

`npm run dev` runs the UI without Tauri. In that mode:

- `isTauri()` is false, so filesystem calls fall back to an in-memory demo workspace (`workspaceFs.ts`) — you can click around, open files and edit them, but nothing is written to disk.
- The custom window buttons render nothing (there is no window to control).
- Assistant requests go straight from the page to the provider with `fetch`, so only providers that allow cross-origin requests work here (local Ollama does; many cloud APIs do not). NVIDIA sends no CORS headers, so its requests go through the Vite `/nim` proxy, which also exists in `vite preview`. The desktop app sends every request from Rust and has no such limit.

This mode is for UI work; anything involving real files, permissions or window behaviour must be checked in `npm run desktop`.

---

## Tests

```bash
cd src-tauri
cargo test --lib
```

The Rust suite covers path sandboxing (`safe_join` rejects escapes), workspace reads/writes, the SSE parser, `edit_file` matching, base-URL rules and provider error messages. Two tests are marked `#[ignore]` because they need the network: one sends NVIDIA a deliberately bogus key to check the authorisation error path, the other lists and pings a local Ollama. Run them explicitly:

```bash
cargo test --lib -- --ignored
```

The frontend has no unit-test suite; `npm run build` runs the strict TypeScript check that guards the UI.

---

## Troubleshooting

**"Port … is already in use."**
`npm run desktop` picks a free port at random on every run, so this should not happen; if something grabbed that port in the instant between it being picked and Vite starting, just run it again. `npm run dev` (browser only) still uses 5173 — close the other `vite` using it. The installed app never opens a port: release builds load their pages through Tauri's `tauri://` scheme.

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
- No debugger or extensions. The terminal and Source Control panel are single-session and single-repository.
- Monaco's TypeScript worker only sees the files the app hands it, so imports from unopened packages resolve only through the bundled ambient shim for `lucide-react`.
- Assistant edits are exact-text replacements; there is no fuzzy patching, so a stale `old_string` fails and the model has to re-read the file.
- The custom title bar is Windows-shaped: no double-click-to-maximize, and the resize borders come from the native frame that stays underneath.
- Editing is local-only; there is no sync, account or cloud storage.
