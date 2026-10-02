# Diamond section proposal review

Review target: the original `docs/diamond-sections-proposal.md` before its review-driven revision.

Requested reviewer: `adversarial-review`, model `gpt-6.1-sol`, reasoning `high`. The reviewer reported that it could not independently verify its configured runtime model. It made no file changes and reported 37 passing targeted tests. It did not run the complete test gate or a current-Pi smoke test.

Verdict: the synchronous summary/body adapter seam is promising, but the initial proposal was not implementation-ready. Session composition and diff handling needed concrete ownership before implementation.

## Findings and revision decisions

1. **High: session ownership and entrypoint coverage.** The core factory's preparation hooks are private; codemode and subagent decorators receive none. The optional subagent entrypoint does not install core chrome. The revision specifies a runtime returned from the core factory, one entrypoint-side installer used by either entrypoint, and render-only styling through that runtime. Preparation resets remain session-owned. It does not invent per-row disposal callbacks.
2. **High: diff fallback can split expansion state and lose codemode projections.** Delegating a section's result to a second renderer is unsafe. The revision replaces fallback with shared diff-row composition underneath projected text/code blocks, keeping a single shell and expansion owner. Same-call text/diff transitions become acceptance tests.
3. **Medium: duplicated rendering infrastructure.** Merely reusing the worker and layout function is insufficient. The revision requires extraction of shared expansion, preparation-ticket, layout, and cache ownership before adapters migrate. It removes speculative `initiallyOpen` configuration.
4. **Medium: table/compatibility interface unspecified.** The revision defines immutable default adapters, optional factory-injected tables, and `wrapWithDiamondRenderer(original, hooks?, sections = DEFAULT_SECTIONS)`. Migrated tools dispatch directly to rendering-only decoration. Both direct and compatibility paths must preserve execution/metadata identity.
5. **Medium: ordinary streaming and empty errors unspecified.** The revision makes ordinary adapters hide partial bodies, retain existing summaries, and use the common empty-completed-error fallback. It explicitly avoids promising a body before Pi first supplies a result.
6. **Medium: disabled native codemode unproven.** A no-registration unit test does not demonstrate Pi's native renderer. The revision separates factory construction from execution, avoids either when disabled, and requires a recorded-current-Pi entrypoint test for native disabled behavior, enabled decoration, activation defaults, store behavior, and duplicate initialization.

## Remaining verification

These corrections are design decisions, not implemented fixes. The reviewer has not reviewed the revised proposal. Implementation must validate shared extraction, entrypoint lifecycle coverage, current-Pi behavior, and all existing specialized rendering regressions. No production code changes are part of this proposal task.
