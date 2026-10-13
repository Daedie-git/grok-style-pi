---
name: sidecar-review
description: Second-opinion review by a persistent pi agent in a Herdr pane. Use after implementation, before complex plans, and at milestones to brief the reviewer. Requires HERDR_ENV=1.
---

# Sidecar review

Persistent pi agents in Herdr panes review or implement work and remember their own history: notes you sent, past reviews, findings you rejected. No agent starts at Claude startup; the first `note`, `plan`, `diff`, or `ask` starts the selected sidecar. You drive it with `"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar"`. It can edit files and commit anywhere, including your checkout, when you or the user ask it to change code (`sidecar ask`, naming the checkout or worktree). When you or the user ask, it can also push and comment on, approve or merge GitLab/GitHub merge requests; it does not do so on its own initiative.

## Parallel sidecars

Use `--slot N` before the command to select an independent persistent sidecar (default `1`). Assign a different slot to each concurrent task and keep that slot for its notes, follow-ups, status checks and answers. Each slot has separate context, reports, pending questions and request locks; requests to the same slot serialize. Reuse existing slots after their work finishes.

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot 2 ask "Inspect the parser for edge cases; report without editing."
"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot 3 ask "Inspect the lifecycle code; report without editing."
"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot 2 answer "Yes, preserve backward compatibility."
```

For implementation tasks, select a fresh slot with `--role implementer` before `ask`; it defaults to medium reasoning. Review slots default to `reviewer` with high reasoning. A slot remembers its role for follow-ups; use a separate review slot to review an implementer's work. `SIDECAR_THINKING` overrides either default at startup.

`--agent claude` (on a fresh slot) runs a persistent Claude Code agent instead of pi: Opus for reviewers, Sonnet for implementers, with the same role effort defaults (`SIDECAR_CLAUDE_MODEL` overrides the model). It returns reports by writing a file, and the slot keeps its agent. It also runs on another machine with `--machine` (Claude Code must be logged in there; `SIDECAR_CLAUDE_PERMISSION_MODE=bypassPermissions` lets it work unattended). It cannot be reloaded, and a busy one cannot be steered; use `ask` once it reports. It starts no sidecars of its own.

Run independent requests with `run_in_background: true`. Give each editing sidecar disjoint files or its own worktree and state the checkout path in the request. Sidecars on this machine share the filesystem, not conversation history; brief each on its own task. Herdr fills Claude's current tab to four total panes, counting every pane open in it. With Claude alone, the first sidecar splits left/right, and the next two split top/bottom in each column. Further sidecars fill new tabs with the same four-pane layout without changing focus.

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

`<base>` is the commit the work started from (`HEAD` when all of it is uncommitted). The review covers commits since base, uncommitted changes, and untracked files. After committing or pushing, pass the pre-work commit as `<base>`; use `diff`, not `ask`, so the sidecar receives the diff.

The sidecar reproduces each finding and quotes the command and output; it marks the rest `unverified`. A long request prints a status line to stderr every minute (`SIDECAR_PROGRESS_S`, `0` disables it). Before you report done or push, run `sidecar unreviewed`: it lists files changed since the last diff review and exits 1 if there are any. Send those back through `diff`.

## Reviewing a merge request

When the review targets a GitLab/GitHub merge request, post each confirmed finding as an **inline discussion on the diff line** it concerns. Never post a summary note, and never post without the user's go-ahead. Review a worktree at the MR head so the user's checkout stays untouched, and run the sidecar from inside it.

## Handle the report

The report prints on completion. Every finding is a claim to verify, not an instruction:

1. Check each finding against the code. Mark it **confirmed** or **rejected** with the reason.
2. Fix the confirmed ones.
3. When you rejected a finding or changed a lot, tell the sidecar so its memory stays accurate: `"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" ask "Rejected #2: <reason>. Fixed #1 and #3 in <files>; re-check those."`
4. Tell the user, in your final summary, which sidecar findings you fixed and which you rejected and why.

Done when every finding is confirmed-and-fixed or rejected-with-reason, and the user has that list.

## Long-running requests

`plan`, `diff`, `ask` and `answer` wait without a deadline until the sidecar submits its report, so an implementation task that takes hours is one command. Run every request with the Bash tool's `run_in_background: true` and let its completion notice wake you. Never detach it yourself with `&`, `( … &)`, `nohup` or `setsid`, and never redirect its output to `/dev/null`: the harness then cannot notify you, and the report or question goes unseen. If the sidecar's turn ends without a report (an aborted turn or failed context compaction), the command exits 2 with the pane's recent output within seconds; send the task again with `ask`.

## Questions from the sidecar

When the sidecar is blocked on a decision only you or the user can make, the command prints `NEEDS_ANSWER: <question>` first, then its report, and exits with code 3 (a background run's completion notice shows this exit code). Decide, or ask the user, then reply with `"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot N answer "<decision and constraints>"` using the requesting sidecar's slot; the sidecar resumes the same task. Do not start a new `ask` for it. Exit code 4 means an identical request is already in flight; wait for it instead of resending. Exit code 5 means the sidecar is blocked on an approval in its own pane; ask the user to handle it there.

## When it misbehaves

- Outside Herdr (`HERDR_ENV` is not `1`): explain that the sidecar requires an interactive Claude session inside Herdr, and continue without a sidecar review.
- `blocked`: the sidecar is waiting on a question in its pane. Ask the user to answer it there; do not send keys to it yourself.
- `no report submitted`: the command prints the pane's recent output. Retry once with `"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" ask`; after that, report the failure to the user and continue with your own review.
- `sidecar status` shows its state; `sidecar start` restarts it, resuming the same pi session.
