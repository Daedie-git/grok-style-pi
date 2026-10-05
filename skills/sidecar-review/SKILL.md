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

## Steer a busy sidecar

`ask`, `diff` and `plan` hold their slot until the report arrives, and a `note` queues behind them. To redirect a sidecar that is mid-task, use `steer`: it reaches the running pi within a second, shows in its transcript as a steering message, and never waits for the in-flight request. The sidecar adjusts its current task; its report for that request still comes back as usual. Use it for a changed decision or a wrong turn, not for routine context (that is a `note`).

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot 3 steer "Stop refactoring; the user wants only the failing test fixed."
```

It exits 0 when delivered (a sidecar that was idle gets it as a normal prompt) and 1 when refused or failed. Exit 4 means it was not picked up and was withdrawn, so it is safe to resend: the sidecar's pi may predate the feature (needs grok-style-pi updated and `/reload`) or be compacting. Exit 6 means the sidecar claimed the message but never acknowledged it, so it may still arrive; check before resending.

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

`<base>` is the commit the work started from (`HEAD` when all of it is uncommitted). The review covers commits since base, uncommitted changes, and untracked files.

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
