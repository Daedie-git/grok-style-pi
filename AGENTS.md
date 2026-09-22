# grok-style-pi

Pi extension that restyles the TUI. The package entry is `extensions/index.ts`; behavior lives in `src/`. User-visible behavior is `README.md` — read the section for the surface you change before editing it.

## Constraints

Stay on documented Pi extension APIs: `setFooter`, `setEditorComponent` wrapping `CustomEditor`, and same-name `registerTool` overrides with `renderShell: "self"`. Built-in tools keep Pi's `create*ToolDefinition` factories so prompt guidance and execution stay upstream. `test/no-patch.test.ts` rejects prototype patches, Pi's assistant message component, and references into the installed Pi package. Read that test for the exact tokens.

`createGrokStyleExtension` takes injected factories. Wire real Pi objects only in an entrypoint. Load exactly one of `extensions/index.ts` or `integrations/subagents.ts`.

`src/subagents/adapter.ts` owns run identity, subscriptions, and cancellation for in-process Pi Subagents. The activity UI consumes its projections. `integrations/subagents.ts` loads `src/herdr/extension.ts` when `HERDR_ENV=1`, and Pi Subagents otherwise. Do not merge those runners. The Herdr runner does not use the adapter.

Match the existing TypeScript style: tabs, and `.ts` import specifiers.

## Verify

`npm test` is the gate (Node 22+ type stripping): strict typecheck, then `node --test test/*.test.ts`. When you touch subagent manager behavior, also run `npm run test:subagents`. When you touch `bat` highlighting, also run `npm run test:bat`.
