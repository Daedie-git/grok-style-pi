# Structure cleanup

Goal: real package boundaries, a smaller `Engine`, behavior-organized tests, and a readable README, with no user-visible behavior change. Each step is one commit and must pass `npm test` plus the subagent suite from `AGENTS.md`.

## 1. Package entry points

Today 8 root files under `src/`, `extensions/` and `integrations/` import package internals:

| Root file | Internal import |
|---|---|
| `src/extension.ts`, `extensions/install.ts` | `subagent-engine/src/child-context.ts` |
| `src/subagents/adapter.ts`, `workflow-activity.ts` | `subagent-engine/src/engine.ts` (types) |
| `src/subagents/result-style.ts` | `herdr-subagents/src/herdr/policy.ts` |
| `src/herdr/*-entry.mjs` | `herdr-subagents/src/herdr/*-entry.mjs` |
| `integrations/subagents.ts` | engine `extension.ts`, `engine.ts`, `backends/herdr.ts`; herdr `extension.ts`, `backend.ts` |

The packages leak too: `subagent-engine/src/backends/herdr.ts` imports `herdr-subagents/src/herdr/backend.ts` types through the sibling directory layout.

Steps:

1. Add `packages/subagent-engine/src/index.ts`. It re-exports everything `src/extension.ts` exports today (including the runtime `Engine` and `inChildContext`), plus `HerdrBackendAdapter` and the types `AgentSnapshot` and `EngineEvent`. `child-context.ts` stays a second public entry, because `extensions/install.ts` needs `inChildContext` without loading the engine.
2. Add `packages/herdr-subagents/src/index.ts`. It re-exports everything `src/herdr/extension.ts` exports today (`remoteWorkerEntry`, options, `HerdrBackendHandle`, `HerdrBackendRequest`, `HerdrBackendNotice`, and the rest), plus `EXPLICIT_SUBAGENT_REQUEST`. The two `.mjs` entry files stay public as worker entry points.
3. Point `package.json` `exports` at the new index files, with subpaths for `child-context` and the worker entries. Add a test that checks every previously exported name still resolves.
4. Replace the engine's sibling import with an engine-owned structural port for the Herdr backend types. The engine then has no dependency on `herdr-subagents`.
5. Rewrite the root imports to the public entry files. Keep relative paths: `pi install <git>` runs `npm install` and links workspaces, but local-path installs are not shown to.
6. Add `test/package-boundary.test.ts`, modeled on `no-patch.test.ts`. Root `src/`, `extensions/` and `integrations/` may import only public entry files, and neither package may import the other's `src/`.
7. Split `herdr-integration`, `herdr-worker-warnings`, `subagent-contract` and `workflow-activity`. Package-owned cases move to that package's `test/`; Grok integration cases stay at the root and use public entries.

## 2. Split `Engine`

`packages/subagent-engine/src/engine.ts` is 1,604 lines. `Engine` keeps its public methods as a facade, so `src/subagents/adapter.ts` and the tools stay unchanged. Each collaborator owns its state and reaches the others through narrow ports. Extract one collaborator per commit:

1. **`herdr-bridge.ts`**: the "Herdr panes" section and `paneRuns`. It changes run records only through the run ledger's port.
2. **`run-ledger.ts`**: the `runs` map plus the per-run state coupled to it: `runAborts`, `cancelFailed`, `prevented`, `stopHookAttempted`, `foregroundWaiters`. It also owns `trackRun`, `settle`, `settleRun`, `stopFenced`, `cancelRun` and `resendFailedStops`. `spawn` and the Herdr bridge register and mutate runs only through this module.
3. **`delivery.ts`**: `outbox`, `receiptCursor`, `delivering`, `route`, `reconcileReceipts`, `ackNotices`, plus the "Root delivery" section.
4. **`continuation.ts`**: `dispatchEnvelope`, `startContinuation`, `awaitConversationReport`, `wake`, `launch` and `sessionSpec`. These are the launch and resume paths that `spawn` and `sendMessage` share.
5. **Workflow bookkeeping** (`workflows`, `emitWorkflowProgress`, `recordWorkflowCompletion`, `userStopWorkflow`, `outputTokens`) moves into `workflow/`.

Invariants:
- Inbox identity stays shared through `Engine.inbox`.
- `Control` transactions stay synchronous.
- Collaborators survive reload adoption: they read the current root binding and runtime deps through `Engine` accessors and never capture `ctx`, `pi` or installers.

`spawn` stays in `Engine` as orchestration over these modules. There is no line-count target. Done means each Engine field above has exactly one owning module. Decide afterwards whether `herdr-subagents/src/herdr/runner.ts` (1,232 lines) needs the same treatment.

## 3. Tests by behavior

1. Fold the `regressions`, `review-regressions` and `rereview-regressions` tests (root and engine) into the test file of the module each one covers. Delete a test only if it duplicates another.
2. Make the project-memory fixtures hermetic. With `TMPDIR` inside a Git checkout, fixtures currently resolve as a Git subdirectory. Allocate fixture roots in a verified location with no Git ancestor. Do not add a `.git` boundary: it would collapse the non-Git nested-directory identities that `test/project-memory.test.ts` covers. Verify the memory suites with `TMPDIR` set inside the checkout.

## 4. README

`README.md` stays the behavior spec (per `AGENTS.md`), but gets restructured:

1. Replace `/home/aim/git/grok-style-pi` with a generic clone path.
2. Split each surface into short paragraphs or lists, and keep the "What you get" table as the index.
3. Move internals the user won't act on (worker deduplication, `UNDICI-EHPA` suppression, the `bat` theme cache, layout reuse) into `docs/internals.md`. It's developer-facing and stays out of `package.json` `files`.

## 5. Package scope (decision for Bjorn)

The theme package also ships the tool guard, project memory, `/fast`, Codex/xAI usage scraping, Cursor and `compile_commands` integration, and both subagent packages. Options:

- **A. Keep one package** and redescribe it as a Pi toolkit. It only needs README and `package.json` text changes.
- **B. Split** the tool guard, memory and `/fast` into workspace packages next to the subagent ones, and make `extensions/index.ts` compose them. This touches entrypoints, `files`, tests and the boundary test. Effort is unestimated.

Recommendation: A for now. Estimate B once step 1 shows what a package extraction actually costs.

## Order

1. Steps 1 and 3.2 first. They protect the refactor (boundary and export tests, hermetic fixtures).
2. Then step 2.
3. Then 3.1 and 4, in either order.
4. Step 5 waits on the decision.

Record actual effort and touched files for steps 1 and 2.1. That data replaces the estimates above.
