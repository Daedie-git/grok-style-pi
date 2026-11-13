# grok-style-pi

Pi extension that restyles the TUI. The package entry is `extensions/index.ts`; behavior lives in `src/`. User-visible behavior is `README.md` — read the section for the surface you change before editing it.

## Constraints

Stay on documented Pi extension APIs: `setFooter`, `setEditorComponent` wrapping `CustomEditor`, and same-name `registerTool` overrides with `renderShell: "self"`. Built-in tools keep Pi's `create*ToolDefinition` factories so prompt guidance and execution stay upstream. `test/no-patch.test.ts` rejects prototype patches, Pi's assistant message component, and references into the installed Pi package. Read that test for the exact tokens.

`createGrokStyleExtension` takes injected factories. Wire real Pi objects only in an entrypoint. Load exactly one of `extensions/index.ts` or `integrations/subagents.ts`.

`src/subagents/adapter.ts` owns activity run identity, subscriptions and user-stop routing through the engine's public `agentSnapshots()` and event APIs; never read Control or child sessions. `integrations/subagents.ts` always loads the bundled engine, with in-process children by default. Inside Herdr it attaches `packages/herdr-subagents` in headless backend mode for explicit pane, machine or Claude Code requests. Herdr owns pane execution and its outbox; the engine routes notices and acknowledges Herdr after a destination receipt. `packages/herdr-runner` is the core that herdr-subagents (Pi) and `packages/claude-sidecar` (Claude Code plugin) share; keep it free of Pi, Claude and Grok imports, and keep both front-ends independent of Grok sources. Its standalone entrypoint retains its own tools and explicit-request policy; load it or the combined integration, never both.

Match the existing TypeScript style: tabs, and `.ts` import specifiers.

## Adding a diamond

Route every header and body `handleMouse` through `handleDiamondClick` in `src/tools/interaction.ts`; it owns the gesture table (README, "Diamond interaction"). Do not re-implement toggle, close, or open-target gestures. Give the content a file target with `fileTarget`, and finish with `assertDiamondGestures` from `test/fixtures/diamond-gestures.ts`. `test/interaction.test.ts` fails any tool or subagent module that handles mouse input without importing `interaction.ts`.

## Verify

`npm test` is the gate (Node 22+ type stripping): strict typechecks and tests for Grok, the runner core and the standalone Herdr package. When you touch `packages/claude-sidecar/hooks`, also run `claude plugin test packages/claude-sidecar`. When you touch subagent integration, also run `node --test test/activity.test.ts test/subagent-contract.test.ts test/workflow-activity.test.ts test/herdr-integration.test.ts`. When you touch `bat` highlighting, also run `npm run test:bat`.
