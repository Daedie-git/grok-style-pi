# Claude Sidecar

A Claude Code plugin that runs persistent [pi](https://github.com/badlogic/pi-mono) or Claude Code sidecar agents on demand in Herdr: panes of the herdr TUI, or terminals of the Herdr app. Sidecars remember notes and earlier reviews, review plans and diffs, implement tasks, and return Markdown reports to Claude.

Sidecars run on [herdr-runner](../herdr-runner/README.md), the core that Grok's Pi subagents use: one coordination database, pane placement, close-on-completion, owner-gone cleanup, cold resume and saved machines. A sidecar is a runner agent owned by the Claude conversation in its pane.

The default backend is pi with `openai-codex/gpt-6.1-sol` and `high` thinking for reviewers.

## Requirements

- Linux, macOS or Windows with Node 22.18+ (22.x) or 24+, Git, and Bash for the hook scripts.
- Claude Code with plugin support, inside a herdr pane (`HERDR_ENV=1`) or a Herdr app terminal (`HC_TERMINAL_ID`), with `herdr` or `hc` on `PATH`.
- The selected agent CLI on `PATH`, authenticated: pi or Claude Code.
- Pi sidecars report their runs through herdr-subagents, so pi must load it or Grok's subagent integration (`integrations/subagents.ts`).

## Install

The marketplace is this repository's root:

```text
/plugin marketplace add /path/to/grok-style-pi
/plugin install claude-sidecar@daedie-sidecar
```

Run `npm install` in the checkout first, and restart Claude inside Herdr after installing. `herdr-runner` in this directory is a symlink to the shared package; Claude Code copies its target into the plugin cache. On Windows, the checkout needs `git config core.symlinks true` (Developer Mode) before that file is checked out.

## Develop

```bash
npm test                          # repo gate: includes this plugin's typecheck and tests/runner/*.spec.ts
claude plugin test packages/claude-sidecar   # the band's tests in tests/band
```

Runtime state stays in `~/.cache/claude-sidecar`: slots under `runner/`, reports under `reports/`, and the role, agent, machine, request and pending files the band reads.

## How it works

`scripts/sidecar` runs `src/cli.ts`. The plugin's `sidecar` tool runs request commands as detached jobs (`scripts/sidecar-job`) whose output and exit code reach Claude as a message; `status`, `report`, `keep`, `unkeep`, `stop` and `unreviewed` answer inline. The skill (`skills/sidecar-review/SKILL.md`) documents every command for Claude.

A request starts the slot's agent, or resumes its conversation, and waits for the run to end. The sidecar's final reply is its report. Pi asks a blocking question with `needs_answer`; Claude Code ends its report with `NEEDS_ANSWER: <question>`. The first stdout line is `# Sidecar report (<path>)`, and the report is saved there.

| Exit | Meaning |
|---|---|
| 0 | report delivered |
| 1 | failure or refusal |
| 2 | the run ended without a report |
| 3 | the sidecar asks a question; reply with `answer` |
| 4 | an identical request is already in flight |
| 5 | the sidecar is blocked on an approval in its pane |
| 7 | `stop` refused while a request runs |

Role prompts are `sidecar/<role>.md` after a shared protocol (`src/prompts.ts`). Local pi sidecars also load the repository's `.claude/skills`.

## Pane lifecycle

A pane closes once its run completes, unless pinned (`ask --keep`, `keep`) or focused; failed, blocked and questioning panes stay open. The next request resumes the same conversation in a new pane. When the owning Claude pane ends, its pi sidecars are stopped and their panes closed; a running Claude Code sidecar stays open, since stopping it would lose its conversation. Clearing Claude hands the slots to the new conversation (SessionStart transfers ownership).

Closing needs a process that maintains coordination. Each request runs a detached `maintain` pass afterwards, at most one per Claude pane, for three minutes; `session-end` and the Bash hook's once-a-minute sweep start one too. In the Herdr app, requests label Claude's terminal with its process and session so a departed owner can be recognized.

## Cooperative review

`coop-review [--pi-slot N] [--claude-slot M] [BASE] [CONTEXT]` has a pi reviewer and a Claude Code reviewer (slots 98 and 99) review the same diff in parallel, then check each other's numbered findings. Both slots are reserved for the run; a busy slot fails at once. The combined report puts every finding under **Confirmed by both**, **Disputed** or **Rejected by both**, with its origin and the four underlying reports linked. Check entries that match no finding are listed under Warnings. It decides nothing. Fixtures recorded from the former Bash launcher pin its output (`tests/runner/fixtures/coop`).

## Implementer checks

Implementer asks append a completion contract. `ask --accept CMD` (repeatable) runs CMD with `bash -c` in the ask's directory after the report (`SIDECAR_ACCEPT_TIMEOUT_S`, default 1800); `--scope GLOB` lists files changed outside the globs. Results lead the report under `## Launcher checks`. Checks persist on the slot until replaced or cleared with `--no-checks`. Local slots only.

## Rejected findings

`reject TEXT` records `R<n>` and sends it to the reviewer, which answers `R<n>: withdrawn` or `R<n>: stands`. Later `diff` requests list rejections still open or standing. `reject --overrule R<n> REASON` closes one against the reviewer. The ledger is `~/.cache/claude-sidecar/<slot>.rejections.jsonl`.

## Review coverage and the push gate

After a `diff` report, the launcher records the mode and object id of every path that differs from the base, per slot and repository. `unreviewed` lists files changed since that record and exits 1 if there are any. The PreToolUse hook (`scripts/push-gate`) denies `git push`, `gh pr create` and `glab mr create` while such files exist in a repository with a recorded review; `SIDECAR_REVIEW_SKIP=<why>` in the command passes. A base that is not an ancestor of HEAD is replaced by the merge-base. `plan` and `diff` run on local slots only.

## Fleet role profiles

`--slot N --profile-file FILE ask TEXT` binds a resolved Fleet profile to a fresh local pi slot:

```json
{"version":1,"role":"implementer","prompt":"Implement only the assigned change.","allow":null,"deny":[],"skills":[],"mcp":false}
```

The prompt follows the shared protocol in place of the role file. `allow`/`deny` become a closed tool list (`allow: null` starts from `read`, `bash`, `edit` and `write`; `read` is always kept); `skills` are passed as `--skill`. Refused: `mcp: true`, `*` in `allow`, `--machine` and `--agent claude`. `mcp: false` hides MCP tools but does not stop servers from connecting, and profiled sidecars still load ambient extensions. Follow-ups may omit the file; a different profile needs `stop --fresh`.

## Sidecars on another machine

`--machine NAME` runs a slot on a saved Herdr machine, which needs an up-to-date grok-style-pi checkout (`npm install` run) that its pi loads. `--remote-cwd DIR` sets the directory there, else this directory mapped through the machine's `paths` in `~/.config/claude-sidecar/machines.json`, else the per-machine `cwd` in `~/.pi/agent/herdr-subagents.json`, else this directory. Remote setup and protocol rules are in the [herdr-subagents README](../herdr-subagents/README.md#remote-machines).

`sync-machine NAME` fast-forwards the machine's grok-style-pi checkout from `origin` by running `scripts/sync-machine.cjs` there over SSH. It refuses local changes, local-only or diverged commits, ambiguous checkouts and detached HEADs. `~/.config/claude-sidecar/machines.json` may set, per machine label or ID, `tooling.grok-style-pi` (the checkout), `home`, and `paths` (local-to-remote prefixes).

## Safety

Sidecars inspect by default but can edit, commit, push and write to GitLab/GitHub when asked. Pi runs with all its tools; Claude Code uses its configured permissions. Claude remains responsible for verifying findings.
