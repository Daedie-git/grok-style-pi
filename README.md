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
| Footer | One row: full working path (`~` for home) with the active Git branch, model, thinking level, and context and subscription usage for the active model only |
| Composer | Rounded frame and `❯` prompt; muted idle border, brighter focused border |
| Tools | Dim diamond summaries for shell commands (using their description when supplied), with readable file-tool labels; edit diffs open by default with green additions, red removals, and stronger character highlights on changed text; other output expands on demand. Images use Pi’s normal inline display |
| Activity | Live Bash/PowerShell commands and top-level subagents above the composer, with clickable View, Stop, and Close controls. Subagent rows show the run's model and thinking level |

Built-in tools (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) use Pi’s full `create*ToolDefinition` factories, preserving built-in prompt guidance and execution. Disabling tool styling restores their native renderers. Styled tool text is sanitized before theme colors are applied. Expanded reads, new-file and unrecorded write previews, and Bash or PowerShell command lines are syntax-highlighted with Grok Build's Grok Night theme when `bat` is available. That is the same syntect theme as Grok Build, so punctuation, operators, types, and identifiers are colored, not left plain. Comments are lightened to `#a0a8b8` so they stay readable on the green and red diff backgrounds. Without `bat`, small previews fall back to Pi's highlighter; large previews stay plain to keep rendering bounded. `bat` selects the grammar from the file name, so C++, headers, CUDA, JavaScript, TypeScript, Rust, Python, shell, PowerShell, and the rest of its language set are covered. The Pi fallback still maps those same extensions explicitly. Assistant Markdown fences still use Pi's highlighter and need a language tag such as `cpp`. Edit diffs syntax-color the code, including unchanged context lines. Added rows use the green insert background and removed rows use the red delete background. Changed characters use `#0c5b10` and `#6c1a22`, extended to the whole word when the edit falls inside one. Leading indentation stays on the row background. A pure insertion or deletion keeps the row background. If the theme is not ready, those rows fall back to one output color. Expanded read panels use GrokNight's code-block background, `#1c1c1c` (`bg_dark` in `groknight.rs`), which is lighter than the `#141414` transcript. Alt-click an edit diamond or its diff to collapse it, and click the diamond to reopen it. Ctrl+click an edit, write, or read row to open that file in Cursor's classic IDE at the change line, reusing a window already opened on the git workspace. If no matching window exists, Cursor opens the workspace root before navigating to the file. `/open` and `ctrl+alt+o` jump to the last edit. Ctrl+O still controls global expansion; expanding and then collapsing all tools also closes edit diffs.

Cursor opening prefers an already-mounted Linux AppImage CLI, avoiding another AppImage mount, and falls back to the normal launcher if that mount disappears. `/open pick` lists this session's successful edits and writes; opening a read row does not replace the last-edited target. Launch failures are reported without exiting Pi.

The first Cursor open per workspace in each Pi session also refreshes `compile_commands.json` when an existing CMake or Meson build can be identified. This applies to Ctrl-click, `/open`, and the shortcut. The existing database (including a symlink or root-level copy) guides build-directory selection; otherwise a bounded search looks for configured builds. CMake reuses its cache and enables compilation-database export for supported Ninja/Makefile generators; Meson reconfigures its existing build. No new preset is guessed and no full build is invoked. Configuration commands have a 60-second timeout. Root-level database copies are updated and symlinks are preserved.

The first open waits for regeneration, with a progress notification; concurrent clicks share that refresh, and later opens skip it. Automatic configuration only runs for the trusted session workspace—not unrelated repositories reached by clicking an external file. Non-native projects are skipped. Ambiguous, unsupported, or failed refreshes warn and still open Cursor. Switching sessions or `/reload` resets the once-per-workspace check and cancels pending refreshes.

Write rows report `Creating` or `Replaced`. A new file is an all-insert diff: the header says `Creating <path>`, a collapsed row shows `+N/-0`, and each line has a green gutter, GrokNight's green insert background `#063806`, and syntax-colored source. Tabs expand to four spaces. Alt-click the diamond to collapse it, and click it to reopen it. Replacements expand on demand to show their colored diff. The previous contents are captured inside Pi's per-file write queue. Previews are bounded: new contents show up to 16,000 characters; diffs require both versions to fit within 64 KB and 1,000 lines each. Larger or unreadable originals fall back to a labeled content preview. Older session entries and custom remote write operations use `Wrote` when creation/replacement cannot be established; previous contents are never inferred from the current file. Original tool-result text sent to the model is preserved.

Tool panels reuse their completed layout while their width, content, and colors are unchanged. Syntax highlighting, detailed diff preparation, and large colored layouts run in a lazy background worker. Panels display readable text immediately, then add syntax and character colors without waiting on `bat`. Small previews use Pi's highlighter while preparation is pending; large previews initially use plain text with the diff backgrounds. Oversized replacement blocks keep line-level coloring when detailed character matching exceeds its work budget. Background work is deduplicated and bounded, and reload discards pending results. The `bat` theme cache is reused across sessions when its theme and `bat` version match.

Pi still controls transcript spacing and message layout, so this is an approximation of Grok Build rather than a complete replacement of Pi’s interface.

The grayscale values follow Grok Build's GrokNight implementation: Markdown body text (including bold) and secondary output use `#c8c8c8`; primary UI text and user messages use `#e1e1e1`. The cursor uses `#c8c8c8` (`accent_user`). Terminal foreground uses the Markdown body color because Pi's plain assistant prose inherits it. These values are sourced from `crates/codegen/xai-grok-pager-render/src/theme/groknight.rs`, `theme/md_style.rs`, and `xai-grok-pager/src/scrollback/blocks/user.rs` in the local Grok Build checkout at `e82a7e60` (source revision `28439e8a8712c363321cf6ff0c2d70cd058d2a7d`). The stale `#f3f3f3` comment in that palette does not reflect its actual constants.

Our blue accent overrides remain a customization: Grok Build's source also uses teal/purple headings and mixed syntax colors. Pi exposes a single heading color, while Grok Build styles heading levels separately. Run `/reload` after editing the palette. Terminal colors are applied at session startup before file-link setup and tool settings are loaded, with one full redraw to repaint unchanged rows. With terminal colors disabled, plain assistant prose and editor input inherit your terminal's colors. Pi controls Markdown list markers (dashes), selection rendering, and transcript spacing; this extension does not replace those renderers.

The footer shows context and allowance only for the selected model. Other providers are omitted, and their refresh stops on model change.

For `openai-codex`, that is this session's context (`Context N% used`) and weekly quota remaining (for example, `Weekly 46% left`). Quota refreshes in the background at startup and once per minute using the existing Pi ChatGPT login and Codex's usage endpoint. Response headers also update the display when available. This works with WebSocket transport and makes no model requests. Refresh stops when the footer is disabled, the model changes away from Codex, or the session closes. Unavailable or expired data is not shown as a known percentage; authentication failures display `login required`. The usage endpoint is an internal Codex service and may change.

For `xai`, that is the Grok session for this working directory (`Context N% used`, from that session's saved context-window percent) and allowance remaining (`Weekly N% left`). Weekly allowance refreshes at startup and once per minute with the existing Pi xAI login and Grok's credits endpoint. Context is re-read locally every few seconds. A missing Grok session or a non-weekly allowance shows `?`. Authentication failures display `login required`. The credits endpoint is an internal Grok service and may change.

Any other model shows this Pi session's context (`Context N% used`) and no subscription line.

## Feature settings

Use `/grok-style` to toggle the footer, composer frame, tool styling, activity panel, terminal colors, and communication style independently. Choices are saved in `~/.pi/agent/grok-style.json` (or your configured Pi agent directory). Run `/reload` after changing them. All features default to on.

You can also use `/grok-style activity off`, `/grok-style terminalColors off`, or `/grok-style all off` (replace `off` with `on` to enable). The available keys are `footer`, `composer`, `toolStyling`, `activity`, `terminalColors`, and `communication`. Disabling tool styling restores Pi's native tool rendering; activity tracking remains independently configurable. Choose a different theme through Pi's `/theme` menu.

Diff and comment colors are optional `#rrggbb` values under `colors` in the same file. The keys are `diffInsert` (`#063806`), `diffDelete` (`#420e14`), `diffInsertChar` (`#0c5b10`), `diffDeleteChar` (`#6c1a22`), `comment` (`#a0a8b8`), `commentDoc` (`#aab4c6`), and `commentDocEmphasized` (`#b4bed4`). Set one with `/grok-style color diffInsertChar #0c5b10`, or `/grok-style color comment reset` to restore its default. Comment colors apply when `bat` is available. Run `/reload` after changing them.

Communication style adds Grok Build's reply rules: complete sentences, lead with the answer, and a standalone final message. It also asks for standalone inline-code file references such as `src/app.ts:42`. On Linux, those references use this extension's `grok-pi-file://` URL handler. Clicks return to their owning Pi session and call the same Cursor workspace opener as code-row Ctrl+click, `/open`, and `ctrl+alt+o`: it reuses the workspace window, opens the workspace root when needed, and shares the once-per-session `compile_commands.json` refresh. Links preserve their line and column and do not replace the last-edited target. Web links and Cursor's own URL association are unchanged. No Pi modifications are required.

The extension refreshes that handler when a session starts. Its `Exec` line is unquoted, because `xdg-open` keeps quote marks and otherwise opens the link in the web browser. Run `npm run setup:file-links` once from this checkout if a session has not started yet, then `/reload` in Pi. This installs a user-level desktop URL handler pointing to this checkout and the current Node executable; rerun setup if either moves. It works with Pi's fullscreen link activation and terminal-owned links in regular mode. The helper communicates over a private, user-owned Unix socket and can only open targets already rendered by the owning extension instance. It never starts an editor independently. Links expire when their Pi session closes or reloads; use the freshly rendered links after `/reload`. Other platforms retain `cursor://` links through the system handler.

## Activity controls

To collapse `Agent` launches and `get_subagent_result` behind diamonds, load the optional `integrations/subagents.ts` entrypoint instead of the npm package's direct entrypoint. Outside Herdr it loads the globally installed `npm:@tintinweb/pi-subagents` and decorates only those tools' rendering; execution, waiting, cancellation, and notification consumption remain owned by Pi Subagents. Inside Herdr it loads this package's pane runner instead, described below. It also removes the Agent and SubagentWorkflow system-prompt instructions that invite unsolicited spawns. Those tools stay available, but their descriptions say to call them only when you explicitly ask. In Pi settings, keep its package installed with `{"source":"npm:@tintinweb/pi-subagents","extensions":[]}` and add `/path/to/grok-style-pi/integrations/subagents.ts` to `extensions`. Do not also enable the original entrypoint. Run `/reload`. Collapsed rows read `◆ Explore: <description>` and `◆ Read agent result <id>`; Ctrl+O expands the full output. Disabling `toolStyling` restores the original result display through the same wrapper.


The activity bar reserves space above the composer when a shell tool or subagent runs. Each active subagent row shows that run's model and thinking level when the session or spawn record reports them; a clamped level or overridden model is marked with what was asked. The same line appears in the viewer and the `/activity` list. The bar does not cover the transcript or register a persistent overlay. Click **View** to follow its live output, **Stop** to cancel that specific run, or **Close** on the right to dismiss any entry. Closing a running entry hides it without stopping it; it remains accessible through `/activity`. Stopping a shell tool preserves the parent turn and other concurrent tools. Separate **Active subagents** and **Active tasks** sections show up to three entries each. Finished, failed, and stopped entries disappear automatically; empty sections take no space. Click a section heading or use `/activity` to inspect retained history.

Streaming activity redraws are coalesced to one per 16 ms; cancellation and terminal statuses update immediately. Live transcripts are assembled only when viewed, cached until they change, and bounded to the most recent 64,000 characters.

The centered viewer has a full border and a top-right **Close** button. In the viewer, use **↑/↓**, **Page Up/Down**, and the mouse wheel to scroll; **End** resumes following new output. **x** stops a running entry and **Esc** closes the viewer. Recent finished runs stay available until dismissed (up to twelve).

Inside Herdr (`HERDR_ENV=1`), that same entrypoint loads the Herdr runner instead of Pi Subagents. `Agent`, `get_subagent_result`, and `steer_subagent` keep those names. Each spawn is a separate `pi` process in a new pane, so Herdr lists it as its own Pi instance. Placement coordinates a maximum of three agents per tab among these runners, including the parent; the next spawn opens a new tab. Unknown occupancy also opens a new tab. Unrelated Herdr clients can still exceed this cap. The tool instructions say to reuse a subagent for follow-up work and to start a new one only for new work. The sidebar name drops a leading `herdr-` and appends the model id and reasoning level as one suffix, such as `review · gpt-6-astra-xhigh`. The parent tools talk to it through local SQLite databases under `$XDG_STATE_HOME/grok-style-pi/herdr-subagents` (default `~/.local/state/grok-style-pi/herdr-subagents`), not by typing into the pane. A blocked child returns immediately and leaves the pane open for you to answer. Each resume creates a distinct run with its own retained result and completion notice; reading an earlier result cannot suppress a later notice. Finished panes stay open. `schedule` and worktree `isolation` are not offered. `inherit_context` clones the parent session file. A `.pi/agents/<type>.md` file, or the same file under the user agent directory, supplies the child prompt and tool allow-list. Outside Herdr, the entrypoint still loads Pi Subagents.

### Herdr coordination and upgrades

Herdr protocol 2 requires Node **22.18+ on the 22.x line, or Node 24+**. `control.sqlite` stores agents, immutable run identities, commands, launch progress, and notification receipts. `placement.sqlite` supplies a separate cross-process write lock; a process dying releases its lock without timestamp-based takeover. SQLite and lock contention run in a worker loaded with `jiti`, including when installed as an npm package. No coordinator daemon is required.

Command and notification polling remains at 200 ms. Background liveness checks use one batched Herdr agent listing per fleet interval (roughly once per second), shared through a short database lease. A stalled owner can be replaced after five seconds; late responses cannot update runs after takeover. Unknown or failed listings never count as proof of pane death. Command polling continues independently while Herdr is slow. Explicit tool and launch checks can still query individual agents.

- `Agent` results include both the stable agent ID and a run ID. `get_subagent_result` captures the current run once; an overlapping resume cannot change its answer. Pass its optional `run_id` to retrieve a retained earlier run, including the exact run named in a completion notice. Waiting itself never changes execution state. Cancelling a tool explicitly requests cancellation of its captured run and reports pending cancellation until the child acknowledges it.
- Launch intent is saved before opening a pane or starting Pi. If Herdr rejects the new pane as not yet an available shell (for example, while `direnv` loads a Nix environment), the launcher retries that pre-launch rejection for up to 60 seconds. Other startup failures are never automatically retried. Cancellation interrupts the wait. Cancellation before task publication closes the owned pane. Failed cleanup and uncertain pane-creation outcomes retain their reservations and diagnostics instead of silently retrying or claiming the child stopped. Abandoned known panes are cleaned up when another runner reconciles them. Uncertain creation requires inspecting Herdr; those reservations are not automatically discarded.
- A child attaches using **both its pane and Pi session identity**. Starting a new conversation in the same pane does not inherit the old child's tool restrictions. Reload reconstructs queued commands and live execution. A dispatch with an uncertain outcome is reported interrupted, never blindly replayed; a saved Pi completion checkpoint can repair an interrupted database update.
- Completion notices have stable run-scoped IDs. A queued notification is not a delivery receipt: the receipt is recorded only after the notification appears in Pi's saved session. Reload retries unacknowledged delivery. Delivery is not exactly-once across Pi's session file and SQLite, so a crash can produce a duplicate with the same notice ID.

This is a **versioned protocol change**, not an in-place migration of active agents. Finish or stop all legacy runs before switching, then reload or exit every legacy Pi process before starting new agents. Do not run the old and new coordinators together. Legacy results and conversations remain untouched, but legacy agents cannot be resumed with protocol 2. If a crashed legacy run still says it is active, first close its old Pi process, then archive its per-agent state directory and obsolete `panes/` index outside the state root. Do not remove control files while a legacy runner still uses them.

Subagent integration uses the documented event bus and manager registry from `@tintinweb/pi-subagents`, when installed. It follows top-level agents started while this extension is active, including foreground resumes of retained agents (detected within the 500 ms refresh interval). Finished runs are also checked for timestamp changes so fast resumes refresh their results. Foreground resumes use session cancellation for Stop; the control is omitted when that capability is unavailable. The viewer includes streamed tool output, tracked separately for concurrent calls. Nested and workflow-owned agents remain managed by their owning extension and its `/agents` viewer. To avoid duplicate agent panels, turn off its Widget and Fleet view in `/agents → Settings`.

## Code organization

`extensions/index.ts` wires Pi's real editor and built-in tool factories into `createGrokStyleExtension`. The factory in `src/extension.ts` coordinates feature settings, tool registration, and session startup/shutdown. Its public exports and injected dependencies stay available from that file.

| Module | Owns |
|---|---|
| `src/extension.ts`, `src/extension/` | Factory, session lifecycle, feature settings, communication, and usage tracking |
| `src/tools/` | Pi tool rendering, diamond summaries, write previews, and tool settings |
| `src/rendering/` | Cached layouts, diffs, syntax colors, palette data, and background visual workers |
| `src/chrome/` | Composer, footer, terminal colors, theme loading, and color settings |
| `src/navigation/` | File links, edit targets, workspace preparation, and Cursor launching |
| `src/activity/` | Activity panel state and presentation |
| `src/subagents/` | In-process Pi Subagents adapter, result styling, and runtime selection |
| `src/herdr/` | Separate Herdr extension, runner, child sessions, CLI client, and database worker |
| `src/utils/` | Shared bounded text helpers |

The session modules keep their state and cleanup together; the factory calls their lifecycle methods. Behavior is tested through the factory and the existing rendering, navigation, and runner interfaces in `test/`.

## Tests

```bash
npm test
npm run test:bat
npm run test:subagents
npm run bench:performance
```

The performance benchmark reports redraw and resize timings, event-loop delay during cold preparation, replacement-diff costs, and fleet polling counts. Timing results are diagnostic; deterministic cache, queue, lifecycle, and lease assertions run in the test suite.

Requires Node 22.18+ on the 22.x line, or Node 24+ (type stripping) and `@earendil-works/pi-coding-agent` for the factory/consumer tests (`npm install`).

## Subagent integration contracts

`src/subagents/adapter.ts` owns subagent observation, run identity, subscriptions, and cancellation. The activity UI consumes its projections; it does not interpret registry state or choose cancellation mechanisms. One projection is the run's effective model and thinking level, taken from the live session and falling back to the spawn invocation. Each detected run gets an immutable identity, and callbacks from replaced or disposed runs cannot operate on the current run.

Lifecycle events discover agents. Registry polling reconciles foreground resumes, including those that finish between polls. Run boundaries use start timestamps and, for same-timestamp completed resumes, the session's latest user message. This is a view of the latest observed run, not an exhaustive history of runs that occur between polls. Completed entries are bounded to twelve; each stores a cached snapshot of at most 64,000 characters and releases its child session. Polling unchanged completions does not rebuild transcripts. The upstream `steered` status is treated as terminal. Live session cancellation is preferred for running agents; the documented RPC is used for queues and initial runs without session cancellation. Resumes without cancellation support do not offer Stop.

The default `npm test` first runs strict type checks for every production source and the subagent contract tests, then runs the test suite. Herdr tests use real SQLite workers and separate processes for concurrent resume, placement contention, process death, launch recovery, cancellation, reload, and notification delivery; Herdr pane operations are mocked. Use `npm run typecheck` to run those checks alone. `npm run test:subagents` exercises pinned Pi Subagents 0.19.0 with a real manager, resume runner, and Pi `AgentSession`. A local model transport supplies responses and failures; network access is blocked. Tests seed an existing manager record rather than exercising spawn discovery. They cover rapid success/failure, actual request cancellation, parent-signal isolation, stale Stop callbacks, same-millisecond resumes, and disposal. The subagent package is a development dependency only; users can still run the extension without it installed.
