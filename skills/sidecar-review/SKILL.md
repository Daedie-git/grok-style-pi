---
name: sidecar-review
description: Second-opinion review by a persistent pi or Claude Code agent in Herdr. Use after implementation, before complex plans, and at milestones to brief the reviewer. Requires a herdr pane (HERDR_ENV=1) or a Herdr app terminal (HC_TERMINAL_ID).
---

# Sidecar review

Persistent pi or Claude Code agents in Herdr panes review or implement work and remember their own history: notes you sent, past reviews, findings you rejected. No agent starts at Claude startup; the first `note`, `plan`, `diff`, or `ask` starts the selected sidecar. You drive it with `"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar"`. It can edit files and commit anywhere, including your checkout, when you or the user ask it to change code (`sidecar ask`, naming the checkout or worktree). When you or the user ask, it can also push and comment on, approve or merge GitLab/GitHub merge requests; it does not do so on its own initiative. Reviewers follow the repository's code-review skill when it has one; local pi slots also load the repository's `.claude/skills`.

## Notification safety

Run **every** `ask`, `diff`, `answer` and `steer` with the Bash tool's `run_in_background: true`, including follow-ups and idle steering. Use the same harness background mode for `plan`, `wait` and `reload`. The harness completion notice is what wakes you when work finishes. Keep the launcher attached to that task: shell `&`, `disown`, `( … & )`, `nohup` and `setsid` produce no harness completion notification. Preserve its output, including question exit codes, and handle every completion.

## Parallel sidecars

Use `--slot N` before the command to select an independent persistent sidecar (default `1`). Assign a different slot to each concurrent task and keep that slot for its notes, follow-ups, status checks and answers. Each slot has separate context, reports, pending questions and request locks; requests to the same slot serialize. Reuse existing slots after their work finishes.

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot 2 ask "Inspect the parser for edge cases; report without editing."
"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot 3 ask "Inspect the lifecycle code; report without editing."
"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot 2 answer "Yes, preserve backward compatibility."
```

Pick the role by the work, on a fresh slot: the default reviewer for reviews, audits, bug or security scans and anything that writes findings files; `--role implementer` for code changes; `--role explorer` only to find code and explain how it connects; `--role researcher` only to answer a question from primary sources (docs, specs, release notes). Explorers and researchers report inline and write nothing, so they refuse audits and file output. Implementers, explorers and researchers default to medium reasoning, reviewers to high. A slot remembers its role for follow-ups; use a separate review slot to review an implementer's work. `SIDECAR_THINKING` overrides reasoning at startup.

Implementer asks carry a completion contract: a `Status: done|partial|blocked` line, verification through the real entry point, the smallest diff in the surrounding style, and `Verified`, `Not verified`, `Files changed`, `Additions` and `Suggested follow-ups` sections. `Additions` justifies each new function, option, fallback or dependency against the task; unjustified ones signal drift. Run the ask from the implementer's checkout and give it launcher checks:

```bash
cd ../fury-wt && "${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot 4 --role implementer ask \
  --accept "timeout 600 ./build/bin/furyctl cloth list" --scope 'features/cloth/*' --scope 'tests/cloth/*' "Task..."
```

After the report, the launcher runs each `--accept` command itself (`SIDECAR_ACCEPT_TIMEOUT_S`, default 1800) and flags files changed outside the `--scope` globs (`*` crosses directories). Results lead the report under `## Launcher checks`. Make an accept command exercise the real user path, not the unit tests the implementer already ran. Checks persist on the slot through answers, steers and follow-up asks until another ask sets new ones or passes `--no-checks`. They run only for local slots.

`--agent claude` (on a fresh slot) runs a persistent Claude Code agent instead of pi: Opus for reviewers, Sonnet for the other roles, with the same role effort defaults (`SIDECAR_CLAUDE_MODEL` overrides the model). It returns reports by writing a file, and the slot keeps its agent. It also runs on another machine with `--machine` (Claude Code must be logged in there; `SIDECAR_CLAUDE_PERMISSION_MODE=bypassPermissions` lets it work unattended). It cannot be reloaded, and a busy one cannot be steered; use `ask` once it reports. It starts no sidecars of its own.

Give each editing sidecar disjoint files or its own worktree and state the checkout path in the request. Sidecars on this machine share the filesystem, not conversation history; brief each on its own task. In the herdr TUI, sidecars fill Claude's current tab to four total panes, counting every pane open in it. With Claude alone, the first sidecar splits left/right, and the next two split top/bottom in each column. Further sidecars fill new tabs with the same four-pane layout without changing focus. In the Herdr app, sidecars are listed under Claude's terminal.

## Sidecars on another machine

Use `--machine NAME` only when the user asks to run a sidecar on another machine, for example "on the laptop". `NAME` is a saved Herdr machine label or ID; the session-start context lists the enabled ones when Herdr can name them. Pick a slot, then keep it: the slot stays on that machine, so later `note`, `ask`, `answer` and `status` with that slot need no `--machine`. Using the flag with another machine, or on a slot that runs locally, fails; use a new slot.

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot 2 --machine laptop ask "Run the integration tests there and report."
"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot 2 diff <base> "Intent of the change"
```

The sidecar works in the machine's own checkout of the repository, at the same path unless `--remote-cwd DIR` says where. It does not see your uncommitted changes: `diff` and `plan` send them as copied files, and the checkout may lack your commits (the request tells the sidecar to `git fetch`). **Anything a remote sidecar edits or commits lands in the machine's checkout, not yours**; ask it to push or report the patch, and say so in the request. Reports come back as usual. If the command says the machine is unreachable or lacks the plugin, tell the user; do not retry with another machine.

## Brief it

The sidecar only knows what you tell it. Send a `note` at each milestone: the user's goal, an approved plan and where it lives, a decision and its reason, a step finished, a direction change. One or two sentences each.

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" note "User approved plan docs/plans/x.md; ownership of FrameGraph stays with Renderer (ADR-0042)."
```

Notes return in seconds and cost little; the reviews they inform are sharper for them.

## Sync remote tooling

When asked to update a saved machine's sidecar tooling, run `sidecar sync-machine NAME`. This does not select or move a slot. It finds the remote `grok-style-pi` and `claude-sidecar` checkouts through Pi settings/known locations, or the machine configuration's `tooling` paths, and fast-forwards their current branches from `origin`. Both must be clean and have no local-only/diverged commits; a refusal preserves that work. Exit 0 means both synchronized; exit 1 means refusal/failure. Read the old/new commits in the output, then run the affected slot's `reload` between requests. It cannot transfer unpublished commits, install dependencies, or replace a running Pi executable. See README's sync section for path overrides and partial-failure behavior.

## Reload safely

After updating sidecar or Pi extension files, run `sidecar [--slot N] reload` in the background. It waits for the active request's report and Pi's idle state, then reloads without changing the session or pending question. The original request still prints its own report. Exit 0 confirms a fresh runtime; exit 1 means refusal or missing confirmation (inspect the pane before retrying). Confirmation has a 30-second default timeout, configurable with `SIDECAR_RELOAD_TIMEOUT_S`; waiting for active work has no deadline. It does not cancel hung work or replace Pi's executable/startup flags.

## Pane lifecycle

A pane closes once its request delivers a report, and when this Claude pane ends; the next request to the slot resumes the same conversation in a new pane, so keep using the slot for follow-ups. Panes with a pending question, a request that ended without a report, or user focus stay open. Pass `ask --keep` only when the user watches the pane; `sidecar [--slot N] keep|unkeep` changes the pin later. Clearing Claude keeps panes open.

For immediate closure, use `sidecar [--slot N] stop`; `stop --all` stops every slot of this Claude pane. While a request runs it refuses with exit 7; `--force` stops it anyway, ending that request without a report. `--fresh` removes the pin and saved session so the next start begins a new conversation. A pane taken over by another agent is left running.

## Steer a sidecar

If the running slot is idle and has no request in flight, `steer TEXT` creates an `ask` request and waits for its report. Handle its result like any request: exit 0 report, 2 no report, 3 question, 4 duplicate, 5 approval blocked, or 1 failure. Use a background Bash run for this case. A missing sidecar needs `ask` or `start` first.

`ask`, `diff` and `plan` hold their slot until the report arrives, and a `note` queues behind them. To redirect a sidecar that is mid-task, use `steer`: it reaches the running pi within a second (after verifying it is the sidecar's own pi), shows in its transcript as a steering message, and never waits for the in-flight request. The sidecar adjusts its current task; its report for that request still comes back as usual. Use it for a changed decision or a wrong turn, not for routine context (that is a `note`).

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot 3 steer "Stop refactoring; the user wants only the failing test fixed."
```

For a busy slot, it exits 0 when delivered or queued and 1 when refused or failed. Exit 4 means the sidecar did not pick it up in time and it was withdrawn, so it is safe to resend. A sidecar whose pi predates the feature (needs grok-style-pi updated and `/reload`) or runs under another process fails with exit 1 before anything is sent. Exit 6 means pi never confirmed the message entering the conversation (for example during compaction), so it may still arrive; check before resending. A steer is applied after the sidecar's current tool call finishes, not mid-command. Exit 0 with `queued (not yet confirmed in conversation)` means pi accepted it behind the running turn but it was not yet seen in the conversation; a later input handler could still consume it. Messages to an idle sidecar sent in quick succession are held back while an earlier one is unconfirmed, but only for 15 s: after that an unconfirmed idle prompt may race, be dropped, or run out of order relative to later messages, so send one steer at a time and check the pane after exit 6.

## Plan review

Send a plan when it is **complex**: it spans subsystems, decides ownership, lifecycle, scheduling, persistence, or concurrency, migrates data or APIs, or would warrant an ADR. A plan that is a local, mechanical change goes straight to implementation.

Write the plan to a file, then run in the background (`run_in_background: true`) while you keep refining:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" plan path/to/plan.md "What the user asked for and constraints they stated"
```

## Implementation review

After every real implementation, before you report it done, run an **adversarial** review of the diff in the background while you do your own review in parallel:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" diff <base> "Intent of the change and anything non-obvious"
```

`<base>` is a single ref for the commit the work started from (`HEAD` when all of it is uncommitted), not an `A..B` or `A...B` range. The review covers commits since base, uncommitted changes, and untracked files. A base that is not an ancestor of HEAD (an updated `origin/main`) is replaced by the merge-base. After committing or pushing, pass the pre-work commit as `<base>`; use `diff`, not `ask`, so the sidecar receives the diff.

The sidecar reproduces each finding and quotes the command and output; it marks the rest `unverified`. Each finding states its origin, `introduced` or `pre-existing`; pre-existing ones come last and do not block. A long request prints a status line to stderr every minute (`SIDECAR_PROGRESS_S`, `0` disables it). Before you report done or push, run `sidecar unreviewed`: it lists files changed since the last diff review and exits 1 if there are any. Send those back through `diff`.

A PreToolUse hook enforces this: in a repository with a recorded diff review from any of your slots, `git push`, `gh pr create` and `glab mr create` are denied while files changed since the latest one. Review them. Only a push that needs no review (tickets, docs) may be prefixed with `SIDECAR_REVIEW_SKIP=<why>`, and you tell the user you did.

## Co-op review

Use `coop-review` only when the user asks for it or the change warrants a thorough review. It costs about three single reviews. Run it in the background like `diff`:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" coop-review [--pi-slot N] [--claude-slot M] <base> "Intent of the change"
```

A pi reviewer (slot 98) and a Claude Code reviewer (slot 99) review the diff in parallel, then check each other's numbered findings. The slots are dedicated and the command reserves them for the whole run and fails at once if one is busy or in another coop-review. The report accounts for every finding: confirmed by both, disputed (each side's argument, including unchecked ones), or rejected by both, each with its origin. It decides nothing: settle disputes and fixes yourself, verifying each as usual. After fixing, call `coop-review` again with the same slots so both reviewers keep their memory. Exit 3 names the slot that asked; reply with `sidecar --slot N answer`, then rerun. Cancelling it (exit 130/143) stops nothing: the reviewers finish their requests and the slots stay busy until then. It accepts `--machine` for both reviewers, but not `--slot`, `--agent` or `--role`.

## Reviewing a merge request

When the review targets a GitLab/GitHub merge request, post each confirmed finding as an **inline discussion on the diff line** it concerns. Never post a summary note, and never post without the user's go-ahead. Review a worktree at the MR head so the user's checkout stays untouched, and run the sidecar from inside it.

## Handle the report

The command's first stdout line is `# Sidecar report (<local path>)`, printed before the wait; the full Markdown report is saved there and prints on completion. Remote reports are copied locally before printing. If output was truncated, run `sidecar --slot N report` to recover the latest saved report in full, including any question, even without SSH. This exits 0 after printing; it does not answer or clear a pending question. Every finding is a claim to verify, not an instruction:

1. Check each finding against the code. Mark it **confirmed** or **rejected** with the reason.
2. Fix the confirmed ones.
3. Reject each finding through `reject`, one per call, in the background: `"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" reject "#2 (title): <reason with evidence>"`. The reviewer re-checks and answers `R<n>: withdrawn` with what convinced it, or `R<n>: stands` with a reproduction. A standing finding is a defect until you fix it or disprove it with new evidence. Later diff reviews on that slot re-check every rejection not yet withdrawn. `reject --overrule R<n> REASON` settles one against the reviewer; tell the user with the reviewer's failure scenario.
4. After fixing, tell the sidecar what changed: `"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" ask "Fixed #1 and #3 in <files>; re-check those."`
5. Tell the user, in your final summary, which sidecar findings you fixed, which you rejected and why, and which you overruled.

Done when every finding is fixed, withdrawn by the reviewer, or overruled, and the user has that list.

## Long-running requests

`plan`, `diff`, `ask`, `answer` and idle `steer` wait without a deadline until the sidecar submits its report, so an implementation task that takes hours is one harness background task. If an earlier launcher was detached or its completion notification was lost, run `sidecar --slot N wait` with `run_in_background: true` to restore an observable completion. It blocks until the slot's launcher releases its request lock, then prints the saved report path: exit 0 report available, 3 question pending, 1 no saved report or abnormal launcher exit. It observes the latest request when it gets the lock, not future requests or work started directly in the pane. Follow it with `sidecar --slot N report` to read the full result.

`sidecar --slot N status` shows the latest request's start/finish ages and exit code, plus the last report path and `printed`/`unprinted`. `printed` only confirms stdout accepted the full report, not that you or the user read it; truncation or redirection can hide printed reports. If the sidecar's turn ends without a report (an aborted turn or failed context compaction), the original command exits 2 with the pane's recent output within seconds; send the task again with `ask`.

## Questions from the sidecar

When the sidecar is blocked on a decision only you or the user can make, the command prints `NEEDS_ANSWER: <question>` after its first-line report path, then its report, and exits with code 3 (a background run's completion notice shows this exit code). Decide, or ask the user, then reply with `"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot N answer "<decision and constraints>"` using the requesting sidecar's slot; the sidecar resumes the same task. Do not start a new `ask` for it. Exit code 4 means an identical request is already in flight; wait for it instead of resending. Exit code 5 means the sidecar is blocked on an approval in its own pane; ask the user to handle it there.

## When it misbehaves

- Outside Herdr (`HERDR_ENV` is not `1` and `HC_TERMINAL_ID` is unset): explain that the sidecar requires an interactive Claude session inside Herdr, and continue without a sidecar review.
- `blocked`: the sidecar is waiting on a question in its pane. Ask the user to answer it there; do not send keys to it yourself.
- `no report submitted`: the command prints the pane's recent output. Retry once with `"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" ask`; after that, report the failure to the user and continue with your own review.
- `sidecar status` shows its state; `sidecar start` restarts it, resuming the same agent session.
