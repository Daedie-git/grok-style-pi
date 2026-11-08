# Claude Sidecar

A Claude Code plugin that runs persistent [pi](https://github.com/badlogic/pi-mono) or Claude Code sidecar agents on demand in Herdr panes. The reviewer remembers notes and earlier reviews, reviews plans and diffs, and returns Markdown reports to Claude.

The default backend is pi with `openai-codex/gpt-6.1-sol` and `high` thinking.

## Requirements

- Linux with Bash, Git, jq, and util-linux (`flock`), or Windows with Git Bash, Node.js, jq, and a Git-Bash-compatible `flock` on `PATH`.
- Claude Code with plugin support.
- Herdr with `pane` and `agent` commands on `PATH`; start interactive Claude inside a Herdr pane.
- The selected agent CLI on `PATH`, authenticated: pi (`@earendil-works/pi-coding-agent`) or Claude Code with access to the selected model.
- To run sidecars on another machine: see [Sidecars on another machine](#sidecars-on-another-machine).

The plugin does not install these dependencies. Session startup only publishes identity and usage guidance; the first task starts its sidecar. The hook skips setup outside Herdr, in headless `claude -p` sessions, or when launcher dependencies are missing.

## Develop locally

```bash
cd /home/aim/git/claude-sidecar
claude --plugin-dir "$PWD"
```

The plugin exposes `/claude-sidecar:sidecar-review` and a `SessionStart` hook. Restart Claude after changing plugin files. Runtime requests, reports, logs, locks, and session markers stay in `~/.cache/claude-sidecar`, outside the plugin checkout.

```bash
python3 tests/run.py
shellcheck scripts/sidecar
claude plugin validate .claude-plugin/plugin.json
claude plugin validate .claude-plugin/marketplace.json
```

Tests use a fake Herdr and isolated home directories; they never start a real model session. Optional runtime checks use `SIDECAR_TEST_PI=/absolute/path/to/pi PYTHONPATH=tests python3 -m unittest test_profile_runtime` (point at the actual executable, not a personal wrapper). They inspect active tools, selected skills, reload commands, and a fixture MCP server through isolated RPC extension commands without making model calls; the ordinary harness skips these checks.

## Windows hosts

Windows pi sidecars use an in-process file channel instead of Herdr terminal prompt submission and agent-status detection. Herdr on Windows can report a working pi as idle and leave submitted text in the editor. The extension accepts requests directly, records delivery, and reports final settlement (including retries and compaction); the launcher waits for the report while retaining the slot lock. Busy steering uses this same channel and does not create another request. Linux sidecars keep their existing transport.

The launcher verifies the native pi PID and `--session-id` through Herdr's `pane process-info`, then matches the extension's live owner record. It never trusts an agent name alone. Windows pi startup waits for that receiver and its matching heartbeat before reporting success or sending a request: Herdr can detect Pi before asynchronous startup handlers finish. `SIDECAR_STARTUP_TIMEOUT_S` (default 300) bounds this wait; expiry sends nothing and leaves the pane available for inspection or retry. A live foreign owner or an exited pi fails immediately. Status probes remain non-blocking. Native jq's CRLF output is normalized. Requests use native Windows paths. Remote Windows pi slots use this adaptation with the Node transport too.

An aborted turn can discard a message that Windows pi accepted but had not yet delivered. Its waiter exits 6 (delivery unconfirmed; inspect the pane before resending), and that message no longer keeps the slot busy. Cancelling the launcher stops its local waiting client and releases the slot lock; it does not abort the sidecar's model turn. A fully published report takes precedence over a subsequent runtime shutdown or reload.

After updating, run `sidecar --slot N reload` as a harness background task for each existing Windows pi sidecar. For the first upgrade from an older extension, run it once the sidecar is idle: that one bootstrap still uses Herdr and may time out if work is active. Subsequent reloads wait through the native channel for the current operation to become idle, then start the confirmation deadline; they do not interrupt work. New sidecars load the channel automatically. If reload cannot be confirmed, inspect the pane before retrying. Claude Code sidecars still use Herdr's terminal transport; this adaptation targets pi.

## Claude Code agents

`sidecar --slot N --agent claude ask ...` starts a persistent Claude Code agent in a Herdr pane instead of pi. It uses `--session-id` on first start and `--resume` afterwards, `--effort` from the slot's role, and `SIDECAR_CLAUDE_MODEL` (default `opus` for reviewers, `sonnet` for the other roles). The agent has no `submit_review` tool: requests tell it to write the report (and `.needs-answer` question) under `~/.cache/claude-sidecar/reports`, so exit codes 0 to 5 behave as for pi. With `--machine`, the agent runs in that machine's Herdr like a remote pi, and Claude Code there must be logged in. Limits: `reload` and busy-path `steer` are pi-only. The permission mode comes from the machine's Claude settings, so an approval prompt shows as exit 5; `SIDECAR_CLAUDE_PERMISSION_MODE` (for example `bypassPermissions`) passes `--permission-mode` at start. The `SessionStart` hook skips sessions named `claude-sidecar`, so these agents never start sidecars.

Add `--machine NAME` to launch on a saved Herdr machine. On Windows, the launcher disables Git Bash path conversion only for remote Herdr invocations, so Linux paths reach the target unchanged; local Herdr path handling and Linux launchers are unchanged.

## Band above the prompt

A function-hooks module (`hooks/band.tsx`) draws a band above Claude Code's prompt with one row per slot of this pane, coloured by role (reviewers red, implementers blue, researchers green, explorers yellow), that is running a request or waiting on an answer: slot, role, backend, machine, request kind and elapsed time. It reads the launcher's state in `~/.cache/claude-sidecar` every 3 seconds and needs a Claude Code version with function hooks. `claude plugin test .` runs its tests in `tests/band/`.

## Blocked questions

A sidecar that cannot continue without a decision submits its report with `needs_answer`. After the first-line report path, the launcher prints `NEEDS_ANSWER: <question>` and exits 3; `sidecar answer TEXT` resumes the same task. Identical requests sent while one is in flight exit 4 instead of queueing. Requests have no deadline; a turn that ends without a report exits 2, and a sidecar blocked in its pane exits 5. A running sidecar loads the extension at start, so restart it (new Herdr pane or `sidecar restart` after ending the old pi) to gain `needs_answer`.

## Reload without interrupting work

`sidecar [--slot N] reload` waits for the current request to return its report, then for Pi to become idle. It keeps the same process, session, pending-question marker and request/report files; the original `ask` finishes through its original channel. It uses the documented `/sidecar-reload` extension command (`waitForIdle()`, then `reload()`), with a file receipt written only by the fresh runtime. An older extension is bootstrapped through Pi's built-in `/reload` after the same request/idle guard. No pane keys or model prompt are sent. Node remote slots deploy the reload helper along with the runtime files.

Run it in the background like a request. Exit 0 confirms the fresh runtime; exit 1 means it was refused or not confirmed. `SIDECAR_RELOAD_TIMEOUT_S` (default 30) bounds confirmation **after** the request has finished, not the active task. On timeout, inspect the pane before retrying; reload might have started. A foreign or blocked session is not reloaded. This loads Pi's reloadable resources, not a new Pi executable or changed startup flags. The command never interrupts work to make a hung request finish.

## Pane lifecycle

A local pane closes as soon as its request delivers a report (exit 0), like a finished Claude subagent, and when its owning Claude pane disappears. Closing keeps the session, so the next request resumes the conversation in a new pane. A pane stays open while it has a question pending, after a request without a report, and while the user has it focused when the report arrives. `ask --keep TEXT` or `sidecar [--slot N] keep` pins a pane open after its report; use this only while the user watches it. `unkeep` removes the pin and closes the pane if its last report was delivered; a missing owner closes a pinned pane too. `SIDECAR_CLOSE_WHEN_DONE=0` keeps every pane open after its report.

After the report, a detached check waits for the launcher to release the slot and for the agent to settle (up to 2 minutes), then closes the pane unless a newer request took the slot. Remote slots stay open; stop them explicitly. `sidecar sweep` closes local slots whose owner is gone, using one pane list and non-blocking locks. Launcher commands and the Bash hook schedule it in the background at most once per minute, logging to `~/.cache/claude-sidecar/sweep.log`. SessionEnd marks the registered owning Claude session ended and sweeps its local slots unless the reason is `clear`. Busy, blocked, pending and focused slots stay open then; later sweeps reclaim them once they become idle. Nested, headless or unidentified Claude sessions leave the owner's slots alone.

`sidecar [--slot N] stop` closes the slot's pane after checking that it runs the sidecar's own session; a pane another agent took over is left running. The session, role, agent and machine binding are kept, so the next request resumes the conversation in a new pane, and `status` shows `stopped` meanwhile. It refuses with exit 7 while a request holds the slot; `--force` stops anyway, ending that request without a report. `--fresh` also removes the pin and saved pi or Claude session, so the next start begins a new one. `--all` stops every slot of the calling Claude pane. A slot on a machine is stopped there.

## Steering a sidecar

On Windows pi sidecars, busy steering uses the verified native channel described in [Windows hosts](#windows-hosts), without the grok-style-pi dependency. The inbox details in this section apply to Linux sidecars.

If the slot is idle and its request lock is free, `steer TEXT` behaves like `ask TEXT`: it creates a request, waits without a deadline, and prints the submitted report. No steering extension is needed for this path. Its exit codes are the request codes: 0 report, 1 failure, 2 no report, 3 decision needed, 4 duplicate in flight, 5 approval blocked. A missing sidecar still needs `ask` or `start` first. If a request already owns the slot, steering stays on the busy path even during gaps between its turns.

`sidecar [--slot N] [--machine NAME] steer TEXT` delivers a message to the running sidecar immediately, even while a long `ask` holds the slot. It writes the message into the pi session's steering inbox (`<state>/grok-style-pi/steer/<pi session id>/`, from the [grok-style-pi](https://github.com/Daedie-git/grok-style-pi) extension, which must be loaded in the sidecar's pi) and waits up to `SIDECAR_STEER_TIMEOUT_S` seconds (default 8) for that extension to acknowledge it. pi shows it as a user message, mid-turn when the sidecar is working or as a normal prompt when idle. The text travels on stdin, so any length works, including through a Windows `cmd.exe` SSH shell. Before publishing, it checks that the inbox's owner record names the session file Herdr reports for the targeted agent (and that the owning process is alive), so another pi that reuses the session id is never addressed; if Herdr has not published the session file, the command says so and sends nothing. The message names the verified owner instance, so a different instance that takes over the inbox rejects it (exit 1, "owner changed"). Herdr exposes no pid for an agent, so two pi processes on the very same session file are indistinguishable. Exit 0 means the message entered the sidecar's conversation, or pi queued it behind the running turn but it was not yet seen in the conversation (the output says `queued (not yet confirmed in conversation)`, and a later input handler could still consume it); 1 refused, unverifiable target or failure; 4 not picked up and withdrawn (safe to resend); 6 outcome unknown (pi never confirmed it, for example during compaction), so it may still arrive. After a 15 s hold on earlier unconfirmed messages, an unconfirmed idle prompt may race, be dropped, or run out of order relative to later steers. The busy path never waits for a slot lock. For a slot on a machine it runs over the same SSH connection as other commands, using the machine's Node. A pi that started before the extension was updated needs `/reload` in its pane (or a restart).

## Install from GitHub

This repository includes a single-plugin marketplace. In Claude Code:

```text
/plugin marketplace add Daedie-git/claude-sidecar
/plugin install claude-sidecar@daedie-sidecar
```

A private repository requires GitHub access on the installing machine. Restart Claude inside Herdr after installation.

## Migrate the existing integration

Before enabling this plugin, remove the old SessionStart hook that invokes `~/.claude/bin/sidecar session-start` from your Claude settings, and move `~/.claude/skills/sidecar-review` outside the skills directory. Otherwise both integrations may launch and Claude may choose the old skill. Keep the old files as backups until a real plugin review succeeds. The plugin reuses the existing runtime cache and live reviewer where possible.

The plugin source sets the new model default. An already-running sidecar retains its model; `sidecar stop` it, and the next request starts it with the new default. `restart` only replaces a pane running the wrong pi session; it does not force model changes on a matching live session.

## Use the launcher directly

**Notification safety:** run every `ask`, `diff`, `answer` and `steer` as a harness background task (`run_in_background: true` in Claude Code's Bash tool), including idle steering and follow-ups. Do the same for `plan`, `wait` and `reload`. Keep the launcher attached to that task so its completion notification reaches the orchestrator. Shell detachment (`&`, `disown`, `nohup`, `setsid`, or `( … & )`) does **not** produce a harness completion notification; a pane finishing does not wake Claude. Do not discard the task's output or assume a submitted request is finished.

```bash
./scripts/sidecar status
./scripts/sidecar note "The user approved the plan in docs/plan.md."
./scripts/sidecar plan docs/plan.md "Goals and constraints"
./scripts/sidecar diff HEAD "Intent of the implementation"
./scripts/sidecar coop-review HEAD "Intent of the implementation"
./scripts/sidecar unreviewed
./scripts/sidecar ask "Recheck finding 2 after the fix."
./scripts/sidecar reject "#3 (stale handle): the handle is regenerated in reset()"
./scripts/sidecar --slot 5 --role implementer ask --accept "timeout 600 make smoke" --scope 'src/parser/*' "Implement X."
./scripts/sidecar --slot 2 ask "Review the parser independently."
./scripts/sidecar --slot 3 ask "Review lifecycle handling independently."
./scripts/sidecar --slot 2 answer "Yes, keep backward compatibility."
./scripts/sidecar --slot 4 --machine laptop ask "Run the suite on the laptop."
./scripts/sidecar --slot 2 wait     # blocking watcher; run as a harness background task
./scripts/sidecar --slot 2 report   # recover the latest full report
```

### Cooperative review

`sidecar coop-review [--pi-slot N] [--claude-slot M] [BASE] [CONTEXT]` has two persistent reviewers review the same change: a pi reviewer and a Claude Code reviewer (`--agent claude`, Opus). They use dedicated slots, 98 and 99 by default, so the review never queues behind or mixes context with everyday slots; the flags choose others. A coop-review reserves both slots for its whole run, so a second one on the same slots, or any slot busy with another request, fails at once instead of queueing; its reviewer requests fail fast too if something else takes a slot mid-run. It runs `diff BASE CONTEXT` on both in parallel and asks each reviewer to number its findings (`### N. Title`). The launcher inventories them as `P1..` (pi) and `C1..` (Claude Code), then sends each reviewer the other's report and IDs to check without re-reviewing: every finding is marked confirmed (with evidence) or rejected (with a reason) by ID, and a reviewer may withdraw its own wrong findings.

The launcher prints one combined report, saved like any other, with the usual `# Sidecar report (<path>)` first line. Every inventoried finding appears in exactly one section: **Confirmed by both**, **Rejected by both** (rejected by the peer and withdrawn by its author), or **Disputed** (each side's argument; also unchecked, unverified, duplicated or lone-withdrawn findings). Each finding names its origin, and the four underlying reports are linked. Fenced code in a report is never read as headings or verdicts. Check entries that match no finding (an unknown ID, or an ID whose title names a different finding), and reports with no extractable findings, are listed under Warnings and never shown as findings. The command settles nothing; the caller decides disputes and fixes.

Slots keep their agent and memory, so a later round on the fixes is another `coop-review` call with the same slots. A slot already bound to the other agent, role or machine fails; pick other slots with the flags. `--machine` and `--remote-cwd` go before the command and apply to both reviewers. `--slot`, `--agent` and `--role` are rejected. A reviewer's question exits 3 and names its slot; answer with `sidecar --slot N answer TEXT`, then run `coop-review` again. Any other failure exits with the first reviewer's code. Reviewer launchers write to files, not the caller's pipes, and their progress is relayed with a `[pi slot N]` or `[claude slot M]` prefix. Cancelling coop-review (exit 130 or 143) signals nothing: it saves and prints an "interrupted" report and releases its reservations. The detached launchers finish their own requests, and the reviewers' turns continue in their panes; a new coop-review on the same slots fails fast as busy until they finish. The cost is about three single reviews: two reviews and two checks, two at a time. `sidecar ask -` reads the request text from stdin.

### Implementer checks

Implementer asks append a completion contract: a `Status: done|partial|blocked` first line, verification through the real entry point, and `Verified`, `Not verified`, `Files changed` and `Suggested follow-ups` sections. `ask --accept CMD` (repeatable) runs CMD with `bash -c` in the ask's directory after the report arrives, with a `SIDECAR_ACCEPT_TIMEOUT_S` limit (default 1800); `--scope GLOB` (repeatable) lists files the task changed outside the globs. Changed files are those whose content differs from the state recorded at the ask, so files already dirty then count only if they change again. The results lead the saved report under `## Launcher checks`, with full logs next to it. Checks persist on the slot for answers, steers and later asks until replaced or cleared with `--no-checks`. Slots on another machine do not support them.

### Rejected findings

`sidecar reject TEXT` records a rejection as `R<n>` for the slot and sends it to the reviewer, which re-checks and starts its report with `R<n>: withdrawn` (with the evidence that convinced it) or `R<n>: stands` (with a reproduction). The launcher reads these verdicts from any later report on the slot. Every later `diff` request lists the rejections that are open or standing, and the reviewer re-checks them. `reject --overrule R<n> REASON` closes one against the reviewer. The ledger is `~/.cache/claude-sidecar/<agent>.rejections.jsonl`.

### Push gate

The plugin's PreToolUse hook runs `scripts/push-gate` for every Bash call. A recent cleanup timestamp takes a builtin-only fast path. It starts `sidecar push-gate` only for commands that could publish. Inside Herdr, it denies `git push`, `gh pr create` and `glab mr create` when the repository has a recorded diff review from any slot of this Claude pane and `unreviewed` against the newest record finds changed files. Repositories without a record pass. A command containing `SIDECAR_REVIEW_SKIP=<why>` passes.

### Completion and report recovery

Every request prints `# Sidecar report (<local path>)` as its **first stdout line**, before starting or waiting for the agent. The full Markdown report is saved at that path, independently of stdout truncation by `head`, `tail`, or the harness. For remote slots, the launcher copies the full report locally before printing its contents; `report` works even when SSH is unavailable. The path is reserved at submission and the file exists only after a report is submitted (and, remotely, copied successfully).

`sidecar --slot N status` shows when the latest request started and finished, its exit code, and the last saved report path with `printed` or `unprinted`. `printed` means the launcher successfully wrote the full report to stdout, **not** that Claude or a person read it; redirected output can still be marked printed. An interrupted launcher may have no recorded finish time.

If a request was already launched without an observable harness task, start `sidecar --slot N wait` with `run_in_background: true`. It blocks on that slot's launcher lock until the active request has finished, then prints its local report path without consuming the report. Exit 0 means report available; exit 3 means a question needs an answer; exit 1 means no request/report or an abnormal launcher exit (inspect the pane). It observes the latest request when it acquires the lock, not future requests or work started directly in the pane. Then run `sidecar --slot N report` to print the latest saved report in full, including any question. `report` exits 0 on successful printing; the original question remains pending until `answer`. These recovery commands use local state and do not start an agent.

Commands run against the current working directory. `diff` takes a **single base ref**, not an `A..B` or `A...B` range. The diff review includes commits since the base, working-tree changes, and untracked files. Requests serialize per slot, while different slots can work concurrently. Slot 1 is the default; each slot retains its own context and pending questions across follow-ups and `/clear`. Sidecars fill Claude's current tab up to four total panes, counting every pane open in it, including Claude's and other Claude panes' sidecars. Each new sidecar halves the largest pane: first left/right, then top/bottom in each column. A full tab sends further sidecars to overflow tabs of up to four panes each; closing a pane frees its room. Reuse slots for later tasks. A blocked reviewer needs human attention in its pane.

Pi and Claude Code reviewers default to high reasoning; implementers, explorers and researchers default to medium. An explorer (`--role explorer`) finds code and explains how it connects; a researcher (`--role researcher`) answers from primary sources. Both work read-only. Select `--role implementer` on a fresh slot for implementation work:

```bash
./scripts/sidecar --slot 3 --role implementer ask "Implement the parser fix in this checkout."
```

The slot remembers its role for follow-ups, including on remote machines. Omitted roles default to `reviewer`; changing a bound role requires a new slot. Already-running sidecars retain their startup reasoning level.

Override pi's model and either role's reasoning level in the environment before starting Claude or the launcher (`SIDECAR_THINKING` also applies to Claude Code):

```bash
export SIDECAR_MODEL=openai-codex/gpt-6.1-sol
export SIDECAR_THINKING=high
```

## Fleet role profiles

`sidecar --slot N --agent pi --profile-file FILE ask TEXT` accepts a fully resolved Fleet profile. Fleet retains configuration authority; sidecar does not look up role names or expand policy. The JSON has exactly these fields:

```json
{"version":1,"role":"implementer","prompt":"Implement only the assigned change.","allow":null,"deny":[],"skills":[],"mcp":false}
```

`prompt` is literal text, not a filename. The launcher materializes it and appends it last, after a permission-neutral request/report protocol, instead of the generic reviewer prompt. `allow: null` preserves Pi's default tools (including editing); an array selects tools explicitly. `read` and `submit_review` are always added, even for `allow: []`. `deny` uses Pi's `*` patterns and cannot match either mandatory tool. Tool entries cannot contain commas, whitespace, or additive/subtractive prefixes. Unprofiled slots retain their existing behavior.

Profiled workers disable ambient extensions, skills, and prompt templates; only the sidecar extension and explicit resources load. `skills` contains absolute or `~/` paths **on the execution machine**; home-relative paths expand there, never against the caller's home for remote workers. A file must be Markdown (`.md`, case-insensitive); a directory must contain a regular `SKILL.md` file. Missing or invalid resources refuse launch. Remote profiles and prompt files transfer over either transport, but skills and their assets are not copied. The profile supports Pi workers only; the calling planner/orchestrator may use Pi or Claude.

MCP is all-or-nothing in version 1: `mcp: false` passes `--no-mcp`; `true` explicitly loads Pi's built-in MCP, codemode, and tool-search extensions, enabling that machine's normal trusted user/project MCP configuration. It does not select named servers. Tool lists retain Pi's MCP selection/exposure semantics; hiding tools does not prevent server connections. These controls are not an operating-system sandbox. Linux busy steering requires the normally ambient steering extension and therefore is unavailable in a profiled worker; idle steering, requests, answers, and reload retain the sidecar protocol.

The slot persists canonical JSON, its SHA-256 hash, its working directory, and the startup model/thinking pair under `~/.cache/claude-sidecar/<agent>.profile.json`, `.profile.sha256`, `.cwd`, and `.startup.json`, protected by its identity lock. A first local cwd binding uses the physical directory so retargeting a symlink cannot redirect recreation; existing saved directories remain authoritative. Omitted `SIDECAR_MODEL`/`SIDECAR_THINKING` overrides retain the saved pair; explicit changes require `stop --fresh`, even for a stopped worker. Older profile snapshots without a startup-pair binding also require fresh reset. Follow-ups may omit `--profile-file`; recreation resumes in the bound directory even when the caller changes directories. Changed profile content, and first attachment to any existing unprofiled conversation (running or stopped), require `sidecar --slot N stop --fresh` first. For a profiled slot, or an explicit `--profile-file FILE stop --fresh` rebind, fresh reset clears the profile, startup pair, and cwd/machine binding with the session generation, permitting a new profile, role, directory, and model/thinking pair. It also clears pending questions and launcher checks so a rebound worker cannot run the previous checkout's acceptance commands. Ordinary unprofiled fresh resets preserve their legacy machine, check, and pending-question bindings. Every queued assignment records its admitted session/generation and refuses dispatch if a fresh reset replaces that conversation while it waits, even if the replacement has the same profile or the assignment began unprofiled; normal same-session pane recreation remains allowed. A matching live session is reused; `restart` and `reload` do not apply changed startup flags. Profile snapshots contain the literal prompt, so do not put credentials in them.

## Sidecars on another machine

`--machine NAME` runs a slot's sidecar on a [saved Herdr SSH machine](https://herdr.dev/docs/connecting-machines/), such as your laptop, while Claude stays local. `NAME` is a saved machine's label or profile ID. The selected agent runs in a Herdr pane on that machine, and your local Herdr window lists the pane under the machine. It is opt-in per slot; without the flag, or `SIDECAR_MACHINE`, nothing changes.

```bash
./scripts/sidecar --slot 2 --machine laptop ask "Run the integration tests on macOS and report."
./scripts/sidecar --slot 2 answer "Yes."        # no flag needed: slot 2 remembers its machine
./scripts/sidecar --machine laptop --remote-cwd /Users/me/src/app diff origin/main "Intent"
```

- **Slots stay put.** A slot remembers its machine in `~/.cache/claude-sidecar/<agent>.machine`, so later `note`, `ask`, `answer`, `status` and `restart` route there without the flag. Starting a slot on another machine, or moving a local slot to one, is an error: use another slot. `SIDECAR_MACHINE=laptop` makes new slots start on that machine by default; a slot bound earlier keeps its own.
- **Panes.** Every Herdr call for the slot goes through `herdr --machine`. The panes open in the machine's workspace that already has a pane in the working directory (Herdr picks one when none does), in a "Sidecars" tab that fills 2×2 like the local one. Claude's local tab is never used. Agent names carry a short tag of the local machine, such as `sc-3fa9-pane-1`, so they cannot collide with sidecars that a Claude on that machine starts.
- **Files.** The sidecar reads requests where it runs. The launcher copies each request, diff and plan file over `ssh <target>` into `~/.cache/claude-sidecar/requests` on the machine, reads the report and the `needs_answer` marker back from the machine's `~/.cache/claude-sidecar/reports`, and polls it like a local one. Paths are resolved on the machine, so its home directory may differ. SSH uses the target saved in `herdr machine list`, with `BatchMode=yes` and keepalives, so it never prompts or hangs.
- **Code.** The sidecar works in the machine's own checkout, by default at the same absolute path as the current directory; machine path mappings or `--remote-cwd DIR` name the directory there instead. Requests tell it that path, and for `diff` and `plan` Claude's commit and that its uncommitted changes exist only in the copied files. The checkout may need `git fetch` to reach that commit. The launcher never runs checkout or reset there, and tells the sidecar not to. **Edits and commits a remote sidecar makes land in the machine's checkout, not in the local one.**

Requirements:

- Herdr 0.9.1 or later on both machines. Add the machine with `herdr machine add <ssh-target>` and check `herdr machine list`. The SessionStart hook names the enabled machines to Claude when that command works, and says nothing about machines otherwise.
- On the machine: the selected agent CLI, authenticated, and Git for repository work. The default `sh` transport also needs a POSIX SSH shell and this plugin at the same home-relative path there (for example, `~/git/claude-sidecar/sidecar`) for every backend. `SIDECAR_REMOTE_HOME` names the directory containing `sidecar.ts` and the role prompts (`reviewer.md`, `implementer.md`, `researcher.md`, `explorer.md`) elsewhere, not the user home or plugin root. The Node transport deploys runtime files automatically. Claude Code instructions are copied by either transport. The launcher itself runs only here.
- SSH keys loaded in your agent: a passphrase-protected key is not prompted for.

Clear errors name an unknown or disabled machine, a missing plugin or directory on the machine, and an unreachable SSH connection.

### Windows and machine path mappings

For a Windows machine whose OpenSSH shell is `cmd.exe`, use the Node transport. It uses the Node already required by pi, without changing OpenSSH's `DefaultShell` or launching pi over SSH: Herdr still owns the agent pane. Put per-machine settings in `~/.config/claude-sidecar/machines.json` (override the file with `SIDECAR_MACHINES_FILE`):

```json
{
  "lappy": {
    "transport": "node",
    "paths": {
      "/home/aim/git": "C:/git"
    }
  }
}
```

Keys are saved machine labels or IDs; IDs take precedence. The longest matching directory prefix maps the local checkout, including subdirectories. `--remote-cwd` overrides the mapping and accepts Windows drive paths; the slot remembers the chosen directory and cannot be rebound. For another checkout, pick a free slot: `sidecar --slot N --machine NAME --remote-cwd DIR ask TEXT`. A matching checkout must already exist on the machine. This does not clone, reset or synchronize repositories.

The Node transport copies only `sidecar.ts`, `reviewer.md`, `profile.md`, `implementer.md`, `researcher.md`, `explorer.md`, `reload.mjs` and `windows-runtime.mjs` into the same relative directory, rooted at `C:/` on Windows or the remote home on Linux (for example, `C:/git/claude-sidecar/sidecar` or `~/git/claude-sidecar/sidecar`), updating changed files on each invocation. If the local plugin is outside the local home, the relative directory defaults to `git/claude-sidecar/sidecar`. No plugin checkout or remote launcher dependencies are needed. Optional `home` names a different runtime deployment directory; `SIDECAR_REMOTE_HOME` overrides it. Already-running agents retain their loaded extension. Requests, answers and reports also transfer through Node, so the SSH default shell needs no POSIX commands. Pi's own Bash tool still needs its usual Windows shell setup (such as Git Bash).

From a mapped checkout, start a new slot with `./scripts/sidecar --slot 2 --machine lappy ask "Run the tests there."`; follow-ups need only `--slot 2`. This transport has been smoke-tested with pi in a Windows Herdr pane, including tool execution, report delivery and answering a pending question.

## Sync tooling on a saved machine

`sidecar sync-machine NAME` updates the saved machine's `grok-style-pi` and `claude-sidecar` Git checkouts from `origin`. It is independent of the current slot and never changes its binding, deploys runtime files, or reloads a running Pi. Run `sidecar --slot N reload` afterward to load updated resources on that slot. Unpublished local commits cannot reach the machine through this command.

Discovery prefers local paths in the machine's Pi settings (`PI_CODING_AGENT_DIR`, default `~/.pi/agent/settings.json`, plus a mapped project's `.pi/settings.json`) and the configured runtime `home`, then known `~/git`, `~/git/codex`, `~/src`, `C:/git` and `C:/git/codex` locations. Resource globs use their existing literal ancestor to identify a checkout; patterns spanning different checkouts require explicit `tooling` paths. An unresolved existing configured resource refuses known-location fallback rather than updating a potentially stale copy. Ambiguous or missing checkouts fail clearly. Override discovery with `tooling` in the existing machine configuration:

```json
{
  "lappy": {
    "transport": "node",
    "tooling": {
      "grok-style-pi": "C:/git/codex/grok-style-pi",
      "claude-sidecar": "C:/git/claude-sidecar"
    }
  }
}
```

Both checkouts must be clean, on a branch of the same name as its `origin` branch, and have no unpublished or diverged local commits. The command validates both, fetches both origins, then fast-forwards; it prints each path, branch and old/new commit. Dirty files (including untracked files), detached HEADs, divergence, local-only commits, missing origins and unverifiable paths are refused. It never resets, rebases, stashes or switches branches. Fetches can update Git metadata even when validation subsequently refuses the checkout update. A late filesystem/Git failure can leave the first checkout updated and the second unchanged; the output identifies completed updates, and there is no automatic rollback.

Exit 0 means both synchronized; exit 1 means refusal or failure. `SIDECAR_SYNC_TIMEOUT_S` (default 60) bounds each Git operation. Node and Git must be on the remote SSH PATH; the program travels on stdin and Git paths use argument arrays, so Windows `cmd.exe` and shell metacharacters need no special quoting. No credentials, dependencies, Pi executables or system configuration are installed. Avoid editing the tooling checkouts during sync. Node-transport slots still deploy the **local plugin's** runtime files on their next command; updating the remote source checkout does not change that deployment policy.

## Safety

The reviewer inspects by default, but can edit and commit when asked. It may push and write to GitLab/GitHub when asked. Pi runs with all its tools and no command guard; Claude Code uses its configured permissions. The agent has access to your filesystem and its own model credentials. Claude remains responsible for verifying findings.

## Review progress and coverage

A request prints `sidecar: <id> still working (3m00s); last output: ...` to stderr every `SIDECAR_PROGRESS_S` seconds (default 60; `0` turns it off), taken from the last line of the sidecar's pane. A `diff` request asks the sidecar to reproduce each finding with a command and quote its output, and to mark the rest `unverified`. Each finding also states whether it is `introduced` or `pre-existing` at the base. A base that is not an ancestor of HEAD is replaced by the merge-base, so newer upstream commits never look like removals. A `plan` request asks the reviewer to flag performance and cost claims that cite no measurement.

After a `diff` report is delivered, the launcher records the mode and object id of every path that differs from the base (the working tree as Git would stage it: untracked files included, ignored files excluded, symlinks by link text, submodules by commit), per slot and repository, together with the base commit. A dirty submodule's uncommitted content is not compared. `sidecar unreviewed` compares the working tree with that record against the same base, prints the files whose content differs, and exits 1 if there are any (or if no review is recorded and files have changed). Committing reviewed content does not count as a change.
