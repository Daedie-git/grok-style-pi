# Pane lifecycle: close panes like finished subagents

A slot's conversation lives in its session record (`<agent>.session`, `.claude-started`, `.codex-session`), not in its pane: `stop` closes the pane and the next request resumes the session. A sidecar's task ends when it delivers its report, so the launcher closes the pane then, as Claude Code ends a subagent whose result returned. A later request resumes it, as `SendMessage` continues a finished subagent. There is no idle timer.

## Rules

A slot's pane is closed (through `stop_unlocked`, so the session is kept) when either holds:

1. **Report delivered:** its request exited 0. `finish_request` schedules a detached `done-close NAME ID` (local slots only; `SIDECAR_CLOSE_WHEN_DONE=0` disables it). It waits for the launcher to release the request lock, then retries the guarded close every 2 s for up to `DONE_CLOSE_WAIT_S` (default 120) while the agent settles. It exits once the slot's request ID changes: the newer request decides.
2. **Owner ended or gone:** a matching interactive SessionEnd recorded the owner's termination, or its pane is absent from `herdr pane list` and an alias-resolving `herdr pane get <owner pane id>` returns a structured `pane_not_found` error. Transport failures, timeouts and malformed replies mean unknown presence, not death. Save the original owner pane ID with the slot: moving a pane can change its listed ID while its old ID remains a valid alias. Legacy slots use conservative name matching and Herdr public-ID reconstruction.

It is never closed while:

- its request lock (`<agent>.lock`) is held,
- herdr does not positively report `idle` or `done`,
- it has an unanswered question (`<agent>.pending` non-empty),
- the user has its pane focused (refresh focus and idle status immediately before closing),
- it is pinned (`<agent>.keep` exists) — except by the owner rule,
- `agent_runs_sidecar_session`/`owns_pane_process` fail (existing `stop` check).

Requests that exit non-zero (question, no report, blocked, cancelled) leave the pane open for the answer or inspection. Remote slots (`.machine` not `local`) are never closed automatically; `stop --all` still stops them.

## Interface

- `sidecar sweep`: applies the owner rule to every slot of every owner in `$STATE_DIR` and prints one line per closed pane. Uses one `herdr pane list`; never waits on a slot lock (`flock -n`). Exit 0 unless herdr is unreachable.
- `sidecar [--slot N] ask --keep …` and `sidecar [--slot N] keep|unkeep`: create or remove `<agent>.keep` under the startup lock. `stop --fresh` removes it.
- Sweep triggers, all non-blocking (detached, output to `$STATE_DIR/sweep.log`, rate-limited to once per 60 s with a timestamp file under a `flock -n`): `session-start`, other launcher commands except `sweep`, `done-close`, `session-end` and `ask` (which pins first), and `scripts/push-gate` (PreToolUse, every Bash call; its fast path checks the timestamp with a shell builtin before forking).
- `SessionEnd` hook: unless `reason` is `clear`, a matching owning interactive session records `<owner>.ended` and runs a guarded sweep scoped to that owner's local slots. Protected slots stay open; a later sweep reclaims them once protections clear. SessionStart clears the ended marker when it registers a new owner session.
- Hook ancestry has three outcomes. Identified interactive Claude (including `claude.exe`, `node.exe` and Windows npm CLI paths) publishes identity and registers ownership. Headless Claude and named Claude sidecars skip startup entirely. Unidentified ancestry publishes the base slot identity, environment exports and guidance, but registers no ownership; SessionEnd does nothing. SessionEnd also requires the registered `session_id`.

## Tests

Fake-herdr cases in `tests/test_sidecar.py`, run through `python3 tests/run.py` (the suite sets `SIDECAR_CLOSE_WHEN_DONE=0` except where it tests closing): a delivered report closes the pane and the next ask resumes the session; pinned, questioning and reportless requests keep their panes; busy, unknown-status, pending, pinned and focused slots survive `done-close`; a stale `done-close` leaves a newer request alone; live owners keep their slots; owner-gone closes pinned slots; moved owners remain alive through aliases; unknown owner lookups close nothing; remote slots are skipped; sweep rate limit; SessionEnd with `clear`, mismatched session IDs or nested headless Claude keeps panes.
