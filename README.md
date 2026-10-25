# grok-style-pi

Grok Build-inspired chrome for [Pi](https://pi.dev): a GrokNight color theme, a `cwd │ model │ Context used/max used │ usage` footer, a rounded composer with a `❯` prompt, and diamond (`◆`) tool rows.

This package uses only documented Pi extension APIs (`setFooter`, `setEditorComponent` wrapping `CustomEditor`, and same-name `registerTool` overrides with `renderShell: "self"`). It does not patch Pi internals.

## Install

From a clone:

```bash
pi install /home/aim/git/grok-style-pi
```

From GitHub:

```bash
pi install git:github.com/Daedie-git/grok-style-pi
```

Try without installing:

```bash
pi -e /path/to/grok-style-pi
```

Then pick the **groknight** theme in `/settings`, or set it in `~/.pi/agent/settings.json`:

```json
{
  "theme": "groknight",
  "tuiMode": "fullscreen",
  "quietStartup": true,
  "editorPaddingX": 1,
  "outputPad": 1
}
```

Restart Pi after changing `tuiMode`.

Install either the local clone or the GitHub package, not both. When working from the local clone, `/reload` loads your latest changes.

## Standalone media

To use only `show_image`, `show_video`, and `show_html`, load the media-only entrypoint instead of either Grok entrypoint:

```bash
pi -e /path/to/grok-style-pi/integrations/media.ts
```

For persistent use, add that file to the `extensions` list in Pi's settings. If the Grok package is also installed, disable its default extension (and optionally its theme resources); for example:

```json
{
  "packages": [
    { "source": "/path/to/grok-style-pi", "extensions": [], "themes": [] }
  ],
  "extensions": ["/path/to/grok-style-pi/integrations/media.ts"]
}
```

The standalone extension retains the same initially open image, video, and HTML diamonds, [diamond gestures](#diamond-interaction), Ctrl+O expansion, Ctrl+click opening in the desktop's default application, image transcript storage, bounded silent video playback, and playback cleanup on branch navigation, compaction, session replacement, shutdown, and reload. It works independently of `/grok-style` settings and leaves the theme, footer, composer, terminal colors, built-in tools, activity panel, and communication style unchanged.

Standalone inline-code media paths in assistant replies become clickable; code references, existing Markdown links, code blocks, and thinking messages stay unchanged. On Linux it uses the same private, session-owned file-link handler as Grok and installs that handler at interactive session startup. Other platforms use file URLs for reply links. Mouse gestures require Pi's fullscreen mode. Inline video still requires `ffmpeg` and Kitty image support, including Herdr's graphics setting described below; the preview is silent and never sends frames to the model.

Other extensions can import `createMediaExtension` from `integrations/media.ts` to install the full media behavior, or `installMediaTools` to register just the tools and their playback lifecycle with an injected `onModifierOpen` handler. Both register renderers before transcript restoration and preserve every media renderer owner across startup, refreshing its working directory for restored relative paths. Use one installer per Pi extension runtime. Do not also load `extensions/index.ts` or `integrations/subagents.ts`: both already include these media tools when tool styling is enabled.

## What you get

| Surface | Behavior |
|---|---|
| Theme | Neutral near-black gray + blue highlights `#7aa2f7` / `#7dcfff` (GrokNight) |
| Footer | One row: full working path (`~` for home) with the active Git branch, model, thinking level, and context and subscription usage for the active model only, followed by its logged-in account when available |
| Composer | Rounded frame and `❯` prompt; muted idle border, brighter focused border. Clearing a draft with Ctrl+C adds it to prompt history, so Up brings it back |
| Tools | Dim diamond summaries for shell commands (using their description when supplied), with readable file-tool labels; edit diffs open by default with green additions, red removals, and stronger character highlights on changed text; other output expands on demand. The dedicated `show_image`, `show_video`, and `show_html` tools display media in open, closable diamonds; other images use Pi’s normal inline display |
| Activity | Live Bash/PowerShell commands and top-level subagents above the composer, with clickable View, Stop, and Close controls. Subagent rows show the run's model and thinking level |

Agents can call `show_image` with a local PNG, JPEG, GIF, or WebP path to share a screenshot in an expanded diamond. Ctrl+O also controls its expansion; see Diamond interaction for clicks. The result stores the image for the transcript but sends only a path confirmation to the model; agents needing to inspect the pixels should use `read` separately. Files must be at most 10 MB. The tool is available when tool styling is enabled. Image file references in assistant replies still open in the default desktop image viewer when clicked.

Agents can call `show_video` with a local MP4, M4V, MOV, MKV, WebM, or AVI path for silent, animated playback in a diamond. Closing it stops playback; reopening restarts from the beginning. Ctrl+click opens the full video with sound in the desktop's default player (see Diamond interaction). It uses `ffmpeg` to stream a bounded, 15-frame-per-second terminal preview without storing frames in the session or sending them to the model. The player stops when closed, when navigating to another conversation branch, after compaction, or when the session shuts down. The agent should also link the path in its reply: on Linux, clicking a video file reference opens the full video (including sound) in the desktop's default video player. `ffmpeg` and Kitty image support are needed for inline playback; in Herdr, enable `[experimental] kitty_graphics = true` and reattach its client.

Agents can call `show_html` with a local `.html` or `.htm` file for a static screenshot in an initially open diamond. Ctrl+click opens the original page in the default browser for interaction; standalone inline-code HTML paths in replies do the same. The screenshot is stored in the transcript, but only a path confirmation reaches the model. Previewing requires Chromium or Chrome on `PATH`, or `GROK_HTML_BROWSER` set to its executable path. The sandbox stays enabled. Only preview trusted HTML: scripts run and may load network resources. Capture uses a private temporary browser profile, a 1200×800 viewport, a one-second virtual-time budget, and a 15-second process timeout; cancellation and timeout stop the browser process tree before profile cleanup, and cleanup failures do not replace the original capture error. HTML files and screenshot results are limited to 10 MB. The preview is static, not a live embedded browser, and requires terminal image support like `show_image`.

Built-in tools (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) use Pi’s full `create*ToolDefinition` factories, preserving built-in prompt guidance and execution. Disabling tool styling restores their native renderers. Styled tool text is sanitized before theme colors are applied. Expanded reads, new-file and unrecorded write previews, and Bash or PowerShell command lines are syntax-highlighted with Grok Build's Grok Night theme when `bat` is available. That is the same syntect theme as Grok Build, so punctuation, operators, types, and identifiers are colored, not left plain. Comments are lightened to `#a0a8b8` so they stay readable on the green and red diff backgrounds. Without `bat`, small previews fall back to Pi's highlighter; large previews stay plain to keep rendering bounded. `bat` selects the grammar from the file name, so C++, headers, CUDA, JavaScript, TypeScript, Rust, Python, shell, PowerShell, and the rest of its language set are covered. The Pi fallback still maps those same extensions explicitly. Assistant Markdown fences still use Pi's highlighter and need a language tag such as `cpp`. Edit diffs syntax-color the code, including unchanged context lines. Added rows use the green insert background and removed rows use the red delete background. Changed characters use `#0c5b10` and `#6c1a22`, extended to the whole word when the edit falls inside one. Leading indentation stays on the row background. A pure insertion or deletion keeps the row background. If the theme is not ready, those rows fall back to one output color. Expanded read panels use GrokNight's code-block background, `#1c1c1c` (`bg_dark` in `groknight.rs`), which is lighter than the `#141414` transcript. In fullscreen mode, double-click a source line in an expanded read, edit diff, or write preview to insert its `path:line` reference at the message cursor without closing the diamond; wrapped source lines keep their original line number. Drag-select source text in one diamond, then click within the selection to insert `path:start-end` for multiple lines, or `path:line` if the selection spans only one source line (including wrapped rows). Read continuation notices and diff headers are not source locations; numbered removed lines refer to the old file line. Ctrl+click an edit, write, or read row or body to open that file in Cursor's classic IDE at the change line (the clicked source line in a body), reusing a window already opened on the git workspace. If no matching window exists, Cursor opens the workspace root before navigating to the file. `/open` and `ctrl+alt+o` jump to the last edit. Ctrl+O still controls global expansion; expanding and then collapsing all tools also closes edit diffs.

Cursor opening prefers an already-mounted Linux AppImage CLI, avoiding another AppImage mount, and falls back to the normal launcher if that mount disappears. `/open pick` lists this session's successful edits and writes; opening a read row does not replace the last-edited target. Launch failures are reported without exiting Pi.

The first Cursor open per workspace in each Pi session also refreshes `compile_commands.json` when an existing CMake or Meson build can be identified. This applies to Ctrl-click, `/open`, and the shortcut. The existing database (including a symlink or root-level copy) guides build-directory selection; otherwise a bounded search looks for configured builds. CMake reuses its cache and enables compilation-database export for supported Ninja/Makefile generators; Meson reconfigures its existing build. No new preset is guessed and no full build is invoked. Configuration commands have a 60-second timeout. Root-level database copies are updated and symlinks are preserved.

The first open waits for regeneration, with a progress notification; concurrent clicks share that refresh, and later opens skip it. Automatic configuration only runs for the trusted session workspace—not unrelated repositories reached by clicking an external file. Non-native projects are skipped. Ambiguous, unsupported, or failed refreshes warn and still open Cursor. Switching sessions or `/reload` resets the once-per-workspace check and cancels pending refreshes.

Write rows report `Creating` or `Replaced`. A new file is an all-insert diff: the header says `Creating <path>`, a collapsed row shows `+N/-0`, and each line has a green gutter, GrokNight's green insert background `#063806`, and syntax-colored source. Tabs expand to four spaces.  Replacements expand on demand to show their colored diff. The previous contents are captured inside Pi's per-file write queue. Previews are bounded: new contents show up to 16,000 characters; diffs require both versions to fit within 64 KB and 1,000 lines each. Larger or unreadable originals fall back to a labeled content preview. Older session entries and custom remote write operations use `Wrote` when creation/replacement cannot be established; previous contents are never inferred from the current file. Original tool-result text sent to the model is preserved.

Pi's `codemode` scripts also use a collapsed diamond row. Once nested-call metadata arrives, a single call shows its description or file target, such as `◆ codemode · Inspect timing changes` or `◆ codemode · Read src/app.ts`. Multiple calls show a compact breakdown, such as `◆ codemode · Read 3 files · Run 1 command`. While running, the row shows how many observed calls have finished; failures and cancellations keep their counts visible. Older or truncated metadata falls back to tool names, never guesses from the JavaScript. Before calls arrive, the row reads `◆ codemode`. Click the diamond or use Ctrl+O to show the JavaScript, live nested-call statuses and timings, model-call costs, and script output. Script errors retain their partial output. Styling uses Pi's public `createCodemodeExtension` factory and does not enable codemode automatically or change its sandbox, tool discovery, storage, or execution. Older Pi versions without that factory keep their existing tools; disabling tool styling leaves Pi's native codemode renderer in place.

Tool panels reuse their completed layout while their width, content, and colors are unchanged. Syntax highlighting, detailed diff preparation, and large colored layouts run in a lazy background worker. Panels display readable text immediately, then add syntax and character colors without waiting on `bat`. Small previews use Pi's highlighter while preparation is pending; large previews initially use plain text with the diff backgrounds. Oversized replacement blocks keep line-level coloring when detailed character matching exceeds its work budget. Background work is deduplicated and bounded, and reload discards pending results. The `bat` theme cache is reused across sessions when its theme and `bat` version match.

Pi still controls transcript spacing and message layout, so this is an approximation of Grok Build rather than a complete replacement of Pi’s interface.

The grayscale values follow Grok Build's GrokNight implementation: Markdown body text (including bold) and secondary output use `#c8c8c8`; primary UI text and user messages use `#e1e1e1`. The cursor uses `#c8c8c8` (`accent_user`). Terminal foreground uses the Markdown body color because Pi's plain assistant prose inherits it. These values are sourced from `crates/codegen/xai-grok-pager-render/src/theme/groknight.rs`, `theme/md_style.rs`, and `xai-grok-pager/src/scrollback/blocks/user.rs` in the local Grok Build checkout at `e82a7e60` (source revision `28439e8a8712c363321cf6ff0c2d70cd058d2a7d`). The stale `#f3f3f3` comment in that palette does not reflect its actual constants.

Our blue accent overrides remain a customization: Grok Build's source also uses teal/purple headings and mixed syntax colors. Pi exposes a single heading color, while Grok Build styles heading levels separately. Run `/reload` after editing the palette. Terminal colors are applied at session startup before file-link setup and tool settings are loaded, with one full redraw to repaint unchanged rows. With terminal colors disabled, plain assistant prose and editor input inherit your terminal's colors. In fullscreen mode, a Node process warning triggers a full repaint so its raw stderr text cannot remain over an unchanged composer or footer; the warning also appears as a Pi notification. This does not suppress host warnings, and the listener is removed on shutdown or reload. On Node 22, database and visual workers suppress the specific `UNDICI-EHPA` proxy-agent startup notice, which otherwise writes into Pi before worker JavaScript runs. Proxy behavior and unrelated diagnostics remain unchanged. Pi controls Markdown list markers (dashes), selection rendering, and transcript spacing; this extension does not replace those renderers.

The footer shows context and allowance only for the selected model. Other providers are omitted, and their refresh stops on model change. GPT models on `openai` or `openai-codex` also show an accent-colored `Fast: on` while the included `/fast` command requests priority processing, or `Fast: off` in the footer's default color otherwise. The indicator disappears when a non-GPT model is selected; it does not confirm that the server granted priority processing.

Context uses this Pi session's estimated token count and the selected model's context-window limit (for example, `Context 24,800/200,000 used`). Unknown counts show `?`, including after compaction until usage becomes available again.

For `openai-codex`, that is this session's context and weekly quota remaining (for example, `Weekly 46% left`). Quota refreshes in the background at startup and once per minute using the existing Pi ChatGPT login and Codex's usage endpoint. Response headers also update the display when available. This works with WebSocket transport and makes no model requests. Refresh stops when the footer is disabled, the model changes away from Codex, or the session closes. Unavailable or expired data is not shown as a known percentage; authentication failures display `login required`. The usage endpoint is an internal Codex service and may change.

For `xai`, that is this Pi session's context and allowance remaining (`Weekly N% left`). Weekly allowance refreshes at startup and once per minute with the existing Pi xAI login and Grok's credits endpoint. A non-weekly allowance shows `?`. Authentication failures display `login required`. The credits endpoint is an internal Grok service and may change.

For Codex and xAI logins, the footer appends `Account <email or name>` after usage. If the login token provides neither, it shows the account ID instead. Identity refreshes at startup, on model changes, and once per minute using the existing Pi login, without extra account endpoint requests. API keys and logins without a readable identity omit this item. On narrow terminals, the account is shortened first and dropped when fewer than 12 columns remain, so the path and model stay visible.

Any other model shows this Pi session's context token counts and no subscription line.

## Fast mode

Both full entrypoints (`extensions/index.ts` and `integrations/subagents.ts`) include the same `/fast` command on Windows, Linux, and macOS. No separate extension is needed. Disable any previous standalone `/fast` extension or package to avoid duplicate command registrations; media-only and standalone Herdr installations do not include this command.

Use `/fast on` to request priority processing, `/fast off` to stop requesting it, `/fast status` to inspect the setting, or `/fast` to toggle it. New sessions default to off. The choice is saved in the active session branch and restored on reload, resume, fork, and tree navigation, including previously saved `openai-fast` entries. Turning Grok's visual features off does not change this setting.

Fast mode adds `service_tier: "priority"` only to GPT requests on the `openai` and `openai-codex` providers. It does not change the model or transport, and other providers and model families are unaffected. Switching away from a supported model hides the footer indicator without forgetting the setting. Priority service is requested, not guaranteed, and may increase cost or usage. `/fast off` leaves the provider's normal request defaults unchanged.

## Project memory

Persistent project memory is **off by default**. Both full entrypoints include it independently of visual styling:

```text
/grok-style memory on
/reload
```

Turn it off with `/grok-style memory off`, then `/reload`. The `/grok-style` menu also exposes the toggle; `all on` explicitly enables it and `all off` disables it. The media-only entrypoint stays memory-free.

When enabled, the extension supplies a memory policy and a bounded `MEMORY.md` index before each submitted run. The model decides when a memory is relevant and reads its linked topic files with the existing file tools. Relevant, attributable saved preferences and collaboration guidance can shape later replies without being repeated, unless current instructions or verified evidence contradict them; saved notes do not authorize arbitrary commands, permission changes, or instruction overrides. The policy includes both corrections and positive confirmations of useful, non-obvious approaches, durable user preferences, non-code project context, and external references. It asks the model to verify stale claims and update or remove outdated notes. It must not store secrets, credentials, temporary task state, or information already available in code, Git, or instruction files. These are model instructions, not a deterministic extraction guarantee.

Saving uses normal `write`/`edit` calls: update a topic Markdown file, then add a short pointer in `MEMORY.md`. Topic frontmatter carries `name`, `description`, and `metadata.type` (`user`, `feedback`, `project`, or `reference`). Feedback/project bodies record the rule or fact, `Why`, and `How to apply`, with dated provenance where relevant. Relative dates become absolute only when their reference date and relevant time zone are known; otherwise the model must ask or preserve uncertainty, not invent dates. The index contains links and short relevance hints rather than the full memories. Leading and trailing whitespace is trimmed before the escaped index preview is capped at 200 lines and 25,000 UTF-16 code units, with a warning if truncated; topic files are not eagerly loaded. Index files over 100,000 bytes, special files, and symlinked storage roots, project folders, or index files are refused with a warning rather than loaded. An empty index is fine, and subsequent runs pick up changes without reloading the extension. There are no background model requests, automatic transcript scans, or separate memory tools, and existing file-tool restrictions remain unchanged.

Notes live outside the repository under `<agent-dir>/grok-memory/projects/<project-name>-<path-hash>/` (normally `~/.pi/agent/grok-memory/projects/`). Git subdirectories share their nearest repository's project memory; linked worktrees and submodules keep separate memory. The resolver does not trust `.git` pointers to share another root's notes. Non-Git directories use their canonical working directory. The path-derived key separates unrelated projects with the same name. Even `user` memories are scoped to this project, not automatically shared across all repositories. The integration neither imports Claude Code memories nor modifies instruction files.

Disabling memory stops this feature's index reads, directory initialization, and new prompt injection after reload; it preserves saved files. Shutdown, session replacement, and superseding requests cancel pending loads before further filesystem operations begin. An operation already submitted to the operating system may finish; opened handles are still closed. Disabling cannot erase notes already seen in conversation or tool results, and does not prohibit explicit access through ordinary file tools. Start a new session if prior memory contents must not remain in the conversation. Engine child sessions do not install this root-session feature; definition-level agent memory is separate and unchanged.

Programmatic callers of `createGrokStyleExtension` that enable `features.memory` also supply `projectMemoryRoot`; the bundled full entrypoints configure it automatically. The memory module owns its session lifecycle and prompt cleanup separately from disk loading and policy rendering, keeping the central factory limited to wiring.

## Tool guard

Both full entrypoints enforce two rules on Linux and macOS:

- **Nothing is stored in `/tmp`.** `write` and `edit` into `/tmp` are blocked. So are shell commands that redirect into `/tmp`, set `TMPDIR=/tmp`, run `find` with a writing or `-exec` action there, or run anything other than a read, print, measure or remove command (`ls`, `du`, `cat`, `echo`, `rm`, …) on a `/tmp` path. Quoted text and heredoc bodies are not commands. Shell commands whose `TMPDIR` is unset or under `/tmp` run with `TMPDIR=~/.cache/pi-tmp`. Pi's own environment keeps its `TMPDIR`.
- **Test runs time out.** A shell call that runs `ctest`, `pytest`, `npm test`, `cargo test`, `go test`, `node --test`, `just test…` or a `*_tests` binary, whose own invocation has no `timeout` wrapper or `--timeout` flag, and no tool timeout, gets a 1800-second tool timeout. `PI_TEST_TIMEOUT_S` changes it.

## Diamond interaction

Mouse input needs Pi's fullscreen mode. Every diamond follows one table, defined in `src/tools/interaction.ts`:

| Gesture | On the header (`◆` row) | On the body |
|---|---|---|
| Click | Toggle open/closed. Edit diffs and new-file writes only open; they close on Alt-click | Nothing, so selecting text never collapses a diamond |
| Alt-click | Toggle | Close |
| Ctrl+click | Open the file target | Open the file target; on read, edit, and write source rows, at the clicked line |
| Double-click a source line | n/a | Insert `path:line` at the message cursor (read, edit, write) |

File targets: `read`, `edit`, and `write` open their file at the offset, change line, or line 1; `grep`, `find`, and `ls` open their `path` argument (a directory opens as a folder); `show_image`, `show_video`, and `show_html` open their file. Source-tool targets always open in Cursor, preserving source-line locations even for HTML. Media-tool targets open in the desktop's default app, matching image, video, and HTML file links in replies. `bash`, `Agent`, `codemode`, and notices have no target, so Ctrl+click does nothing there. Ctrl+click always takes precedence over a plain click and never toggles, and every click a diamond ignores is consumed so Pi does not toggle it instead. Ctrl+O resets every diamond to the global state. In the activity bar, clicking anywhere on an entry's row opens its viewer; View, Stop, and Close keep their own targets.

## Feature settings

Use `/grok-style` to toggle the footer, composer frame, tool styling, activity panel, terminal colors, communication style, in-process subagent autonomy, Herdr pane routing, and project memory independently. Choices are saved in `~/.pi/agent/grok-style.json` (or your configured Pi agent directory). Run `/reload` after changing them. Project memory defaults to off; the other features default to on.

Use `/grok-style autonomy off` to require an explicit user request before in-process delegation, or `autonomy on` to enable the engine's positive-delegation guidance. This changes model guidance, not automatic host-side launching. You can also use `/grok-style activity off`, `/grok-style terminalColors off`, or `/grok-style all off`. Keys are `footer`, `composer`, `toolStyling`, `activity`, `terminalColors`, `communication`, `autonomy`, `panes`, and `memory`. Tool styling and activity tracking remain independently configurable. Choose a theme through Pi's `/theme` menu.

Diff and comment colors are optional `#rrggbb` values under `colors` in the same file. The keys are `diffInsert` (`#063806`), `diffDelete` (`#420e14`), `diffInsertChar` (`#0c5b10`), `diffDeleteChar` (`#6c1a22`), `comment` (`#a0a8b8`), `commentDoc` (`#aab4c6`), and `commentDocEmphasized` (`#b4bed4`). Set one with `/grok-style color diffInsertChar #0c5b10`, or `/grok-style color comment reset` to restore its default. Comment colors apply when `bat` is available. Run `/reload` after changing them.

Communication style adds Grok Build's reply rules: complete sentences, lead with the answer, and a standalone final message. It also asks for standalone inline-code file references such as `src/app.ts:42`. On Linux, those references use this extension's `grok-pi-file://` URL handler. Clicks return to their owning Pi session. Image, video, and HTML file references (such as `screenshots/result.png`, `clips/demo.mp4`, and `preview.html`) open in the desktop's default application via `xdg-open`; other file references call the same Cursor workspace opener as code-row Ctrl+click, `/open`, and `ctrl+alt+o`: it reuses the workspace window, opens the workspace root when needed, and shares the once-per-session `compile_commands.json` refresh. Code links preserve their line and column, and neither kind of link replaces the last-edited target. Web links and Cursor's own URL association are unchanged. No Pi modifications are required.

The extension refreshes that handler when a session starts. Its `Exec` line is unquoted, because `xdg-open` keeps quote marks and otherwise opens the link in the web browser. Run `npm run setup:file-links` once from this checkout if a session has not started yet, then `/reload` in Pi. This installs a user-level desktop URL handler pointing to this checkout and the current Node executable; rerun setup if either moves. It works with Pi's fullscreen link activation and terminal-owned links in regular mode. The helper communicates over a private, user-owned Unix socket and can only open targets already rendered by the owning extension instance. It never launches an application independently; the owning Pi session opens the target. Links expire when their Pi session closes or reloads; use the freshly rendered links after `/reload`. Other platforms retain `cursor://` links through the system handler.

## Activity controls

Load `integrations/subagents.ts` instead of the default Grok entrypoint to use the bundled [subagent engine](packages/subagent-engine/README.md). It always installs the engine, inside or outside Herdr, with in-process Pi sessions as the default backend. Disable the former Pi Subagents extension to avoid duplicate tools; no globally installed subagent package is required. The engine owns `Agent`, `SendMessage`, `TaskStop`, the four shared-task tools, `Workflow` (`RunWorkflow` alias), and the `get_subagent_result` / `steer_subagent` compatibility aliases.

When switching an existing package installation, disable this package's default extension: use `{"source":"/path/to/grok-style-pi","extensions":[]}` in `packages` and add `/path/to/grok-style-pi/integrations/subagents.ts` to `extensions`. Themes remain installed. Load only one Grok entrypoint and only one subagent extension, then run `/reload`. The combined entrypoint includes the same core chrome and codemode styling as the default entrypoint.

The activity bar reserves space above the composer when a shell tool or engine subagent runs. Agent rows show the effective model and effort reported by the engine. Click **View** to follow its live output, **Stop** to request a user-source cancellation of that agent, or **Close** to hide it without cancelling. Hidden agents remain accessible through `/activity`, and resumed agents reappear. Stopping a shell command preserves its parent turn and peers. Separate **Active subagents** and **Active tasks** sections show up to three entries each; the latter are shell commands, not the engine's shared task list. Finished entries leave the bar but remain inspectable through `/activity` (up to twelve).

Streaming activity redraws are coalesced to one per 16 ms; cancellation and terminal statuses update immediately. Public `agentSnapshots()` values restore running entries after handover; engine events feed transcripts bounded to the latest 64,000 characters. The activity adapter never reads the engine's mutable registry. Engine-managed pane agents appear alongside in-process agents, subject to the events their backend provides.

The centered viewer has a full border and a top-right **Close** button. In the viewer, use **↑/↓**, **Page Up/Down**, and the mouse wheel to scroll; **End** resumes following new output. **x** stops a running entry and **Esc** closes the viewer. Recent finished runs stay available until dismissed (up to twelve).

### Combined and standalone Herdr

Inside Herdr (`HERDR_ENV=1`), the combined entrypoint additionally attaches [herdr-subagents](packages/herdr-subagents/README.md) as a headless pane backend, not a second set of tools. `Agent` calls from the top-level session run in a Herdr pane; `backend: "in-process"` keeps one in-process. The engine sends the pane its resolved definition: prompt, model and effort, and for a restricted definition such as Explore or Plan, the tool allow-list compiled against this session's tools. An `Agent(type)` grant drops `Agent`; Claude Code keeps only the built-in tools it can enforce. The pane loads its own context files. Definitions with preloaded skills, agent memory, hooks or MCP servers, and forks, worktree, workflow, skill and nested agents, including a pane child's own agents, run in-process; an explicit pane request for such a definition is refused. `/grok-style panes off` runs every agent in-process unless a call requests `backend: "pane"`, a saved `machine`, or `runtime: "claude-code"`. Request those only when the user asks for the corresponding pane, remote machine or Claude Code runtime. The combined setup uses the engine's schema and autonomy guidance; `/grok-style autonomy off` selects explicit-only delegation guidance. The standalone runner's policy does not replace it.

To use the runner without Grok styling:

```bash
pi install /path/to/grok-style-pi/packages/herdr-subagents
```

The standalone entrypoint activates only inside Herdr and installs its own `Agent`, `get_subagent_result`, and `steer_subagent` tools with explicit-request guidance and pane execution by default. Use it with Grok's default `extensions/index.ts` for chrome plus native runner tools, or use the combined integration for engine-managed in-process and pane agents. Never enable the standalone extension alongside the combined integration. Install the chosen entrypoint on machines where Pi pane children run.

A Herdr pane closes once its agent completes, like a finished Claude subagent. Closing requires a loadable saved session and freshly verified idle, unfocused session identity; running, blocked, failed, pinned and user-focused panes stay open, as do panes someone works in after completion. Closed finished agents are `parked`: their results remain available and resume opens the saved conversation in a new pane. Set `closeWhenDone: false` in `~/.pi/agent/herdr-subagents.json` to keep finished panes open, then `/reload`. In standalone and combined mode, `Agent.keep: true` or agent-file `keep: true` pins a pane across resumes; explicit `keep: false` overrides the file default. `keep` does not select a pane backend and has no effect on in-process agents. Verified local owner-session termination cancels eligible Pi children and closes their owned panes, including pinned ones; moved or parked parents retain ownership. Remote owner termination and active Claude cancellation are excluded from automatic cleanup. Both cleanup paths require a valid saved conversation and working directory. See [Pane lifecycle](packages/herdr-subagents/README.md#pane-lifecycle) for configuration and safety rules.

Herdr retains its pane identities, database and authoritative completion outbox. In the combined setup, the backend passes notices to the engine instead of sending a second Pi message: the engine maps identities, routes an engine notice to the owner/root, and acknowledges Herdr after the destination receipt. Reading a result, queueing a message or rendering a diamond is not that receipt. Standalone notices retain `herdr-subagent-notification`; engine-routed notices use `subagent-notification`. Remote worker settings and legacy paths are documented in the [runner README](packages/herdr-subagents/README.md).

Engine tools use collapsed diamonds: `◆ Explore: <description>`, `◆ Message <to>`, `◆ Stop agent <id>`, task rows such as `◆ Task #3 · in_progress`, and `◆ Workflow · <name> · <runId>`. Workflow activity groups child rows by phase under one entry, with cached/failed counts, log and child-output tails, and whole-workflow Stop. Click a diamond or use Ctrl+O to expand it; Ctrl-click a workflow diamond opens its saved script. Result and steering aliases retain their rows. Completion notices, agent messages and stop feedback use title-first diamonds. Disabling `toolStyling` changes display only.

## Steering inbox

Every Pi session that loads this package watches a per-session inbox, so another process can message it while it works. A sender writes `<id>.json` containing `{"text": "...", "from": "Claude Code", "sentAt": <epoch ms>}` (to a `.tmp` name first, then renamed) into `<root>/<Pi session id>/`. The root is `$GROK_STEER_DIR`, else `$XDG_STATE_HOME/grok-style-pi/steer` (default `~/.local/state/grok-style-pi/steer`, under the user's home on Windows too). A message file also carries `owner`, the token of the owner instance the sender verified (below); an instance whose token differs rejects it with `owner changed` before dispatch. Within about 250 ms the session submits the message as a user message whose first line is `[Steering message from <from> | id <id>]`. Pi's `sendUserMessage` returns nothing and gives no admission feedback, so receipts are tied to that id and to Pi's own events, never to timing, and a conversation message confirms only when its text equals the submitted text exactly (a header carrying a pending id with other content is ignored).

Acknowledgements (`<id>.ack`):
- `delivered`/`prompt`: an idle prompt's user message entered the conversation.
- `delivered`/`steer`: a busy steer's user message entered the conversation (after the running tool call finished) within 1.5 s of Pi reporting it queued.
- `queued`: Pi's `input` event reported it queued behind a running turn, but its conversation message was not seen in 1.5 s. This is not confirmation. A later input handler can still consume or rewrite it, and then it never reaches the agent.
- `unconfirmed`: Pi reported nothing within 10 s (dropped during compaction, consumed by an input handler, still being prepared). It may still run. Senders must treat it as outcome unknown.
- `rejected`: only for invalid or empty messages, messages older than 10 minutes, and owner mismatches.

While an earlier message is unobserved and Pi looks idle, later messages wait, but only up to 15 s. After that hold, an unconfirmed idle prompt may race a later message, be dropped, or run out of order relative to later messages: there is no per-submission admission or cancellation API, so serialization is best effort. Compaction state is not inferred; there is no authoritative signal. A sender with no acknowledgement may delete its own `.json`; if that fails the message was already claimed and may still be delivered.

One live process owns an inbox. `<root>/<session id>/.owner` holds `{pid, token, sessionFile, startedAt}`, published atomically (temporary file hard-linked or renamed into place). Owner changes run under a mutex file `.owner.lock` that names its holder (pid and token) and is taken over only when that holder process is dead, never because it is old. Startup retries a busy mutex with backoff for up to 15 s without blocking Pi, and warns if watching stays disabled (`/reload` retries). A second Pi using the same session id warns and does not watch. `sessionFile` is the Pi session file that Herdr reports as the agent's session, so a sender can check that the owner is the Pi it means to address. Herdr exposes no process id for agents, so two Pi processes running the very same session file cannot be told apart. Acknowledgements older than an hour are removed at session start. It uses only documented events (`session_start`, `input`, `message_start`, `session_shutdown`) and `pi.sendUserMessage`; the session id is `ctx.sessionManager.getSessionId()`, so `pi --session-id NAME` makes the inbox address predictable. Sessions started before this version need `/reload`. Claude Sidecar's `sidecar steer` is the first sender.

## Code organization

Both full Grok entrypoints call `extensions/install.ts` once to wire Pi's editor and built-in tool factories into `createGrokStyleExtension`. The independent `integrations/media.ts` entrypoint installs only the reusable media extension in `src/media/`. The combined subagent entrypoint adds one engine and, inside Herdr, an optional pane backend. The factory in `src/extension.ts` coordinates feature settings, tool registration and session lifecycle; its public exports and injected dependencies remain available.

| Module | Owns |
|---|---|
| `src/extension.ts`, `src/extension/` | Factory, session lifecycle, feature settings, opt-in project memory, communication, and usage tracking |
| `src/tools/` | Shared diamond section state/layout, rendering-only section decoration, specialized file/shell rendering, write previews, and tool settings |
| `src/tools/sections/` | Unstyled summary/body adapters for codemode, subagent rows, and ordinary text tools |
| `src/rendering/` | Cached layouts, diffs, syntax colors, palette data, and background visual workers |
| `src/chrome/` | Composer, footer, terminal colors, theme loading, and color settings |
| `src/navigation/` | Shared session links, desktop media opening, edit targets, workspace preparation, and Cursor launching |
| `src/media/` | Reusable media registration and playback lifetime, plus the standalone media extension |
| `src/activity/` | Activity panel state and presentation |
| `src/subagents/` | Public-snapshot/event activity projections, result styling and Herdr availability detection |
| `packages/subagent-engine/` | Engine admission, agent sessions, messaging, shared tasks, workflows and backend routing |
| `packages/herdr-subagents/` | Standalone Herdr package: extension, runner, child sessions, CLI client, database worker, and runner tests |
| `src/herdr/*.mjs` | Compatibility forwarding entries for legacy remote Grok package roots and existing Claude hook commands |
| `src/steering/` | Per-session inbox that delivers externally submitted steering messages |
| `src/utils/` | Shared bounded text helpers |

To add a text-oriented tool section, define a `DiamondSection` with `summary(view)` and `body(view)`, then add it to the explicit adapter table in `src/tools/sections/index.ts`. Bodies return text or code blocks; the shell owns sanitization, expansion, clicks, highlighting, caching, and completed-result diff rows. Collapsed bodies are not evaluated. Ordinary adapters hide partial output; codemode returns live progress blocks. Tool execution and upstream metadata remain unchanged. The factory also accepts an injected `sections` table and returns `styleTool` for extension-owned registrations, sharing the session's visual preparation hooks. File navigation, source selection, default-open edit/write behavior, and media lifecycle stay specialized. Shell/write description guidance is applied separately from rendering.

The session modules keep their state and cleanup together; the factory calls their lifecycle methods. Behavior is tested through the factory and the existing rendering, navigation, and runner interfaces in `test/`.

## Tests

```bash
npm test
npm run test:bat
npm run test:herdr
npm run bench:performance
```

The performance benchmark reports redraw and resize timings, event-loop delay during cold preparation, replacement-diff costs, and fleet polling counts. Timing results are diagnostic; deterministic cache, queue, lifecycle, and lease assertions run in the test suite.

An optional current-Pi smoke test verifies public-factory integration, replaceable native codemode loading, disabled styling, activation defaults, sandbox execution, and session storage without model requests. Set `GROK_CURRENT_PI` to a current Pi package's public `dist/index.js`, then run `npm run test:current-pi`. This complements the older Pi development dependency used by the main test suite.

Requires Node 22.18+ on the 22.x line, or Node 24+ (type stripping) and `@earendil-works/pi-coding-agent` for the factory/consumer tests (`npm install`).

## Subagent integration contracts

`src/subagents/adapter.ts` projects public engine snapshots and events into activity rows, owns run identities and subscriptions, and routes Stop through `engine.userStop` or `engine.userStopWorkflow`. It does not import Control, read its registry, own child sessions or choose backend cancellation mechanisms. Old or disposed callbacks cannot stop a newer run.

Engine `spawned`, `run-event`, `settled`, and diagnostic events drive activity. Explicit run IDs distinguish continuations even when timestamps coincide. Completed rows retain at most 64,000 characters and no child-session references. Engine children load user extensions normally, but Grok's full entrypoints return early in child context so they do not install chrome, duplicate tools or steering watchers.

`npm test` runs strict typechecks and the Grok, engine and standalone Herdr suites. `npm run typecheck` runs the checks alone; `npm run test:herdr` runs the standalone package gate. `node --test test/activity.test.ts test/subagent-contract.test.ts test/workflow-activity.test.ts test/herdr-integration.test.ts` exercises integration contracts, including real Pi sessions with scripted offline models, reload hydration, cancellation and workflow rendering. Herdr tests use SQLite workers and separate processes with mocked pane operations; no live model requests are needed.