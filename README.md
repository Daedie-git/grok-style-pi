# grok-style-pi

Grok Build-inspired chrome for [Pi](https://pi.dev): a GrokNight color theme, a `cwd │ model │ Context N% used` footer, a rounded composer with a `❯` prompt, and diamond (`◆`) tool rows.

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
| Theme | Neutral near-black gray + magenta `#bb9af7` (GrokNight) |
| Footer | One row: full working path (`~` for home) with the active Git branch, model, thinking level, context usage, and ChatGPT/Codex subscription usage |
| Composer | Rounded frame and `❯` prompt; muted idle border, brighter focused border |
| Tools | Dim diamond summaries for shell commands (using their description when supplied), with readable file-tool labels; expand for indented output and edit diffs |
| Activity | Live Bash/PowerShell commands and top-level subagents above the composer, with clickable View, Stop, and Close controls |

Built-in tools (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) use Pi’s full `create*ToolDefinition` factories, preserving built-in prompt guidance and execution. Disabling tool styling restores their native renderers. Styled tool text is sanitized before theme colors are applied.

Pi still controls transcript spacing and message layout, so this is an approximation of Grok Build rather than a complete replacement of Pi’s interface.

For `openai-codex`, the footer shows weekly quota remaining (for example, `Codex weekly 46% left`). It refreshes in the background at startup and once per minute using the existing Pi ChatGPT login and Codex's usage endpoint. Response headers also update the display when available. This works with WebSocket transport and makes no model requests. Refresh stops when the footer is disabled, the model changes away from Codex, or the session closes. Unavailable or expired data is not shown as a known percentage; authentication failures display `login required`. The usage endpoint is an internal Codex service and may change.

## Feature settings

Use `/grok-style` to toggle the footer, composer frame, tool styling, activity panel, and terminal colors independently. Choices are saved in `~/.pi/agent/grok-style.json` (or your configured Pi agent directory). Run `/reload` after changing them. All features default to on.

You can also use `/grok-style activity off`, `/grok-style terminalColors off`, or `/grok-style all off` (replace `off` with `on` to enable). The available keys are `footer`, `composer`, `toolStyling`, `activity`, and `terminalColors`. Disabling tool styling restores Pi's native tool rendering; activity tracking remains independently configurable. Choose a different theme through Pi's `/theme` menu.

## Activity controls


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
