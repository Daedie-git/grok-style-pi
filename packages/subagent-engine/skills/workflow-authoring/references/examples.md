# Workflow examples

Each script below is complete. Pass `args` through the tool's `args` parameter.

## 1. Investigate several modules in parallel, then synthesize

```js
export const meta = {
  name: "module-survey",
  description: "Survey up to 16 modules for error handling, then summarize common gaps.",
  maxAgents: 17,
  maxConcurrency: 4,
  phases: [{ title: "Survey" }, { title: "Synthesize" }],
};

const modules = args?.modules;
if (!Array.isArray(modules) || modules.length === 0 || modules.length > 16) throw new Error("args.modules must contain 1–16 paths");

phase("Survey");
const findings = await parallel(modules.map((path, i) => () => agent(
  `Read the module at ${path} (absolute path). List how it handles errors: thrown errors, ignored rejections, ` +
  `missing checks. Report file:line references. Do not edit anything. (survey ${i})`,
  { label: `survey ${path}`, agentType: "explore" },
)));

const failed = modules.filter((_, i) => findings[i] === null);
phase("Synthesize");
const summary = await agent(
  `Here are per-module error-handling notes:\n\n` +
  modules.map((path, i) => `## ${path}\n${findings[i] ?? "(survey failed)"}`).join("\n\n") +
  `\n\nWrite a short summary of the common gaps, ordered by severity.`,
  { label: "synthesize" },
);
return { summary, failedModules: failed };
```

## 2. A pipeline with a structured verification stage

Each target is investigated, then independently verified. A `null` result from the first stage skips that target's second stage.

```js
export const meta = {
  name: "find-and-verify",
  description: "Investigate up to eight targets and independently verify each finding.",
  maxAgents: 16,
  maxConcurrency: 4,
  phases: [{ title: "Find" }, { title: "Verify" }],
};

if (!Array.isArray(args?.targets) || args.targets.length > 8) throw new Error("args.targets must contain at most eight targets");

const verdictSchema = {
  type: "object",
  properties: {
    confirmed: { type: "boolean" },
    explanation: { type: "string" },
  },
  required: ["confirmed", "explanation"],
  additionalProperties: false,
};

const results = await pipeline(
  args.targets,
  (target, original, i) => agent(
    `Investigate ${target.path} for: ${target.suspicion}. Report a concrete finding with file:line, ` +
    `or reply exactly NONE if there is nothing. (target ${i})`,
    { label: `find ${i}`, phase: "Find" },
  ).then((text) => (text && text.trim() !== "NONE" ? text : null)),
  (finding, target, i) => agent(
    `Independently check this claimed finding in ${target.path}. Reproduce it if you can.\n\n${finding}`,
    { label: `verify ${i}`, phase: "Verify", schema: verdictSchema },
  ),
);

return args.targets.map((target, i) => ({ path: target.path, verdict: results[i] }));
```

## 3. Parallel edits in isolated worktrees

```js
export const meta = {
  name: "apply-renames",
  description: "Apply up to eight independent renames in separate worktrees and report the branches.",
  maxAgents: 8,
  maxConcurrency: 4,
  phases: [{ title: "Edit" }],
};

if (!Array.isArray(args?.renames) || args.renames.length > 8) throw new Error("args.renames must contain at most eight renames");

const outcomes = await parallel(args.renames.map((rename, i) => () => agent(
  `In this repository, rename ${rename.from} to ${rename.to} everywhere it is used, then run the tests that ` +
  `cover it. Report what changed, the test result, and any problems. (rename ${i})`,
  { label: `${rename.from} -> ${rename.to}`, isolation: "worktree" },
)));

return args.renames.map((rename, i) => ({ ...rename, report: outcomes[i] ?? "failed" }));
```

The completion notice names each kept worktree and its branch. Review the branches before merging them.

## 4. Re-using a saved workflow as a step

```js
export const meta = {
  name: "survey-then-plan",
  description: "Survey up to 16 modules, then plan fixes for their top gaps.",
  maxAgents: 18,
  maxConcurrency: 4,
};

const survey = await workflow("module-survey", { modules: args.modules });
return await agent(
  `Plan fixes for the most severe gaps in this summary. Give an ordered list with files to change.\n\n${survey.summary}`,
  { label: "plan", agentType: "plan" },
);
```

## Resuming after an edit

Suppose example 1 finished, but you want a different synthesis. Edit only the final `agent()` prompt in the saved script at `scriptPath`, then call `Workflow` with that `scriptPath` and `resumeFromRunId` set to the first run's id. The survey calls are unchanged, so they return their saved results instantly; only the synthesis runs again.
