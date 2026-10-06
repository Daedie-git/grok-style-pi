# herdr-subagents

A standalone [Pi](https://pi.dev) plugin for running Pi and Claude Code subagents in [Herdr](https://herdr.dev) panes. It does not install a theme, change the composer or footer, or require Grok styling or Pi Subagents.

## Install

From this checkout:

```bash
pi install /path/to/grok-style-pi/packages/herdr-subagents
```

Install it in Pi's user settings on every machine where children run, so new Pi processes load it too. Run `/reload` in existing sessions. The standalone entrypoint activates only inside Herdr (`HERDR_ENV=1`); outside Herdr it registers nothing.

The directory is a complete Pi package with its own manifest, dependencies, entrypoint, and license. It can be copied out of this repository, installed with `pi install /path/to/herdr-subagents`, or packed with `npm pack` from this directory. It is not yet published to npm.

Requirements: Herdr, Pi with model credentials, and Node **22.18+ on the 22.x line, or Node 24+**. Local clone users run `npm install` before loading the package.

### With Grok styling

Grok's existing `integrations/subagents.ts` entrypoint imports this runner and decorates its tool rendering. Continue using that entrypoint for the existing combined setup; no settings migration is required. It still selects Pi Subagents outside Herdr.

Load exactly one runner. Do not also enable this package's standalone extension while the Grok integration is enabled. If keeping this package installed alongside the integration, disable its automatic extension with `{"source":"/path/to/herdr-subagents","extensions":[]}`. Alternatively, use this plugin with Grok's direct `extensions/index.ts` entrypoint for Grok chrome but native subagent tool rendering.

The Grok activity panel continues tracking shell commands and in-process Pi Subagents, not the Herdr pane runner.

## Tools

- `Agent` starts a separate Pi process in a Herdr pane. It defaults to background execution; `run_in_background: false` waits for completion or a blocked child.
- `get_subagent_result` reads a captured run's status and result. `wait: true` waits until it finishes or blocks; optional `run_id` retrieves an earlier retained run.
- `steer_subagent` sends a message to a running Pi child after its current tool execution.

The tools retain their existing names and parameter schemas. Agent instructions require an explicit user request before spawning. Reuse the same agent for follow-up work: steer while running, or pass its ID as `Agent.resume` after completion. A resume creates a distinct run with its own result and completion notice. Reading an earlier run cannot suppress a later notice.

A `.pi/agents/<subagent_type>.md` file, or the same file under Pi's user agent directory, supplies the child prompt and tool allow-list. Model and thinking overrides remain supported. `isolated: true` restricts the child to built-in tools; `max_turns` bounds a Pi child's turns. Keep `inherit_context` false and provide context in the task prompt. Scheduling and worktree isolation are not offered.

Results include stable agent IDs and immutable run IDs. Tool output is limited to 2,000 lines or 50 KB; the full conversation remains in the pane. Blocked children return immediately and leave their panes open for you to answer. Finished panes also stay open. Cancelling a tool requests cancellation of its captured run and reports pending cancellation until the child acknowledges it.

## Pane placement

Children first fill the caller's tab up to four physical panes, including the parent. From a single-pane tab, the first three children share that tab; the fourth opens another tab. The first split is rightward, followed by downward splits in each column to form a balanced 2×2 layout. Later spawns fill available managed tabs in the same Herdr workspace before opening another.

Occupancy includes unrelated panes and shells left behind by exited children. After a pane closes, the runner splits the shorter known column. For an unknown caller layout, it splits the caller's pane downward while respecting the cap. Other managed tabs containing an unknown pane or only one stacked column are not refilled. Unknown occupancy, or a caller without `HERDR_WORKSPACE_ID`, opens a new tab. Unrelated Herdr clients can still exceed the cap.

Sidebar names drop a leading `herdr-` and append the model and reasoning level, for example `review · gpt-6-astra-xhigh`.

## Claude Code

When explicitly requested, `Agent` accepts `runtime: "claude-code"`; Pi remains the default. It opens a native interactive `claude` instance using the same placement rules. Claude Code must be installed, authenticated, and have the project trusted. No permission bypass is enabled. Startup failures clean up the owned pane. Tool-approval requests return `blocked`; answer in the pane and read the result again.

Tasks are submitted with `herdr agent prompt`. Per-session Claude command hooks report acceptance, permission requests, API failures, and the final response through the coordination database. Submission receipt alone does not count as execution; tool hooks or the final response confirm it. A hook command is never blindly submitted again after an uncertain outcome. If another hook rejects input, an unconfirmed run fails after a bounded five-minute window. Permission requests stay blocked until their matching tool completes; the settled tool-batch hook clears denied requests and identity-free permission notifications.

- `model` uses Claude names such as `sonnet` or `opus`, not Pi provider/model IDs. `thinking` maps to `--effort`: `low`, `medium`, `high`, `xhigh`, or `max`, subject to model support.
- Agent-file prompts and tool lists carry over; `find` and `ls` map to `Glob`. Lists restrict tool availability, not permission approval, and disable extra MCP tools and slash commands.
- `resume` reuses the same Claude conversation without changing runtimes. Live steering, interactive `max_turns`, and context inheritance are unsupported.
- Cancellation closes the owned pane and confirms closure before reporting `stopped`; a cancelled Claude instance cannot resume.
- Only local Linux/macOS panes are supported. Remote machines and Windows are rejected before pane creation. Keep the parent Pi session open for follow-ups and cancellation.

Existing user/project hooks remain active. Avoid Stop hooks that continue a response after this runner records its result. Manually interrupting Claude without closing its pane does not emit a Stop hook; close the pane or cancel through the runner to settle the run.

The bridge uses documented [Claude command hooks](https://code.claude.com/docs/en/hooks): `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolBatch`, `Stop`, `StopFailure`, and `SessionEnd`. It uses Stop's `last_assistant_message`, not potentially lagging transcript files. Claude Code 2.1.285 is the development reference; older versions without these hooks cannot reliably report results.

## Remote machines

`Agent.machine` selects a [saved Herdr SSH machine](https://herdr.dev/docs/connecting-machines/) label or profile ID, only when the user asks. Enabled machines and SSH targets appear in the tool description; repeated labels use profile IDs. Run `/reload` after adding a machine. Remote IDs end in `@<machine>`, such as `explore@laptop`, and subsequent result, steering, and cancellation calls route by that suffix.

`machine_cwd` sets an absolute directory on that machine. It defaults to the parent's path, so set it when layouts differ; Windows accepts paths such as `C:/git/project`. The directory is checked before opening a pane. Missing-directory errors list directories open in that machine's Herdr panes. The runner reuses a remote workspace already open in the directory, if one exists, and uses the same grid placement there. The local caller tab is never used.

Agent definitions are read locally and sent with the task. Remote context inheritance is rejected. A remote child may start its own children there; their depth starts at 1 again.

Requirements:

- Herdr 0.9.1+ on both machines, with the machine added using `herdr machine add <ssh-target>`.
- Pi, Node 22.18+ or 24+, model credentials, and this runner loaded on the remote machine, either standalone or through Grok's integration.
- Matching remote protocols. A handshake refuses mismatches before launching or changing the store and identifies which side to update.

The parent reaches the remote database through one persistent `ssh <target> node …/worker-entry.mjs` process per machine, exchanging JSON lines over stdio. It uses `BatchMode=yes`, so passphrase-protected keys must already be loaded in your agent. A silent channel is detected within about 45 seconds; reconnects run every ten seconds. Channel closure retires its launch owners for recovery, including after parent crashes. Reconnects also retire owners from silently dropped channels. Each machine polls independently, so an unavailable machine does not stall local coordination or another machine. Used machines are saved in the Pi session and reopened after `/reload` for pending notices.

### Configuration compatibility

The standalone plugin defaults to the same absolute worker path on the remote machine. Grok's adapter preserves its previous default `<Grok root>/src/herdr/worker-entry.mjs` path, so existing combined remote setups need no configuration changes. When installations differ, set:

- `HERDR_SUBAGENTS_REMOTE_PACKAGE` to the standalone package root on the remote machines.
- `HERDR_SUBAGENTS_REMOTE_NODE` to the remote Node executable if it is not on non-interactive SSH's `PATH`.

Both apply to every machine. The old `GROK_HERDR_REMOTE_PACKAGE` and `GROK_HERDR_REMOTE_NODE` variables remain supported; the new names take precedence. The old package variable names a Grok package root, whose `src/herdr/worker-entry.mjs` forwards to the extracted runner. Update the package-root override if moving a remote machine from Grok to a standalone installation.

## Coordination and upgrades

The extraction preserves protocol versions, database formats, session entry names, Claude hook markers, and the state root: `$XDG_STATE_HOME/grok-style-pi/herdr-subagents`, defaulting to `~/.local/state/grok-style-pi/herdr-subagents`. The legacy directory name is intentional; existing agents and retained results remain usable. Grok also retains `src/herdr/claude-hook-entry.mjs` as a forwarding entry for hook commands saved in already-open Claude conversations. This packaging change does not require a database migration or deleting state. Keep the original Grok checkout in place while existing Claude panes still reference its hook entry.

`control.sqlite` stores agents, immutable runs, commands, launches, and notification receipts. `placement.sqlite` provides a separate cross-process write lock; process death releases it without timestamp-based takeover. SQLite and lock contention run in a `jiti`-loaded worker, including npm installations. Experimental SQLite and Undici startup notices are suppressed only in that worker. Other diagnostics and host warnings remain visible. Database errors include `[herdr-db]`, operation, SQLite codes, Node version, process ID, and worker thread ID, but not task contents. No coordinator daemon is required.

Commands and notices poll every 200 ms. Batched Herdr liveness listings run roughly once per second, shared through a short database lease. A stalled owner may be replaced after five seconds; late replies cannot update runs after takeover. Unknown or failed listings do not prove pane death. A reported session decides whether an agent name is still the subagent, including after a pane move; without one, only the recorded pane counts, and a name elsewhere is neither alive nor dead, so resume, steering, and Claude cancellation refuse it. Claude prompts and cancellation target the verified pane, not the name. Slow listings do not delay child commands or cancellation.

Launch intent is saved before opening a pane. Pre-launch shell-readiness rejections are retried for up to 60 seconds, with cancellation support; other startup failures are not automatically retried. Cancellation before publication closes the owned pane. Uncertain pane creation and failed cleanup retain reservations and diagnostics rather than claiming success. Another runner reconciles abandoned known panes; uncertain creation requires inspecting Herdr.

Children attach using both pane and Pi session identity. A new conversation in the same pane does not inherit another child's restrictions. Reload reconstructs queued commands and execution. An uncertain dispatch is interrupted, never blindly replayed; saved execution checkpoints may repair interrupted database writes.

Completion notices have stable run-scoped IDs. Queueing is not delivery: a receipt is stored only after Pi saves the message. Reload retries unacknowledged delivery. SQLite and Pi session files do not form one atomic transaction, so a crash may produce a duplicate with the same notice ID.

Protocol 2 remains incompatible with the older per-agent-file coordinator. Finish or stop legacy runs and close or reload every legacy Pi process before using this runner. Do not run old and new coordinators together. Legacy results remain untouched, but those agents cannot resume. Close a crashed legacy process before archiving its per-agent state directory and obsolete `panes/` index; never delete control files used by a live runner.

## Development

```bash
npm install
npm test
```

The package's strict typecheck and runner tests are independent of Grok sources. Tests use real SQLite workers and separate processes for concurrency, cancellation, reload, launch recovery, SSH transport, and notification delivery; Herdr pane operations are mocked. Grok's root `npm test` also runs these tests and checks the styling adapter. No live model requests are needed.

For embedding, the package exports `createHerdrSubagents(overrides?)`, a Pi extension factory with injectable runner dependencies. A caller may decorate tool registration without changing execution. Load the standalone entrypoint or embed the factory once per Pi session.
