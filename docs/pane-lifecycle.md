# Pane lifecycle: close unneeded sidecar panes

Panes accumulate because nothing closes them. A slot's conversation lives in its session record (`<agent>.session`, `.claude-started`, `.codex-session`), not in its pane: `stop` closes the pane and the next request resumes the session. This plan makes the launcher close panes itself.

## Rules

A slot's pane is closed (through `stop_unlocked`, so the session is kept) when either holds:

1. **Owner ended or gone:** a matching interactive SessionEnd recorded the owner's termination, or its pane is absent from `herdr pane list` and an alias-resolving `herdr pane get <owner pane id>` returns a structured `pane_not_found` error. Transport failures, timeouts and malformed replies mean unknown presence, not death; normal pin and idle-age rules still apply. Save the original owner pane ID with the slot: moving a pane can change its listed ID while its old ID remains a valid alias. Legacy slots use conservative name matching and Herdr public-ID reconstruction.
2. **Idle:** its last request finished more than `SIDECAR_IDLE_CLOSE_S` seconds ago (default 900; `0` disables this rule). A slot with no recorded request uses the `.agent` file's mtime.

It is never closed while:

- its request lock (`<agent>.lock`) is held,
- herdr does not positively report `idle` or `done`,
- it has an unanswered question (`<agent>.pending` non-empty),
- the user has its pane focused (refresh focus and idle status immediately before closing),
- it is pinned (`<agent>.keep` exists) — except by the owner-ended-or-gone rule,
- `agent_runs_sidecar_session`/`owns_pane_process` fail (existing `stop` check).

Remote slots (`.machine` not `local`) are skipped by the sweep; `stop --all` still stops them.

## Interface

- `sidecar sweep`: applies the rules to every slot of every owner in `$STATE_DIR` and prints one line per closed pane. Uses one `herdr pane list`; never waits on a slot lock (`flock -n`). Exit 0 unless herdr is unreachable.
- `sidecar [--slot N] ask --keep …` and `sidecar [--slot N] keep|unkeep`: create or remove `<agent>.keep` under the startup lock. Pin before scheduling cleanup. `stop --fresh` removes it.
- Triggers, all non-blocking (detached, output to `$STATE_DIR/sweep.log`, rate-limited to once per 60 s with a timestamp file under a `flock -n`):
  - `session-start`,
  - other launcher commands except `sweep`, `session-end` and the internal deferred-check entry; pinning happens first,
  - `scripts/push-gate` (PreToolUse, every Bash call). Keep its fast path at about 1 ms: check the timestamp with a shell builtin before forking.
- Each local request completion schedules one detached idle check, carrying its request ID and idle limit. It sweeps only that slot after the deadline, without requiring further tool calls. A later request invalidates the old check under the slot lock and schedules its own deadline; `0` schedules none. Superseded checks wake once and exit without closing a pane. Protected panes stay open until a later sweep.
- New `SessionEnd` hook: unless `reason` is `clear`, a matching owning interactive session records `<owner>.ended` and runs a guarded sweep scoped to that owner's local slots. Working, blocked, pending, focused and locked slots stay open; a later sweep reclaims them once protections clear. Explicit `stop` keeps its existing semantics, including remote slots. SessionStart clears the ended marker when it registers a new owner session.
- Hook ancestry has three outcomes. Identified interactive Claude (including `claude.exe`, `node.exe` and Windows npm CLI paths) publishes identity and registers ownership. Headless Claude and named Claude sidecars skip startup entirely. Unidentified ancestry still publishes the base slot identity, environment exports and guidance, but registers no ownership; SessionEnd does nothing. SessionEnd also requires the registered `session_id`.
- Ancestry tests bound the starting PID with `SIDECAR_TEST_ANCESTRY_PID`, so an outer interactive Claude cannot affect their result.
- Measure the push-gate hook's median and p99 wall time before and after the change with recent and expired timestamps and concurrent invocations. The 1 ms target is a budget, not a measured claim.

## Skill and README

Replace "When a slot's work is finished, run stop" with: panes close after 15 idle minutes or when this Claude pane ends; the next request resumes the conversation. Pass `--keep` only when the user watches the pane.

## Tests

Fake-herdr cases in `tests/test_sidecar.py`, run through `python3 tests/run.py`: idle slot closed, session kept and resumed on next ask; busy, unknown-status, pending, pinned and focused slots left open; owner-gone closes pinned slots; moved owners remain alive through aliases; remote slots skipped; rate limit; idle closure without further CLI activity; later requests replace the deadline; SessionEnd with `clear`, mismatched session IDs or nested headless Claude keeps panes, and matching interactive termination closes only unprotected local slots. Cover Windows-shaped executables and npm paths, unidentified ancestry, and unknown versus confirmed-missing owner lookups.
