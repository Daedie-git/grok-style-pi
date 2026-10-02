# Implementation review

A fresh adversarial reviewer inspected all working-tree changes, including untracked files, against the proposal and repository rules. Session metadata confirmed `openai-codex/gpt-6.1-sol` with reasoning `high`.

## Findings addressed

- **Medium: stale argument-only headers.** Pi can mutate a tool's argument object in place. The shell previously refreshed its saved summary only when object identity changed. It now tracks whether a result projection exists, refreshes argument-only summaries on every call callback, and preserves result-derived summaries afterward. A regression test covers Agent and grep in-place updates.
- **Low: inaccurate factory-execution assertion.** Pi executes a replaceable native extension's factory before deciding to drop its registrations. The current-Pi smoke test now counts native and styled factory executions, expecting one native execution and one styled execution only when styling is enabled, with exactly one surviving codemode registration. The proposal states that actual guarantee rather than claiming that only one factory executes.

The reviewer found no additional documented-standard violations or actionable maintainability concerns. It independently passed the complete test gate, subagent and bat suites, the benchmark, and the Pi 1.0.0 smoke test before these corrections. It did not test live Herdr panes, an interactive current-Pi session, or model-backed codemode calls.

After applying the corrections, `npm test` passes with 290 tests passed and 2 optional tests skipped; the instrumented Pi 1.0.0 smoke test passes.

## Startup configuration correction

A subsequent user report showed tool conflicts because both alternative entrypoints were configured. A public Pi loader reproduction produced the same eleven conflicts. The user's package configuration now retains the package with `extensions: []`, while its explicit subagent entrypoint remains enabled. A real resource-loader check of the saved package/extension settings passes without extension errors. README migration instructions explicitly describe this setup. Pi's notice about replacing its native codemode extension is separate from the duplicate-entrypoint errors.
