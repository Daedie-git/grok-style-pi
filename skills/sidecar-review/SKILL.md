---
name: sidecar-review
description: Second-opinion review by a persistent pi agent in a Herdr pane. Use after implementation, before complex plans, and at milestones to brief the reviewer. Requires HERDR_ENV=1.
---

# Sidecar review

A long-lived pi agent in a herdr split pane reviews your work and remembers the session's history: notes you sent, past reviews, findings you rejected. You drive it with `"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar"`. It can edit files and commit anywhere, including your checkout, when you or the user ask it to change code (`sidecar ask`, naming the checkout or worktree). It never pushes or writes to GitLab; you review its changes and push.

## Brief it

The sidecar only knows what you tell it. Send a `note` at each milestone: the user's goal, an approved plan and where it lives, a decision and its reason, a step finished, a direction change. One or two sentences each.

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" note "User approved plan docs/plans/x.md; ownership of FrameGraph stays with Renderer (ADR-0042)."
```

Notes return in seconds and cost little; the reviews they inform are sharper for them.

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

## Handle the report

The report prints on completion. Every finding is a claim to verify, not an instruction:

1. Check each finding against the code. Mark it **confirmed** or **rejected** with the reason.
2. Fix the confirmed ones.
3. When you rejected a finding or changed a lot, tell the sidecar so its memory stays accurate: `"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" ask "Rejected #2: <reason>. Fixed #1 and #3 in <files>; re-check those."`
4. Tell the user, in your final summary, which sidecar findings you fixed and which you rejected and why.

Done when every finding is confirmed-and-fixed or rejected-with-reason, and the user has that list.

## When it misbehaves

- Outside Herdr (`HERDR_ENV` is not `1`): explain that the sidecar requires an interactive Claude session inside Herdr, and continue without a sidecar review.
- `blocked`: the sidecar is waiting on a question in its pane. Ask the user to answer it there; do not send keys to it yourself.
- `no report submitted`: the command prints the pane's recent output. Retry once with `"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" ask`; after that, report the failure to the user and continue with your own review.
- `sidecar status` shows its state; `sidecar start` restarts it, resuming the same pi session.
