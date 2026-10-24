# herdr-subagents: close idle panes, resume cold

Idle subagent panes accumulate because `Runner.resume` sends the prompt to the live pane (`locate`, `runner.ts`) and fails when it is gone, so closing a pane loses the agent. Make the pane disposable and the session file the conversation, then close panes on clear rules.

## 1. Cold resume (ship first)

When the original process is confirmed departed and the agent has a loadable session (Pi session path; Claude session id), `resume` opens a new pane with the same placement rules as a launch and starts the child on that session (`pi --session <file>`, `claude --resume <id>`) with the agent's original model, thinking, tools and directory. A missing or replaced Herdr name alone does not prove departure: check its recorded pane alias and the live session inventory, refusing uncertainty or an existing process on the same session. Update the record's pane and Herdr name. A cancelled Claude stays non-resumable.

Cold resume is disabled while the database is quarantined: refuse a gone pane before any startup effect and name `lifecycle-upgrade.mjs` in the diagnostic. Live-pane warm resumes remain available. After failed cold startup, never close a live or uncertain saved process that could accept newer work; retain the ambiguous reservation unless the created pane is positively an empty shell and the original run still owns it.

Pass the resume caller's current pane, tab, workspace and session context. If the historical workspace disappeared, use the current caller's placement instead. Definite pane-creation rejection remains retryable; genuinely ambiguous creation retains its reservation. Do not accept a warm retry while an earlier cold launch remains unpublished or unresolved.

Managed ownership follows stable agent/session identity, not the parent's disposable pane. Rebinding a parent's pane transactionally updates its local children's completion destinations. Remote completion delivery resolves the caller's stable session and machine identity across obsolete pane keys; legacy records remain scoped to their originating host. An explicit resume adopts the agent under the current caller, so a resumed orphan is not immediately cancelled again. Adoption, follow-up run compare-and-swap and publication commit in one transaction; a losing resume leaves ownership and notice routing unchanged.

## 2. `parked` state

Closing the pane of a finished run on purpose records the agent as `parked`, not `failed` ("The Herdr pane closed before the agent finished", `worker.ts`). A pane that dies during a run still fails it. `get_subagent_result` and `/activity` show parked agents as finished and resumable.

## 3. Reaper

In the existing lease-based maintenance loop, close a child's pane when all hold:

- its current run is terminal,
- it has been idle at least `idleCloseSeconds` after acknowledgement, or **four times** that timeout if its completion notice remains unacknowledged (default 900/3600 seconds; `0` disables both). The timeout is recorded from the launching parent's configuration and retained across resumes so other runners cannot replace its policy. The result and pending notice remain durable after closing the pane,
- it is not pinned,
- the pane is positively reported unfocused (missing focus metadata refuses cleanup),
- Herdr positively reports the live agent `idle` or `done`; a terminal managed run alone does not prove idleness, because a manual follow-up can still be running. Observed work or focus resets the idle clock,
- its pane still runs the agent's own session,
- its saved session and original directory are available for cold resume. Pi entries must form a valid tree with loadable message/context structure; reconstruct context with Pi's public session loader rather than accepting JSON syntax alone. Unverifiable or corrupt sessions refuse cleanup.

Independently, when the owner's session ended, cancel its running children and close its children's panes, pinned or not, subject to cold-resume safety. Confirm a missing parent through Herdr's alias-resolving pane lookup: moving a parent changes its listed pane ID without ending its session. An intentionally parked parent conversation still owns its running children; parking is not session termination. Missing or failed identity observations do not prove owner death. A remote parent identity must not be compared against the child's remote pane list.

Implementation limitations: remote owner-session termination has no verifiable cross-machine identity observation, so remote children receive idle cleanup only. Active Claude owner-gone cleanup is also excluded: cancellation would permanently disable resume, conflicting with the safety invariant. Cancelled Claude conversations always remain non-resumable. Older records missing their original directory or saved session evidence are preserved rather than guessed.

Mixed-version databases remain quarantined until an operator explicitly confirms every old parent, child, remote stdio worker and other installation sharing the database has exited or reloaded. Old commands, execution events and results continue normally; no elapsed quiet interval or new-worker heartbeat automatically enables lifecycle. Fresh databases assume all-new workers. Unknown legacy SQL writes revoke activation; intentional-close recovery cannot be settled as an old maintainer's generic pane-death failure. The `lifecycle-upgrade.mjs` CLI provides read-only status and explicit post-drain activation; confirmation must not be used while an old worker remains, or followed by restarting an old installation.

All resume and close effects serialize through the placement lock and check the current run. Maintenance checks its lease before external effects; failed or stale observations never authorize closure. Refresh focus, live status and session identity immediately before closing, after expensive readiness/database checks; do not reuse the initial pane-list snapshot. Persist close intent before issuing the pane close: a child can reap its own pane and die before the CLI call returns. Another maintainer completes or rolls back that intent after observing the pane; never claim closure after a failed command without confirmation.

## 4. Pinning

`Agent` takes `keep: true` (also an agent-file key) to exempt the agent from the idle rule, both standalone and through the combined subagent engine. Explicit `keep: false` overrides an agent-file pin. Pinning persists across resumes; it does not exempt an agent from confirmed owner-session termination.

## Tests

Close an idle finished agent, then resume it cold and get a result from the same conversation; running, pinned and focused agents stay. Unacknowledged agents stay through the normal timeout, then close only after four times that timeout without losing their result or pending notice. A manual follow-up still working after focus leaves also stays. Owner-session termination closes and cancels safely; moved parents and parked parents with running children do not trigger orphan cleanup. A pane dying mid-run still fails the run. Test explicit and agent-file `keep` through the combined engine entry point, unknown observations, invalid cold sessions, concurrent resume/close, and cancelled Claude refusal. Cover resumed-parent child ownership and notice routing, explicit orphan adoption, ambiguous cold startup followed by a warm retry, renamed live agents, focus/status/session changes during readiness, deleted historical workspaces through the public wrapper, and parseable sessions rejected by the real Pi loader.
