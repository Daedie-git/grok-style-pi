---
name: workflow-authoring
description: How to write a script for the Workflow tool, including its API, rules, resume and worked examples. Load it before writing or editing a Workflow script. It does not decide whether to run one; only run a workflow when the user asked for one.
---

# Writing Workflow scripts

A workflow is a JavaScript program that runs in the background and coordinates several agents. The host runs your script; each `agent()` call starts a real subagent. Your script decides the control flow; the host owns permissions, scheduling, retries and the journal.

Read `references/examples.md` for complete scripts before writing anything non-trivial.

## Shape

The first statement must be a literal metadata object, and nothing may be computed in it:

```js
export const meta = {
  name: "compare-parsers",
  description: "Compare two parser implementations and report differences.",
  phases: [{ title: "Investigate" }, { title: "Compare" }],
};
```

Everything after it is the body, run as the inside of an `async` function. You can use `await` and `return` at the top level. There is no `main()`, and you can't use `import`, `require`, `process`, `fs` or `fetch`. `args` holds the value passed as the tool's `args`.

## API

| Call | Returns | Notes |
|---|---|---|
| `agent(prompt, opts?)` | the agent's final text, or validated data with `opts.schema`, or `null` on failure | Options: `label`, `phase`, `schema`, `model`, `effort`, `isolation: "worktree"`, `agentType`, `disallowedTools`, `bashCommandClamp`. |
| `parallel([() => ..., () => ...])` | array in input order | Takes **functions**, not promises. Waits for all; a failure becomes `null` in its slot (never fail-fast). |
| `pipeline(items, stage1, stage2, ...)` | array in item order | Every item starts at once; each item runs its stages in sequence: `stage(current, original, index)`. Returning `null` skips that item's remaining stages; `undefined` does not. |
| `phase(title)` | — | Groups the progress display for later calls. It is **not** a barrier; nothing waits on it. |
| `workflow(name, args)` / `workflow({ scriptPath }, args)` | the child script's return value | One level of nesting only. A string is always a saved-workflow *name*, never a path. |
| `log(value)` | — | Recorded in the result (the first 1,000 messages). |
| `budget.spent()` / `budget.remaining()` | numbers | `spent()` counts session output tokens; `remaining()` is `Infinity` unless the host sets a budget. |

The value you `return` becomes the workflow's result in its completion notice.

## Rules that bite

- **Determinism.** `Date.now()`, `new Date()` without arguments, and `Math.random()` throw, so a resumed run makes the same calls in the same order. A date built from an explicit value is fine. To vary a prompt, include the index in it.
- **`parallel` wants functions.** `parallel(items.map(x => agent(...)))` starts the agents before `parallel` sees them. Write `parallel(items.map(x => () => agent(...)))` instead.
- **Await everything you need.** Work you start and don't await or return is not joined. The script can finish while that work still runs, and its result is lost.
- **Handle `null`.** Any `agent()` can return `null` (failure, stop, skipped). A workflow that "completed" can still contain `null` slots, so check and report them.
- **Write self-contained prompts.** Each agent starts fresh: it has no access to this conversation or the script. Include the goal, the relevant paths and facts, and what to report.
- **Use schemas for data, not for prose.** With `opts.schema` (a JSON schema), the agent hands back data through a tool and you get a validated object. Never `JSON.parse` free-form agent text.
- **Limits.** A run makes at most 1,000 `agent()` calls, and arrays passed to `parallel` or `pipeline` hold at most 4,096 items. Only a bounded number of agents run at once; the rest queue.
- **Agents can't delegate.** Workflow agents cannot use `Agent` or `Workflow`. Put the fan-out in the script.
- **`isolation: "worktree"`** gives that agent its own git checkout; changed checkouts are kept for review. Use it when several agents edit files at once.
- **No sandbox.** The script runs in a restricted VM, not a sandbox. Agents still use their normal tools under the session's permissions.

## Running, iterating and resuming

- **The result is a receipt.** It includes `runId`, `taskId` and `scriptPath`. You are notified when the run finishes; don't poll or sleep.
- **Stopping.** Stop a run with `TaskStop` and its `taskId`.
- **Re-running.** The script is saved at `scriptPath`. Edit it with your file tools and pass `scriptPath` to run the edited version, instead of resending the whole script.
- **Resuming.** `resumeFromRunId` re-runs the script from the top and reuses saved results for every `agent()` call whose prompt and options are unchanged, until the first call that differs. From that point on, calls run live.
  - **What stays reusable:** editing only post-processing (formatting, merging) keeps all agent work, and changing `label` or `phase` doesn't invalidate a result.
  - **What forces a re-run:** changing a prompt, an option, or the order of calls re-runs from that call onward.
  - Stop the old run first; resuming a run that is still running is refused.
- **Inline scripts need approval.** Inline and file scripts need the user's approval of their exact text. Saved workflows (`.js` files in `~/.pi/agent/workflows` or a trusted project's `.pi/workflows`) run directly.

## Quality checklist

1. **Shape.** Is the work genuinely parallel or staged? If it's one task, use a single `Agent` instead.
2. **Prompts.** Can each prompt be understood by someone who has never seen this conversation?
3. **Combinators.** Are independent tracks inside `parallel` or `pipeline`, and dependent steps sequential?
4. **Data.** Do structured results use `schema`?
5. **Failures.** Does the script handle `null` slots and say what failed?
6. **Writers.** Do concurrent agents write to different files, or use worktrees?
7. **Result.** Is the returned value small and useful? Long agent reports belong in the notice, summarised.
