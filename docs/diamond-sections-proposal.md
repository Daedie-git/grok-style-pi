# Diamond section interface proposal

Status: implemented. The design below records the review-driven decisions.

Implementation: `src/tools/section.ts`, `section-state.ts`, and `section-layout.ts`; adapters in `src/tools/sections/`; shared entrypoint wiring in `extensions/install.ts`; registration forwarding in `src/tools/register-extension.ts`. Shell/write argument guidance lives separately in `src/tools/guidance.ts`.

Verification: `npm test` passes (290 passed, 2 optional tests skipped); `npm run test:subagents` and `npm run test:bat` pass. The public-SDK smoke test passes against Pi 1.0.0, covering enabled/disabled rendering, native replacement, activation defaults, sandbox execution, and session storage. The performance benchmark also completes.

Review requested with model `gpt-6.1-sol` and reasoning `high`. The reviewer could not independently verify its runtime model. It judged the projection seam promising but the original proposal not implementation-ready. The corrections below address its state, composition, diff, compatibility, and streaming findings.

## Problem and scope

Adding codemode required a new registration decorator, a tool-name check inside `wrapWithDiamondRenderer`, a partial-result exception, and tool-specific formatting inside the generic renderer. The renderer also owns expansion, mouse handling, visual preparation, caching, diffs, and source navigation. New text-oriented tool sections should not require changes to that implementation.

A section here means a tool transcript row and its expandable body, not an assistant-message section or activity-panel entry. Pi remains responsible for transcript placement and execution. This design uses same-name tool registrations with `renderShell: "self"`; it does not patch Pi internals.

The first migration covers codemode, `Agent`, `get_subagent_result`, and ordinary text bodies for `grep`, `find`, and `ls`. Read, shell, edit, write, image, and video rendering stay specialized initially. In particular, this is not a proposal to move diff selection or video playback into a generic text interface.

## Proposed external seam

Introduce `src/tools/section.ts` with one rendering-only operation:

```ts
withDiamondSection(tool, section, hooks?)
```

It returns a tool definition with only `renderCall`, `renderResult`, and `renderShell` replaced. Preserve `execute` by identity and preserve all other metadata, including fields unknown to our current Pi version. Parameter augmentation, prompt changes, write snapshots, subagent initiative restrictions, and activity wrapping are separate operations, applied before rendering decoration.

The section adapter has two projections:

```ts
type SectionView = {
	args: ToolArgs;
	result?: ToolResult;
	isError: boolean;
	isPartial: boolean;
};

type SectionSummary = {
	title: string;
	target?: string;
	detail?: string;
};

type SectionBlock =
	| { kind: "text"; text: string; tone?: "output" | "muted" | "error" }
	| { kind: "code"; text: string; language: string };

type DiamondSection = {
	summary(view: SectionView): SectionSummary;
	body(view: SectionView): readonly SectionBlock[];
};
```

These are proposed types, not a promise to expose a plugin SDK. Keep them package-internal until an external consumer actually needs them. `ToolArgs` and `ToolResult` refer to our existing renderer input types.

Both projections are synchronous and produce unstyled data. They must not perform I/O, spawn workers, return terminal escape sequences, retain Pi contexts, or mutate tool results. Absence of `result` means Pi has supplied arguments but no result yet. `isPartial` means an update rather than completion. Adapters decide what content is meaningful during that phase, so there is no `codemode` exception in the shell's partial-result handling.

### Example: adding codemode

`src/tools/sections/codemode.ts` exports one adapter:

```ts
export const codemodeSection: DiamondSection = {
	summary: () => ({ title: "codemode" }),
	body(view) {
		return [
			{ kind: "code", text: scriptFrom(view.args), language: "javascript" },
			{ kind: "text", text: nestedCallSummary(view.result?.details), tone: "muted" },
			...(!view.isPartial && view.result
				? [{ kind: "text", text: extractResultText(view.result), tone: view.isError ? "error" : "output" } as const]
				: []),
		];
	},
};
```

The script parser and nested-call formatter live in that file. They tolerate missing and malformed historical details. Calls, durations, costs, and errors continue to appear while expanded. The original result remains unchanged, including images and usage. Pi's existing handling of tool-result images remains in place; this interface does not implement image rendering.

Ordinary text adapters return no blocks for partial results or absent results, matching current behavior. Their completed body projects text content only. The Agent adapter uses `agentSummary(args)` without an additional target; the result adapter uses `Read agent result` and the existing compact agent ID. `grep`, `find`, and `ls` keep their existing verbs and compact arguments. An empty completed error gets the shared `error` body fallback. Codemode alone opts into partial progress by returning blocks for partial results.

Argument-only summaries appear immediately. Bodies first appear when Pi invokes `renderResult`; the adapter's optional result is not a promise of pre-result body rendering.

To add another text-oriented section, write an adapter and add one entry to an explicit table passed to the styling dispatcher:

```ts
const sections = {
	codemode: codemodeSection,
	Agent: agentSection,
	get_subagent_result: agentResultSection,
	grep: textSection("Searched"),
	find: textSection("Found"),
	ls: textSection("Listed"),
};
```

Do not use a mutable global registry, runtime auto-discovery, or a chain of name checks inside the common shell. Export an immutable `DEFAULT_SECTIONS` table. The core factory accepts an optional injected `sections` table, using those defaults when absent.

The compatibility dispatcher has the concrete interface `wrapWithDiamondRenderer(original, hooks?, sections = DEFAULT_SECTIONS)`. A table match dispatches directly to `withDiamondSection`, preserving execution identity. An unmatched tool uses the existing specialized renderer. Existing two-argument callers therefore get the default adapters without caller changes. With feature styling disabled, entrypoints do not call the dispatcher.

Unknown custom tools retain the legacy generic renderer unless explicitly assigned an adapter. A new text-oriented section needs an adapter and one table entry; obtaining its upstream definition is a separate registration concern.

## Shared implementation and session ownership

Extract two internal modules before migrating adapters:

- `section-state.ts` owns the common expansion state and latest unstyled summary in Pi's per-call state. Both the specialized renderer and new section shell use its ordinary-tool expansion path. Existing edit/write opening policies remain available internally; they do not widen the adapter interface.
- `section-layout.ts` owns preparation tickets, highlighting requests, diff preparation, completed-result cache keys, layout, and stale-callback rejection. Extract these mechanisms from the old renderer rather than copy them. Both paths call this module with text/code projections or the specialized renderer's existing prose/rows. Selection and source-line mapping remain in the specialized renderer.

Only this shared implementation owns expansion and layout caches. A matching adapter does not instantiate or delegate to the old renderer as a second shell.

`createGrokStyleExtension` continues creating exactly one `VisualPreparation` instance and owning its reset/shutdown lifecycle. It returns a small `GrokStyleRuntime` containing `styleTool(tool)`, which closes over the session hooks and injected adapter table. Existing callers may ignore the return value. `styleTool` applies rendering only, returning its input unchanged when styling is disabled. Activity execution wrapping remains a separate step, outside the decorator's execution-identity guarantee.

Move the existing real-Pi wiring into an entrypoint-side `installGrokStyle(pi)` helper that returns that runtime. The direct entrypoint invokes it once, then registers styled codemode with `runtime.styleTool`. The optional subagent entrypoint also invokes it once, registers codemode through the same runtime, then loads exactly one selected runner and applies `runtime.styleTool` to its eligible registrations. Do not load the direct entrypoint as a second extension. Pi imports and factory discovery stay in this entrypoint-side helper, not in behavior modules.

This explicitly fixes the current composition gap: codemode is registered before the core factory and neither its decorator nor the subagent decorator receives the core preparation hooks. The two entrypoints will each provide the complete chrome/styling setup when loaded alone, as the documented replacement-entrypoint contract requires. For Herdr, child setup remains the Herdr runner's responsibility; initializing parent chrome must not merge or duplicate runner initialization.

Standalone uses of `wrapWithDiamondRenderer` without preparation hooks keep synchronous fallbacks and create no worker. There is no undocumented per-row disposal callback: stale tickets protect replaced projections, and the existing session reset/shutdown invalidates background requests. Tests refer to those observable lifecycles, not hypothetical row disposal.

## What the deep module owns

`withDiamondSection`, using that shared implementation, hides the following behavior behind the small interface:

- A single diamond header, common failure prefix, semantic coloring, and terminal-width-safe truncation. Title, target, and detail are sanitized before applying colors.
- Per-call expansion state shared by call and result renderers through Pi's documented context state. Every migrated adapter starts collapsed. Do not key state by tool name: concurrent calls need independent state.
- Collapsed sections show only the header. A normal click on the header or text body toggles expansion; Ctrl-click remains unhandled. Ctrl+O changes the local state only when Pi's global expanded flag changes. Without shared state, use that flag as the rendering fallback.
- Partial updates always update the current summary projection, but only build the body when open. A closed codemode section does not format or highlight its script or nested-call list.
- An initial call renders the argument-only summary. The result renderer records the latest summary projection in per-call state; the header reads it dynamically, including when collapsed. Do not retain the whole result in header state. This supports future completion summaries without requiring a tool-specific state field.
- Sanitization, text wrapping, empty-block removal, block separators, and syntax highlighting through the existing bounded `VisualPreparation` module. Adapters cannot inject styled ANSI or custom mouse handlers.
- Completed-layout caching by per-call owner, arguments, content, details, expansion, error/partial state, width, and current theme/style colors. Completed content/details are treated as immutable, matching the current cache contract. Do not cache partial results or partial summary projections, since Pi may mutate their details in place. Recompute the summary on every result callback, even when collapsed.
- Background preparation request ownership and stale-callback rejection. Reuse the existing session-owned preparation instance and its reset/shutdown behavior; do not start another worker per adapter.

The module owns ordinary text-body clicks only. Source-line mapping, read backgrounds, Ctrl-click file opening, Alt-click diff collapse, created-write statistics, default-open edits, and media lifecycle remain behind their existing specialized interfaces.

### Diff composition, not renderer fallback

After projecting a completed body, the shared layout module appends the existing colored rows extracted from `result.details.diff` or `patch`, exactly as the current generic renderer does. This is internal result handling, not a new adapter block type. It runs only for open, completed views and uses the existing diff palette and preparation logic. The section shell remains the sole owner of expansion and clicks.

Consequently an Agent/custom text result can still show its colored diff, and codemode can show JavaScript, nested calls, output, and colored diff rows together. Changing the same call from text to diff and back never changes its shell or expansion state. No source-navigation capability is added to adapters; these migration candidates previously had no file-row navigation. Preserve existing error behavior, including diffs if present. If extracting this shared layout proves too invasive, defer the migration rather than delegate between two stateful renderers.

The projections are in-process computation. Visual preparation is an existing local dependency injected through hooks. Pi tool and context contracts are third-party dependencies: use documented interfaces and test stand-ins, plus a smoke test with the current public codemode factory.

## Registration is a separate seam

Presentation cannot eliminate the need to obtain a tool definition from its owning extension. Codemode is a Pi extension factory rather than a `create*ToolDefinition` export, and subagents have their own factory.

Replace the duplicated factory-interception mechanics in `registerStyledCodemode` and `registerStyledSubagents` with a small helper:

```ts
registerToolExtension(pi, factory, transformTool)
```

This helper passes through the extension interface, intercepts `registerTool`, and registers the transformed definition. It does not know about diamonds, features, optional factories, tool names, or subagent policies. Those decisions remain at the caller:

- Codemode constructs and executes the public factory only when styling is enabled and the export exists. Transform its codemode registration with `runtime.styleTool`; forward any other tools unchanged. Preserve the factory's inactive default, model-only exposure, grammar, loadout preparation, and session store. When styling is disabled, do not construct or execute another codemode factory: rely on Pi's native built-in loading, which requires an entrypoint-level current-Pi test rather than a no-registration unit assertion.
- Subagents always load their selected runner; first apply `withoutSubagentInitiative`, then apply section styling only when enabled. Herdr and Pi Subagents remain separate runners.
- Real Pi factory discovery stays in entrypoints. Tests inject factory stand-ins. Do not add a dependency on an installed Pi path.

This helper consolidates an actual duplicated operation without pretending that all factory lifecycles are identical.

## Migration order

1. Extract shared expansion and preparation/layout/cache ownership while keeping existing rendering behavior. Prove this mechanical step with existing regression and performance tests.
2. Add `withDiamondSection` and the ordinary-text/codemode adapters. Implement completed diff composition through the shared layout, with one shell and one expansion state.
3. Return `GrokStyleRuntime` from the core factory and introduce the entrypoint-side installer. Verify direct, Pi Subagents, and Herdr entrypoints each initialize core chrome exactly once and share the same session hooks with styled tools.
4. Route codemode through its adapter and remove `codemodeCalls`, the codemode boolean, and the partial-result exception from the specialized renderer. Route `Agent`, `get_subagent_result`, `grep`, `find`, and `ls` through the explicit table. Keep the compatibility dispatcher and identity guarantees for migrated tools.
5. Consolidate codemode/subagent registration forwarding; retain feature decisions and initiative restrictions at callers. Update the README's organization and entrypoint descriptions.

No user-visible behavior change is intended. Do not flatten colored diffs into text. Consider shell/read adapters later only if concrete behavior fits without widening the interface. Specialized diff navigation and media migrations are not prerequisites.

## Acceptance tests

Test through the rendering decorator and extension-registration helper, not private state fields or the adapter table implementation:

- Summary-only collapsed output; click open/close; global expansion transitions; missing-context fallback; concurrent calls remain independent.
- An adapter's body is not evaluated while collapsed. Error prefixes, narrow widths, resize, ANSI stripping, theme changes, and empty bodies behave consistently.
- Codemode shows JavaScript, nested statuses/timings/costs/errors, and final output. Partial updates show progress but not premature final output. Missing historical arguments/details never throw.
- Unchanged completed output reuses its layout. New content/details, changed args, colors, and expansion invalidate it. In-place mutation of partial details is visible. Stale asynchronous highlighting cannot update a replaced projection or a session after reset/shutdown.
- Decorations retain execution and metadata by identity, through both direct decoration and the compatibility dispatcher. Factory forwarding retains non-tool registrations and original exception behavior. Disabled styling preserves each owning extension's behavior.
- On the same call, text → diff → text preserves local-open/global-collapsed state. Codemode script + nested calls + output + diff all remain visible together when expanded.
- Entry-point composition initializes chrome/preparation once for direct, Pi Subagents, and Herdr paths. Hooks are shared, reload/shutdown resets preparation, and unavailable codemode factories preserve older-Pi loading.
- A current-Pi entrypoint smoke test records the tested version and proves native disabled rendering, decorated enabled rendering, preserved inactive default/store behavior, and exactly one surviving codemode registration. Pi runs its replaceable native factory before dropping it when styled codemode replaces it; assert one native factory execution and, only when styling is enabled, one styled factory execution. Do not claim disabled native rendering from a no-registration unit test alone.
- Existing file-navigation, selection, diff, created-write, image, and video tests stay green. Migration preserves colored diffs on any candidate that previously supported them.
- Preserve existing observable codemode and subagent tests, moving them across the new seam rather than stacking redundant tests for private formatters.
- Run `npm test`. Run `npm run test:subagents` because the registration path changes, and `npm run test:bat` if highlighting behavior changes. Smoke-test the installed current Pi factory separately without hardcoding its location in production sources.

## Risks and decisions

- The interface intentionally supports text and code only. A request for custom components, arbitrary mouse handling, diffs, or playback should trigger a separate design decision, not more optional callbacks here.
- The existing renderer temporarily remains large. This extraction improves locality for new section types; it does not claim to finish the file-renderer refactor.
- Codemode compatibility needs tests against a current Pi version as well as the repository's older development dependency. Keep version detection at the entrypoint and record which version the smoke test used.
- Summaries depending on completion require call/result ordering tests. The shell must not depend on `renderResult` having run before the first `renderCall`.
- Any growth in the proposed interface must earn its place through two concrete adapters; do not add speculative capabilities.
