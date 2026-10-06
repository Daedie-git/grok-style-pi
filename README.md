# grok-style-pi

Grok Build-inspired chrome for [Pi](https://pi.dev): a GrokNight color theme, a `cwd │ model │ Context N% used │ usage` footer, a rounded composer with a `❯` prompt, and diamond (`◆`) tool rows.

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

## What you get

| Surface | Behavior |
|---|---|
| Theme | Neutral near-black gray + blue highlights `#7aa2f7` / `#7dcfff` (GrokNight) |
| Footer | One row: full working path (`~` for home) with the active Git branch, model, thinking level, and context and subscription usage for the active model only, followed by its logged-in account when available |
| Composer | Rounded frame and `❯` prompt; muted idle border, brighter focused border. Clearing a draft with Ctrl+C adds it to prompt history, so Up brings it back |
| Tools | Dim diamond summaries for shell commands (using their description when supplied), with readable file-tool labels; edit diffs open by default with green additions, red removals, and stronger character highlights on changed text; other output expands on demand. The dedicated `show_image` and `show_video` tools display media in open, closable diamonds; other images use Pi’s normal inline display |
| Activity | Live Bash/PowerShell commands and top-level subagents above the composer, with clickable View, Stop, and Close controls. Subagent rows show the run's model and thinking level |

Agents can call `show_image` with a local PNG, JPEG, GIF, or WebP path to share a screenshot in an expanded diamond. Click its diamond or image to close it, and click the diamond to reopen it. Ctrl+O also controls its expansion. The result stores the image for the transcript but sends only a path confirmation to the model; agents needing to inspect the pixels should use `read` separately. Files must be at most 10 MB. The tool is available when tool styling is enabled. Image file references in assistant replies still open in the default desktop image viewer when clicked.

Agents can call `show_video` with a local MP4, M4V, MOV, MKV, WebM, or AVI path for silent, animated playback in a diamond. Click the diamond or preview to stop and close it; click again to restart from the beginning. In fullscreen mode, Ctrl+click the video diamond or preview to open the full video with sound in the desktop's default player without toggling the preview. It uses `ffmpeg` to stream a bounded, 15-frame-per-second terminal preview without storing frames in the session or sending them to the model. The player stops when closed, when navigating to another conversation branch, after compaction, or when the session shuts down. The agent should also link the path in its reply: on Linux, clicking a video file reference opens the full video (including sound) in the desktop's default video player. `ffmpeg` and Kitty image support are needed for inline playback; in Herdr, enable `[experimental] kitty_graphics = true` and reattach its client.

Built-in tools (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) use Pi’s full `create*ToolDefinition` factories, preserving built-in prompt guidance and execution. Disabling tool styling restores their native renderers. Styled tool text is sanitized before theme colors are applied. Expanded reads, new-file and unrecorded write previews, and Bash or PowerShell command lines are syntax-highlighted with Grok Build's Grok Night theme when `bat` is available. That is the same syntect theme as Grok Build, so punctuation, operators, types, and identifiers are colored, not left plain. Comments are lightened to `#a0a8b8` so they stay readable on the green and red diff backgrounds. Without `bat`, small previews fall back to Pi's highlighter; large previews stay plain to keep rendering bounded. `bat` selects the grammar from the file name, so C++, headers, CUDA, JavaScript, TypeScript, Rust, Python, shell, PowerShell, and the rest of its language set are covered. The Pi fallback still maps those same extensions explicitly. Assistant Markdown fences still use Pi's highlighter and need a language tag such as `cpp`. Edit diffs syntax-color the code, including unchanged context lines. Added rows use the green insert background and removed rows use the red delete background. Changed characters use `#0c5b10` and `#6c1a22`, extended to the whole word when the edit falls inside one. Leading indentation stays on the row background. A pure insertion or deletion keeps the row background. If the theme is not ready, those rows fall back to one output color. Expanded read panels use GrokNight's code-block background, `#1c1c1c` (`bg_dark` in `groknight.rs`), which is lighter than the `#141414` transcript. Alt-click an edit diamond or its diff to collapse it, and click the diamond to reopen it. In fullscreen mode, double-click a source line in an expanded read, edit diff, or write preview to insert its `path:line` reference at the message cursor without closing the diamond; wrapped source lines keep their original line number. Drag-select source text in one diamond, then click within the selection to insert `path:start-end` for multiple lines, or `path:line` if the selection spans only one source line (including wrapped rows). Read continuation notices and diff headers are not source locations; numbered removed lines refer to the old file line. Ctrl+click an edit, write, or read row to open that file in Cursor's classic IDE at the change line, reusing a window already opened on the git workspace. If no matching window exists, Cursor opens the workspace root before navigating to the file. `/open` and `ctrl+alt+o` jump to the last edit. Ctrl+O still controls global expansion; expanding and then collapsing all tools also closes edit diffs.

Cursor opening prefers an already-mounted Linux AppImage CLI, avoiding another AppImage mount, and falls back to the normal launcher if that mount disappears. `/open pick` lists this session's successful edits and writes; opening a read row does not replace the last-edited target. Launch failures are reported without exiting Pi.

The first Cursor open per workspace in each Pi session also refreshes `compile_commands.json` when an existing CMake or Meson build can be identified. This applies to Ctrl-click, `/open`, and the shortcut. The existing database (including a symlink or root-level copy) guides build-directory selection; otherwise a bounded search looks for configured builds. CMake reuses its cache and enables compilation-database export for supported Ninja/Makefile generators; Meson reconfigures its existing build. No new preset is guessed and no full build is invoked. Configuration commands have a 60-second timeout. Root-level database copies are updated and symlinks are preserved.

The first open waits for regeneration, with a progress notification; concurrent clicks share that refresh, and later opens skip it. Automatic configuration only runs for the trusted session workspace—not unrelated repositories reached by clicking an external file. Non-native projects are skipped. Ambiguous, unsupported, or failed refreshes warn and still open Cursor. Switching sessions or `/reload` resets the once-per-workspace check and cancels pending refreshes.

Write rows report `Creating` or `Replaced`. A new file is an all-insert diff: the header says `Creating <path>`, a collapsed row shows `+N/-0`, and each line has a green gutter, GrokNight's green insert background `#063806`, and syntax-colored source. Tabs expand to four spaces. Alt-click the diamond to collapse it, and click it to reopen it. Replacements expand on demand to show their colored diff. The previous contents are captured inside Pi's per-file write queue. Previews are bounded: new contents show up to 16,000 characters; diffs require both versions to fit within 64 KB and 1,000 lines each. Larger or unreadable originals fall back to a labeled content preview. Older session entries and custom remote write operations use `Wrote` when creation/replacement cannot be established; previous contents are never inferred from the current file. Original tool-result text sent to the model is preserved.

Pi's `codemode` scripts also use a collapsed diamond row. Once nested-call metadata arrives, a single call shows its description or file target, such as `◆ codemode · Inspect timing changes` or `◆ codemode · Read src/app.ts`. Multiple calls show a compact breakdown, such as `◆ codemode · Read 3 files · Run 1 command`. While running, the row shows how many observed calls have finished; failures and cancellations keep their counts visible. Older or truncated metadata falls back to tool names, never guesses from the JavaScript. Before calls arrive, the row reads `◆ codemode`. Click the diamond or use Ctrl+O to show the JavaScript, live nested-call statuses and timings, model-call costs, and script output. Click again to close it. Script errors retain their partial output. Styling uses Pi's public `createCodemodeExtension` factory and does not enable codemode automatically or change its sandbox, tool discovery, storage, or execution. Older Pi versions without that factory keep their existing tools; disabling tool styling leaves Pi's native codemode renderer in place.

Tool panels reuse their completed layout while their width, content, and colors are unchanged. Syntax highlighting, detailed diff preparation, and large colored layouts run in a lazy background worker. Panels display readable text immediately, then add syntax and character colors without waiting on `bat`. Small previews use Pi's highlighter while preparation is pending; large previews initially use plain text with the diff backgrounds. Oversized replacement blocks keep line-level coloring when detailed character matching exceeds its work budget. Background work is deduplicated and bounded, and reload discards pending results. The `bat` theme cache is reused across sessions when its theme and `bat` version match.

Pi still controls transcript spacing and message layout, so this is an approximation of Grok Build rather than a complete replacement of Pi’s interface.

The grayscale values follow Grok Build's GrokNight implementation: Markdown body text (including bold) and secondary output use `#c8c8c8`; primary UI text and user messages use `#e1e1e1`. The cursor uses `#c8c8c8` (`accent_user`). Terminal foreground uses the Markdown body color because Pi's plain assistant prose inherits it. These values are sourced from `crates/codegen/xai-grok-pager-render/src/theme/groknight.rs`, `theme/md_style.rs`, and `xai-grok-pager/src/scrollback/blocks/user.rs` in the local Grok Build checkout at `e82a7e60` (source revision `28439e8a8712c363321cf6ff0c2d70cd058d2a7d`). The stale `#f3f3f3` comment in that palette does not reflect its actual constants.

Our blue accent overrides remain a customization: Grok Build's source also uses teal/purple headings and mixed syntax colors. Pi exposes a single heading color, while Grok Build styles heading levels separately. Run `/reload` after editing the palette. Terminal colors are applied at session startup before file-link setup and tool settings are loaded, with one full redraw to repaint unchanged rows. With terminal colors disabled, plain assistant prose and editor input inherit your terminal's colors. In fullscreen mode, a Node process warning triggers a full repaint so its raw stderr text cannot remain over an unchanged composer or footer; the warning also appears as a Pi notification. This does not suppress host warnings, and the listener is removed on shutdown or reload. On Node 22, database and visual workers suppress the specific `UNDICI-EHPA` proxy-agent startup notice, which otherwise writes into Pi before worker JavaScript runs. Proxy behavior and unrelated diagnostics remain unchanged. Pi controls Markdown list markers (dashes), selection rendering, and transcript spacing; this extension does not replace those renderers.

The footer shows context and allowance only for the selected model. Other providers are omitted, and their refresh stops on model change. With the `/fast` extension installed, GPT models on `openai` or `openai-codex` also show an accent-colored `Fast: on` while priority processing is requested, or `Fast: off` in the footer's default color otherwise. The indicator disappears when a non-GPT model is selected; it does not confirm that the server granted priority processing.

For `openai-codex`, that is this session's context (`Context N% used`) and weekly quota remaining (for example, `Weekly 46% left`). Quota refreshes in the background at startup and once per minute using the existing Pi ChatGPT login and Codex's usage endpoint. Response headers also update the display when available. This works with WebSocket transport and makes no model requests. Refresh stops when the footer is disabled, the model changes away from Codex, or the session closes. Unavailable or expired data is not shown as a known percentage; authentication failures display `login required`. The usage endpoint is an internal Codex service and may change.

For `xai`, that is the Grok session for this working directory (`Context N% used`, from that session's saved context-window percent) and allowance remaining (`Weekly N% left`). Weekly allowance refreshes at startup and once per minute with the existing Pi xAI login and Grok's credits endpoint. Context is re-read locally every few seconds. A missing Grok session or a non-weekly allowance shows `?`. Authentication failures display `login required`. The credits endpoint is an internal Grok service and may change.

For Codex and xAI logins, the footer appends `Account <email or name>` after usage. If the login token provides neither, it shows the account ID instead. Identity refreshes at startup, on model changes, and once per minute using the existing Pi login, without extra account endpoint requests. API keys and logins without a readable identity omit this item. On narrow terminals, the account is shortened first and dropped when fewer than 12 columns remain, so the path and model stay visible.

Any other model shows this Pi session's context (`Context N% used`) and no subscription line.

## Feature settings

Use `/grok-style` to toggle the footer, composer frame, tool styling, activity panel, terminal colors, and communication style independently. Choices are saved in `~/.pi/agent/grok-style.json` (or your configured Pi agent directory). Run `/reload` after changing them. All features default to on.

You can also use `/grok-style activity off`, `/grok-style terminalColors off`, or `/grok-style all off` (replace `off` with `on` to enable). The available keys are `footer`, `composer`, `toolStyling`, `activity`, `terminalColors`, and `communication`. Disabling tool styling restores Pi's native tool rendering; activity tracking remains independently configurable. Choose a different theme through Pi's `/theme` menu.

Diff and comment colors are optional `#rrggbb` values under `colors` in the same file. The keys are `diffInsert` (`#063806`), `diffDelete` (`#420e14`), `diffInsertChar` (`#0c5b10`), `diffDeleteChar` (`#6c1a22`), `comment` (`#a0a8b8`), `commentDoc` (`#aab4c6`), and `commentDocEmphasized` (`#b4bed4`). Set one with `/grok-style color diffInsertChar #0c5b10`, or `/grok-style color comment reset` to restore its default. Comment colors apply when `bat` is available. Run `/reload` after changing them.

Communication style adds Grok Build's reply rules: complete sentences, lead with the answer, and a standalone final message. It also asks for standalone inline-code file references such as `src/app.ts:42`. On Linux, those references use this extension's `grok-pi-file://` URL handler. Clicks return to their owning Pi session. Image and video file references (such as `screenshots/result.png` and `clips/demo.mp4`) open in the desktop's default application via `xdg-open`; other file references call the same Cursor workspace opener as code-row Ctrl+click, `/open`, and `ctrl+alt+o`: it reuses the workspace window, opens the workspace root when needed, and shares the once-per-session `compile_commands.json` refresh. Code links preserve their line and column, and neither kind of link replaces the last-edited target. Web links and Cursor's own URL association are unchanged. No Pi modifications are required.

The extension refreshes that handler when a session starts. Its `Exec` line is unquoted, because `xdg-open` keeps quote marks and otherwise opens the link in the web browser. Run `npm run setup:file-links` once from this checkout if a session has not started yet, then `/reload` in Pi. This installs a user-level desktop URL handler pointing to this checkout and the current Node executable; rerun setup if either moves. It works with Pi's fullscreen link activation and terminal-owned links in regular mode. The helper communicates over a private, user-owned Unix socket and can only open targets already rendered by the owning extension instance. It never launches an application independently; the owning Pi session opens the target. Links expire when their Pi session closes or reloads; use the freshly rendered links after `/reload`. Other platforms retain `cursor://` links through the system handler.

## Activity controls

To collapse `Agent` launches and `get_subagent_result` behind diamonds, load the optional `integrations/subagents.ts` entrypoint instead of the npm package's direct entrypoint. Outside Herdr it loads the globally installed `npm:@tintinweb/pi-subagents` and decorates only those tools' rendering; execution, waiting, cancellation, and notification consumption remain owned by Pi Subagents. Inside Herdr it loads this package's pane runner instead, described below. It also removes the Agent and SubagentWorkflow system-prompt instructions that invite unsolicited spawns. Those tools stay available, but their descriptions say to call them only when you explicitly ask. In Pi settings, keep its package installed with `{"source":"npm:@tintinweb/pi-subagents","extensions":[]}` and add `/path/to/grok-style-pi/integrations/subagents.ts` to `extensions`. Do not also enable the original entrypoint. Run `/reload`. Collapsed rows read `◆ Explore: <description>` and `◆ Read agent result <id>`; Ctrl+O expands the full output. Disabling `toolStyling` restores the original result display through the same wrapper.

When switching an existing package installation to the subagent entrypoint, also disable **this package's** default extension. For example, replace its string in `packages` with `{"source":"/path/to/grok-style-pi","extensions":[]}` and retain `/path/to/grok-style-pi/integrations/subagents.ts` in `extensions`. The package's themes remain installed. Both entrypoints now include the core chrome and tool styling, so loading both produces tool-registration conflicts. Pi may separately report that its replaceable built-in codemode extension was superseded by this package; the styled tool still uses Pi's public codemode factory.

The activity bar reserves space above the composer when a shell tool or subagent runs. Each active subagent row shows that run's model and thinking level when the session or spawn record reports them; a clamped level or overridden model is marked with what was asked. The same line appears in the viewer and the `/activity` list. The bar does not cover the transcript or register a persistent overlay. Click **View** to follow its live output, **Stop** to cancel that specific run, or **Close** on the right to dismiss any entry. Closing a running entry hides it without stopping it; it remains accessible through `/activity`. Stopping a shell tool preserves the parent turn and other concurrent tools. Separate **Active subagents** and **Active tasks** sections show up to three entries each. Finished, failed, and stopped entries disappear automatically; empty sections take no space. Click a section heading or use `/activity` to inspect retained history.

Streaming activity redraws are coalesced to one per 16 ms; cancellation and terminal statuses update immediately. Live transcripts are assembled only when viewed, cached until they change, and bounded to the most recent 64,000 characters.

The centered viewer has a full border and a top-right **Close** button. In the viewer, use **↑/↓**, **Page Up/Down**, and the mouse wheel to scroll; **End** resumes following new output. **x** stops a running entry and **Esc** closes the viewer. Recent finished runs stay available until dismissed (up to twelve).

### Standalone Herdr plugin

Inside Herdr (`HERDR_ENV=1`), the optional entrypoint loads the independently usable [herdr-subagents package](packages/herdr-subagents/README.md) instead of Pi Subagents. The runner owns Pi and Claude Code panes, balanced placement, remote SSH machines, results, resume, steering, cancellation, completion notices, and SQLite coordination. Grok decorates tool rendering and completion notices. Notices appear in expanded diamonds by default; click the diamond to collapse or reopen them, or use Ctrl+O to control expansion globally. Disabling `toolStyling` leaves notices in Pi's native display. The notice content and delivery remain unchanged. Existing combined installations keep working without settings changes.

To use the runner without Grok styling:

```bash
pi install /path/to/grok-style-pi/packages/herdr-subagents
```

Install it in Pi's user settings on each machine where children run. The standalone entrypoint does nothing outside Herdr. Load it **instead of**, not alongside, `integrations/subagents.ts`; both register the same tools. Using the standalone plugin with this package's direct entrypoint keeps Grok chrome but leaves subagent tool rendering native. The activity panel still tracks shell commands and in-process Pi Subagents, not Herdr agents.

Existing databases, run identities, session entries, protocol versions, and legacy `GROK_HERDR_REMOTE_*` configuration remain compatible. The state root intentionally stays under `grok-style-pi/herdr-subagents`; extraction requires no database migration. New `HERDR_SUBAGENTS_REMOTE_PACKAGE` and `HERDR_SUBAGENTS_REMOTE_NODE` overrides support standalone remote installations. See the [runner documentation](packages/herdr-subagents/README.md) for Claude Code, remote setup, placement, and legacy protocol upgrades.

Subagent integration uses the documented event bus and manager registry from `@tintinweb/pi-subagents`, when installed. It follows top-level agents started while this extension is active, including foreground resumes of retained agents (detected within the 500 ms refresh interval). Finished runs are also checked for timestamp changes so fast resumes refresh their results. Foreground resumes use session cancellation for Stop; the control is omitted when that capability is unavailable. The viewer includes streamed tool output, tracked separately for concurrent calls. Nested and workflow-owned agents remain managed by their owning extension and its `/agents` viewer. To avoid duplicate agent panels, turn off its Widget and Fleet view in `/agents → Settings`.

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

Both alternative entrypoints call `extensions/install.ts` once to wire Pi's real editor and built-in tool factories into `createGrokStyleExtension`. The optional subagent entrypoint therefore includes the same core chrome and codemode styling as the direct entrypoint, while still choosing exactly one subagent runner. The factory in `src/extension.ts` coordinates feature settings, tool registration, and session startup/shutdown. Its public exports and injected dependencies stay available from that file.

| Module | Owns |
|---|---|
| `src/extension.ts`, `src/extension/` | Factory, session lifecycle, feature settings, communication, and usage tracking |
| `src/tools/` | Shared diamond section state/layout, rendering-only section decoration, specialized file/shell rendering, write previews, and tool settings |
| `src/tools/sections/` | Unstyled summary/body adapters for codemode, subagent rows, and ordinary text tools |
| `src/rendering/` | Cached layouts, diffs, syntax colors, palette data, and background visual workers |
| `src/chrome/` | Composer, footer, terminal colors, theme loading, and color settings |
| `src/navigation/` | File links, edit targets, workspace preparation, and Cursor launching |
| `src/activity/` | Activity panel state and presentation |
| `src/subagents/` | In-process Pi Subagents adapter, result styling, and runtime selection |
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
npm run test:subagents
npm run test:herdr
npm run bench:performance
```

The performance benchmark reports redraw and resize timings, event-loop delay during cold preparation, replacement-diff costs, and fleet polling counts. Timing results are diagnostic; deterministic cache, queue, lifecycle, and lease assertions run in the test suite.

An optional current-Pi smoke test verifies public-factory integration, replaceable native codemode loading, disabled styling, activation defaults, sandbox execution, and session storage without model requests. Set `GROK_CURRENT_PI` to a current Pi package's public `dist/index.js`, then run `npm run test:current-pi`. This complements the older Pi development dependency used by the main test suite.

Requires Node 22.18+ on the 22.x line, or Node 24+ (type stripping) and `@earendil-works/pi-coding-agent` for the factory/consumer tests (`npm install`).

## Subagent integration contracts

`src/subagents/adapter.ts` owns subagent observation, run identity, subscriptions, and cancellation. The activity UI consumes its projections; it does not interpret registry state or choose cancellation mechanisms. One projection is the run's effective model and thinking level, taken from the live session and falling back to the spawn invocation. Each detected run gets an immutable identity, and callbacks from replaced or disposed runs cannot operate on the current run.

Lifecycle events discover agents. Registry polling reconciles foreground resumes, including those that finish between polls. Run boundaries use start timestamps and, for same-timestamp completed resumes, the session's latest user message. This is a view of the latest observed run, not an exhaustive history of runs that occur between polls. Completed entries are bounded to twelve; each stores a cached snapshot of at most 64,000 characters and releases its child session. Polling unchanged completions does not rebuild transcripts. The upstream `steered` status is treated as terminal. Live session cancellation is preferred for running agents; the documented RPC is used for queues and initial runs without session cancellation. Resumes without cancellation support do not offer Stop.

The default `npm test` first runs strict type checks for every production source and the subagent contract tests, then runs both Grok and standalone Herdr test suites. `npm run test:herdr` runs the standalone package's own typecheck and tests. Herdr tests use real SQLite workers and separate processes for concurrent resume, placement contention, process death, launch recovery, cancellation, reload, and notification delivery; Herdr pane operations are mocked. Use `npm run typecheck` to run those checks alone. `npm run test:subagents` exercises pinned Pi Subagents 0.19.0 with a real manager, resume runner, and Pi `AgentSession`. A local model transport supplies responses and failures; network access is blocked. Tests seed an existing manager record rather than exercising spawn discovery. They cover rapid success/failure, actual request cancellation, parent-signal isolation, stale Stop callbacks, same-millisecond resumes, and disposal. The subagent package is a development dependency only; users can still run the extension without it installed.
