# grok-style-pi

Grok Build-inspired chrome for [Pi](https://pi.dev): a GrokNight color theme, a `cwd │ model │ Codex Context N% used │ Grok Context N% used │ Grok Weekly N% left` footer, a rounded composer with a `❯` prompt, and diamond (`◆`) tool rows.

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
| Footer | One row: full working path (`~` for home) with the active Git branch, model, thinking level, Codex context usage, Grok context usage, and Codex and Grok subscription usage |
| Composer | Rounded frame and `❯` prompt; muted idle border, brighter focused border |
| Tools | Dim diamond summaries for shell commands (using their description when supplied), with readable file-tool labels; edit diffs open by default with green additions, red removals, and changed-text emphasis; other output expands on demand. Images use Pi’s normal inline display |
| Activity | Live Bash/PowerShell commands and top-level subagents above the composer, with clickable View, Stop, and Close controls |

Built-in tools (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) use Pi’s full `create*ToolDefinition` factories, preserving built-in prompt guidance and execution. Disabling tool styling restores their native renderers. Styled tool text is sanitized before theme colors are applied. Click an edit diamond to collapse or reopen its diff. Ctrl+click an edit, write, or read row to open that file in Cursor's classic IDE at the change line, reusing a window already opened on the git workspace. `/open` and `ctrl+alt+o` jump to the last edit. Ctrl+O still controls global expansion; expanding and then collapsing all tools also closes edit diffs.

Cursor opening prefers an already-mounted Linux AppImage CLI, avoiding another AppImage mount, and falls back to the normal launcher if that mount disappears. `/open pick` lists this session's successful edits and writes; opening a read row does not replace the last-edited target. Launch failures are reported without exiting Pi.

The first Cursor open per workspace in each Pi session also refreshes `compile_commands.json` when an existing CMake or Meson build can be identified. This applies to Ctrl-click, `/open`, and the shortcut. The existing database (including a symlink or root-level copy) guides build-directory selection; otherwise a bounded search looks for configured builds. CMake reuses its cache and enables compilation-database export for supported Ninja/Makefile generators; Meson reconfigures its existing build. No new preset is guessed and no full build is invoked. Configuration commands have a 60-second timeout. Root-level database copies are updated and symlinks are preserved.

The first open waits for regeneration, with a progress notification; concurrent clicks share that refresh, and later opens skip it. Automatic configuration only runs for the trusted session workspace—not unrelated repositories reached by clicking an external file. Non-native projects are skipped. Ambiguous, unsupported, or failed refreshes warn and still open Cursor. Switching sessions or `/reload` resets the once-per-workspace check and cancels pending refreshes.

Write rows report `Created` or `Replaced`, the line count, and the model-provided file purpose when available. New files open by default with numbered `+` lines in the added-line diff color; click the diamond to collapse or reopen them. Replacements expand on demand to show their colored diff. The previous contents are captured inside Pi's per-file write queue. Previews are bounded: new contents show up to 16,000 characters; diffs require both versions to fit within 64 KB and 1,000 lines each. Larger or unreadable originals fall back to a labeled content preview. Older session entries and custom remote write operations use `Wrote` when creation/replacement cannot be established; previous contents are never inferred from the current file. Original tool-result text sent to the model is preserved.

Pi still controls transcript spacing and message layout, so this is an approximation of Grok Build rather than a complete replacement of Pi’s interface.

The grayscale values follow Grok Build's GrokNight implementation: Markdown body text (including bold) and secondary output use `#c8c8c8`; primary UI text and user messages use `#e1e1e1`. The cursor uses `#c8c8c8` (`accent_user`). Terminal foreground uses the Markdown body color because Pi's plain assistant prose inherits it. These values are sourced from `crates/codegen/xai-grok-pager-render/src/theme/groknight.rs`, `theme/md_style.rs`, and `xai-grok-pager/src/scrollback/blocks/user.rs` in the local Grok Build checkout at `e82a7e60` (source revision `28439e8a8712c363321cf6ff0c2d70cd058d2a7d`). The stale `#f3f3f3` comment in that palette does not reflect its actual constants.

Our blue accent overrides remain a customization: Grok Build's source also uses teal/purple headings and mixed syntax colors. Pi exposes a single heading color, while Grok Build styles heading levels separately. Run `/reload` after editing the palette. With terminal colors disabled, plain assistant prose and editor input inherit your terminal's colors. Pi controls Markdown list markers (dashes), selection rendering, and transcript spacing; this extension does not replace those renderers.

For `openai-codex`, the footer shows weekly quota remaining (for example, `Codex weekly 46% left`). It refreshes in the background at startup and once per minute using the existing Pi ChatGPT login and Codex's usage endpoint. Response headers also update the display when available. This works with WebSocket transport and makes no model requests. Refresh stops when the footer is disabled, the model changes away from Codex, or the session closes. Unavailable or expired data is not shown as a known percentage; authentication failures display `login required`. The usage endpoint is an internal Codex service and may change.

The same row also shows the Grok session for this working directory (`Grok Context N% used`, from that session's saved context-window percent) and Grok allowance remaining (`Grok Weekly N% left`). Weekly allowance refreshes at startup and once per minute with the existing Pi xAI login and Grok's credits endpoint. Context is re-read locally every few seconds. A missing Grok session or a non-weekly allowance shows `?`. Authentication failures display `login required`. The credits endpoint is an internal Grok service and may change.

## Feature settings

Use `/grok-style` to toggle the footer, composer frame, tool styling, activity panel, and terminal colors independently. Choices are saved in `~/.pi/agent/grok-style.json` (or your configured Pi agent directory). Run `/reload` after changing them. All features default to on.

You can also use `/grok-style activity off`, `/grok-style terminalColors off`, or `/grok-style all off` (replace `off` with `on` to enable). The available keys are `footer`, `composer`, `toolStyling`, `activity`, and `terminalColors`. Disabling tool styling restores Pi's native tool rendering; activity tracking remains independently configurable. Choose a different theme through Pi's `/theme` menu.

## Activity controls

To collapse `Agent` launches and `get_subagent_result` behind diamonds, load the optional `integrations/subagents.ts` entrypoint instead of the npm package's direct entrypoint. It loads the globally installed `npm:@tintinweb/pi-subagents` and decorates only those tools' rendering; execution, waiting, cancellation, and notification consumption remain owned by Pi Subagents. In Pi settings, keep its package installed with `{"source":"npm:@tintinweb/pi-subagents","extensions":[]}` and add `/path/to/grok-style-pi/integrations/subagents.ts` to `extensions`. Do not also enable the original entrypoint. Run `/reload`. Collapsed rows read `◆ Explore: <description>` and `◆ Read agent result <id>`; Ctrl+O expands the full output. Disabling `toolStyling` restores the original result display through the same wrapper.


The activity bar reserves space above the composer when a shell tool or subagent runs. It does not cover the transcript or register a persistent overlay. Click **View** to follow its live output, **Stop** to cancel that specific run, or **Close** on the right to dismiss any entry. Closing a running entry hides it without stopping it; it remains accessible through `/activity`. Stopping a shell tool preserves the parent turn and other concurrent tools. Separate **Active subagents** and **Active tasks** sections show up to three entries each. Finished, failed, and stopped entries disappear automatically; empty sections take no space. Click a section heading or use `/activity` to inspect retained history.

The centered viewer has a full border and a top-right **Close** button. In the viewer, use **↑/↓**, **Page Up/Down**, and the mouse wheel to scroll; **End** resumes following new output. **x** stops a running entry and **Esc** closes the viewer. Recent finished runs stay available until dismissed (up to twelve).

Subagent integration uses the documented event bus and manager registry from `@tintinweb/pi-subagents`, when installed. It follows top-level agents started while this extension is active, including foreground resumes of retained agents (detected within the 500 ms refresh interval). Finished runs are also checked for timestamp changes so fast resumes refresh their results. Foreground resumes use session cancellation for Stop; the control is omitted when that capability is unavailable. The viewer includes streamed tool output, tracked separately for concurrent calls. Nested and workflow-owned agents remain managed by their owning extension and its `/agents` viewer. To avoid duplicate agent panels, turn off its Widget and Fleet view in `/agents → Settings`.

## Tests

```bash
npm test
```

Requires Node 22+ (type stripping) and `@earendil-works/pi-coding-agent` for the factory/consumer tests (`npm install`).

## Subagent integration contracts

`src/subagent-adapter.ts` owns subagent observation, run identity, subscriptions, and cancellation. The activity UI consumes its projections; it does not interpret registry state or choose cancellation mechanisms. Each detected run gets an immutable identity, and callbacks from replaced or disposed runs cannot operate on the current run.

Lifecycle events discover agents. Registry polling reconciles foreground resumes, including those that finish between polls. Run boundaries use start timestamps and, for same-timestamp completed resumes, the session's latest user message. This is a view of the latest observed run, not an exhaustive history of runs that occur between polls. Completed entries are bounded to twelve; each stores a cached snapshot of at most 64,000 characters and releases its child session. Polling unchanged completions does not rebuild transcripts. The upstream `steered` status is treated as terminal. Live session cancellation is preferred for running agents; the documented RPC is used for queues and initial runs without session cancellation. Resumes without cancellation support do not offer Stop.

The default `npm test` first runs strict type checks for every production source and the subagent contract tests, then runs the test suite. Use `npm run typecheck` to run those checks alone. `npm run test:subagents` exercises pinned Pi Subagents 0.19.0 with a real manager, resume runner, and Pi `AgentSession`. A local model transport supplies responses and failures; network access is blocked. Tests seed an existing manager record rather than exercising spawn discovery. They cover rapid success/failure, actual request cancellation, parent-signal isolation, stale Stop callbacks, same-millisecond resumes, and disposal. The subagent package is a development dependency only; users can still run the extension without it installed.

### Jev intervention diamonds

Optional `integrations/warden.ts` and `integrations/jev-discovery.ts` entrypoints show Warden steering/status messages and Discovery's injected guidance/source evidence as collapsed diamonds. Click the header or use Ctrl+O to read the full message; clicking expanded output collapses its diamond. The Discovery wrapper also styles `jev_discover` and `jev_advisory_assess`. Intervention contents, tool execution, and turn delivery are preserved; checks that produce no message do not create a row.

Replace the direct extension entrypoints rather than loading both. Keep `npm:pi-warden` installed with `"extensions": []` in its package settings, and add this package's `integrations/warden.ts` to Pi's `extensions` list. Replace the Discovery extension path with `integrations/jev-discovery.ts`; it defaults to the sibling `pi-jev-discovery-delegated/delegated-extension.mjs` checkout, or accepts an absolute path through `GROK_JEV_DISCOVERY_EXTENSION`. These wrappers follow the `toolStyling` feature setting.

Run `/reload` after configuration changes. New intervention messages are saved as visible; previously saved hidden messages are not rewritten or replayed.
