# Claude Code memory parity: installed 2.1.322

## Conclusion

The installed Claude Code does have a separate model-based topic selector. The important distinction is scheduling: **normal local topic selection runs concurrently with the first main-model request, not before it as a mandatory wait**. Results are attached at a later tool/turn boundary only if already ready. A direct answer can finish without using the pending selection.

Our pre-fix `before_agent_start` awaited the selector. That was a real behavior difference and a direct message-submission gate. The regression test held the selector response pending, observed the submission hook remain blocked, and failed before the fix. The implementation now returns immediately, retains already-recalled notes in conversation history without duplicating them, and queues new escaped notes through Pi's public hidden-message API with `triggerTurn: false`. This does not steer the current response or force another turn. Pending recall is canceled when the foreground run settles.

This fixes the scheduling difference; **it does not make every other part of our system identical to Claude Code**. The remaining differences are listed explicitly below. The requested Grok default of GPT-6.1 Terra with medium reasoning remains an intentional user override, not a claim about Claude's model choice.

## Evidence, method and limits

Target: `/home/aim/.local/share/mise/installs/claude/2.1.322/claude`, Linux x86-64 ELF. The embedded source headers also identify 2.1.322.

Original artifact SHA-256:

```text
bfb3703ad5380242328459bc62ada4bde8ae7ba57c6e1eeadb9c00e08874c478
```

REA bound and identified the artifact. Its format-neutral artifact inventory covered root bytes only; it did not decode this Bun payload. We separately decoded the ELF `.bun` section at file offset 149385216, size 192470893, then the Bun trailer and 3,150 52-byte module-table records. The resulting 58,623,313 bytes of embedded sources were copied unchanged, with each source's original file offset, length and SHA-256 recorded. No Claude Code execution or live request was needed.

REA then analyzed selected exact original JavaScript files as inert text. The extracted tree identity was `c7734c8aba0ad341724335e9077960e5ff4d22008c5a3d1e452f5dce758ce7c7`. Absolute `/$bunfs/root/` imports were followed manually by their exact module names; they were not rewritten in original files.

REA parsed the smaller retrieval, maintenance, schema and storage modules. The 5.5MB shared runtime module exceeded its heap or call-stack limits on selected analyses. Its load-bearing control flow was inspected directly in the recovered original source and a TypeScript-printer-readable derivative. Those portions are **direct shipped-source observations, not a claim that REA reconstructed a complete runtime graph**.

Independent assignments covered retrieval, maintenance, official docs/release notes, and our implementation inventory. Parent verification re-read the critical selector launch, ready-only consumption, selector request and maintenance-cadence sites.

### REA evidence ledger

| Area | Parent Evidence ID | Coverage |
| --- | --- | --- |
| Original root artifact | `ev_fe8fe389e896a7cae1d5cbce36af77c41f79c43af1fa0f90360f1cbbdaa19b08` | Root ELF identity/inventory only |
| Storage/configuration | `ev_6fd94bbc8396fe7441d1b4bf780a4b691a0ec857c46280dcb1c97e079df051aa` | Seven selected sources parsed; semantics partial |
| Retrieval/engine | `ev_370d06d23aeab66012476d8d11d737178e76faa63cf15e4a94f9347aa7557349` | Engine/constants parsed; large shared runtime exceeded heap |
| Retrieval/schema | `ev_2b6de2981a9119b7bcf4203896c691a9d948b2c4a93e08878cc6ea14df24cb87` | Schema/account parsed; shared runtime exceeded stack |
| Maintenance | `ev_926b5772f6261c9d5b840e985732197edb148e1dd5f5c6efe010105e884ff5e4` | Three maintenance modules parsed; large fork runtime exceeded heap |
| Frontmatter/write provenance | `ev_9174f808cd7f00750e607c6b3ee0b2cb2f47085610e2766fb0ccb42fbeecebfa` | Both selected sources parsed; semantic graph bounded |

The parent's REA bundle is preserved as `captures/claude-memory-rea-evidence.json` (five records, about 69 MiB). Worker connections did not retain their analysis records across resume: their export attempts were empty. Worker Evidence IDs in this document and detailed reports are therefore historical tool receipts, not claims that complete portable worker graphs were saved. The exact extracted bytes, offsets, hashes, processing limits and direct control-flow findings remain preserved and reproducible.

Local reproduction material is under ignored `captures/`: `extract-claude-bun.py`, `claude-2.1.322/extraction-provenance.json`, original modules, `claude-readable/`, `claude-memory-retrieval-findings.md`, `claude-memory-maintenance-report.md`, `claude-memory-storage-findings.md`, and `claude-memory-official-docs.md`. This document retains the substantive findings independently of those scratch files.

All runtime-flag assignments, account entitlements and this user's effective Claude settings remain unobserved. Static gates establish available code and fallback defaults, not enabled rollout for a particular account. Native bytecode/source execution equivalence was not independently tested. This is a detailed investigation of the memory surfaces below, not a proof that all unselected application behavior is known.

## Retrieval and loading

### Normal selector scheduling

In `chunk-hqk3axx7.js`, the engine constructs `using It = mIi(...)` and proceeds to the main query loop. `mIi` immediately launches a promise and returns a disposable handle with `settledAt: null`.

Only after streamed-response/tool-result processing and normal attachment collection does the engine check `It.settledAt !== null && It.consumedOnIteration === -1`. Only inside that ready-only branch does it await the already-settled promise, screen the selected files, append attachments and proceed to another main-model request. The no-follow-up end-turn path returns before that point. Disposal aborts unfinished selection; an unconsumed selection also undoes its selector-history changes.

Important original UTF-8 byte offsets:

| Site | Original module | Source offset | Original artifact offset |
| --- | --- | ---: | ---: |
| Concurrent selector handle creation | `chunk-hqk3axx7.js` | 169400 | 303045047 |
| Ready-only consumption | `chunk-hqk3axx7.js` | 248206 | 303123853 |
| Selector launcher `mIi` | `chunk-3xz9wh62.js` | 3634933 | 296864289 |
| Read/surfaced screening `hIi` | `chunk-3xz9wh62.js` | 3636617 | 296865973 |

The source proves that the local selector does not gate the first main request. UI Enter acceptance and physical terminal input/display timing were not separately established from Claude's UI code.

### Activation and model request

- Requires a root/main context with a selector. Skips extraction, dream, selector, suggestion and compaction query sources.
- Local selector requires auto memory plus `bwe()`: `tengu_moth_copse` with fallback false, or nonempty `CLAUDE_MEMORY_STORES`. Account recall can activate independently.
- Uses the latest non-meta user text, skips missing text and whitespace-free trimmed text, and checks the accumulated recall budget.
- Keeps separate selector history per memory directory, initialized with available-memory metadata; it does not pass the entire main conversation as the selector conversation.
- Uses configured/default Sonnet resolution `sy()`, not the selected main model. It can try up to two other eligible Sonnet models no more expensive than the first after recognized model refusals.
- Structured JSON schema requires `selected_memories: string[]`. Prompt asks for at most five useful files and no reselection. Actual cross-results consumption also caps at five.
- Request uses a separate system prompt, `querySource: memdir_relevance`, ephemeral caching, model-specific `qJ` thinking configuration, and `max_tokens: 512 + model-dependent allowance`. It does not establish a universal fixed low/medium reasoning level.
- Truncation, malformed output, missing text, cancellation and API failure yield no selection; unknown filenames are discarded. Recognized leading type markers can be stripped.

Selector API call `z5r`: `chunk-3xz9wh62.js`, source byte 3574932. Directory/history orchestration `h1n`: byte 3573639. Model sequence `K5r`: byte 3576714.

### Candidate and body limits

- Candidates are recursively discovered topic `.md` files, not files found by following `MEMORY.md` links. Root index and configured prompt-index/skill areas are excluded.
- Metadata reads cover the first 30 lines/65,536 bytes; descriptions/types/modified values come from frontmatter, with a body-excerpt fallback for configured stores.
- Sort by filesystem mtime descending; take at most 200 candidates. Metadata listing is cached within hydrated per-directory selector state rather than rebuilt unconditionally on every query.
- Selected body previews are at most 200 lines/4,096 bytes, sanitized and accompanied by a truncation notice when appropriate.
- Already read/surfaced and invisible/disallowed files are screened again before attachment.
- Accumulated budget constant is 61,440, but the examined implementation counts JavaScript string length, despite a bytes-like constant name. Do not call it a verified UTF-8-byte limit.
- Relevant-memory attachments are tentative references: apply only if actually relevant. They are actual selected note contents, not synthesized recollection.

Source sites in `chunk-3xz9wh62.js`: candidate scan `mQe` byte 1423457; listing `$no` 1427622; bounded body reader `BCe` 1553247; selection/read orchestration `N3r` 3632744.

### Index mode is distinct from selector mode

Legacy local loading reads `MEMORY.md` during instruction/prompt assembly. `ZRr` trims and bounds content to 200 lines and 25,000 JavaScript string-length units, cutting at a newline where possible and adding a warning.

When `bwe()` selector mode is enabled, `fCe`/`xcs` drop the personal `AutoMem` index body from automatic main-context injection. Memory guidance uses a `skipIndex` variant. Configured connected stores can still supply separate `promptIndex` references; the personal-index rule is not a universal ban on every store index.

Agent-definition memory is another path: `Gl` reads/injects that agent's own capped index, with regular-file/read-only policies.

### Separate account/Cowork wait

`KHi` in `chunk-63jhg47p.js` can return a promise the engine does await before the first main request. It handles account/Cowork memory-context snapshots, not normal local topic selection. Qualifying waits are bounded at 5 seconds initially or 2 seconds otherwise; timeout/abort returns what is available. `CLAUDE_CODE_MEMORY_CONTEXT_NO_WAIT` removes an applicable ordinary hosted wait. This must not be cited as evidence that local topic recall blocks submission.

## Saving and frontmatter

Shipped save prompts explicitly require:

```yaml
---
name: short-kebab-case-slug
description: Specific one-line relevance description
metadata:
  type: user | feedback | project | reference
---
```

For feedback/project content, structure is rule/fact, then **Why:** and **How to apply:**. Top-level `type` is accepted by normalization for compatibility, but explicit nested `metadata.type` wins. Canonical rewrites can add `metadata.node_type: memory`.

Legacy index mode instructs a topic file first, then one index pointer of about 150 characters, never memory content or frontmatter directly in `MEMORY.md`. Selector-mode prompts use the skip-index variant. Both instruct checking existing topics, avoiding duplicates, keeping metadata accurate, organizing by topic, and updating/removing stale notes.

Eligible information includes durable preferences, feedback (including useful confirmations), non-code project context and references. Exclusions include facts recoverable from code/Git/instruction files, ephemeral task details, and generic debugging recipes. Explicit save requests do not override exclusions.

Built-in Write/Edit stamp ISO `modified` provenance in **root auto-memory** frontmatter. The verified gate resolves the root auto-memory directory, not ordinary definition-scoped `agent-memory` folders; those folders are not automatically stamped unless a user deliberately overlaps the configured root. Our earlier claim that scoped-agent stamping was a parity gap was incorrect. Eligible personal canonical rewrites also add `metadata.originSessionId`; unsafe/ambiguous YAML can receive a minimal timestamp patch or no stamp plus warning, rather than a destructive rewrite. Generic filesystem writes are not equivalent to the instrumented tools. Team paths have distinct provenance handling.

Sources: `chunk-nggxamet.js` normalizer `Sf` byte 89329, serializer `Zbo` 90138, template `ml` 90683, save prompt `on` 113061; `chunk-3ckgsfpg.js` `BDt` 5963, personal rewrite `oe` 7349, faithful timestamp patch `un` 15301.

## Extraction: distinguish local files from hosted memory

### Local file extraction

- Post-turn/root-only work, normally launched without awaiting it. Requires rollout gate `tengu_passport_quail` (fallback false), enabled memory, read-boundary eligibility, and no remote controller. Noninteractive mode has an additional opt-in gate.
- Default cadence is **one eligible turn end**, through `tengu_bramble_lintel ?? 1`, not the hosted five-turn default.
- Skips/advances the cursor when the foreground already wrote memory or there is no eligible new user prose. Ordinary file prose requires at least three whitespace-delimited tokens.
- Permission deny/ask rules that cover memory Write/Edit cause a skip instead of prompting.
- Fork receives the parent system/context/messages and an instruction to consider only the new-message window. This is a model instruction, **not physical removal of all older messages/tool data from the request**.
- Prompt prohibits source/Git investigation to discover memories, directs parallel reads then writes, and says to save nothing if nothing qualifies.
- Actual local fork has five model turns, even though the prompt encourages a two-stage read/write plan.
- Coalesces concurrent turn ends; can run trailing work rather than concurrent extraction. Successful work advances a cursor and resynchronizes parent read-file state; errors can still report writes already completed.

### Hosted CCR/MCP extraction

This is a separately configured path, not the universal local-memory implementation. It requires parsed `CLAUDE_CODE_POST_TURN_MEMORY` and a valid configuration/instruction, mounted memory service/write tools and additional permissions/session gates.

Defaults: every five turns; four fork turns; 120-second idle flush; minimum one pending turn for idle flush. Cadence range 1–100; fork-turn range 1–8; idle seconds 0–86,400 (zero disables). The synchronous override forces cadence one and idle flush zero.

Additional configuration includes prose gates (legacy or script-aware chat), word threshold, review window, overage behavior (run/first-look/skip), optional classifier mode (off/shadow/enforce), transport variants, task declaration and restart carry-over. The existence of a schema field is not proof that every optional trial adapter executes in this build.

The first-look classifier has its own supplied instruction, structured boolean verdict, default 12,000-character budget, 20-second deadline, zero retries and small output allowance. It uses an explicit configured model or small-fast helper resolution (`ANTHROPIC_SMALL_FAST_MODEL`/provider defaults), not the extraction fork's inherited model. Enforced negative verdict can skip extraction; errors proceed; shadow does not block the pass.

Hosted write tools reject stale work when a newer user prompt arrives. Optional task registration links cancellation; retry/cursor handling differs from local-file extraction. Idle flushing checks that the prompt index still matches and no pass is running.

Source: `chunk-fnsjc1bp.js` runner `mzo` byte 23353; local fork request in original line 22; hosted configuration in `chunk-x22hm4b2.js` byte 57160 onward. Root post-turn invocation is `fu` in `chunk-hqk3axx7.js` byte 92917.

### Model and permissions

Extraction/dream forks inherit the parent model/options at these call sites. They do not explicitly pin a low-effort helper model. The optional first-look classifier and topic selector are separate model requests with different resolution rules.

Local fork tools are permission-gated, not simply unrestricted tools or our exact private four-tool set. They can use approved reads/search and classified read-only shell operations; writes are confined to eligible Markdown under the memory root, with narrowly parsed deletion. Hook confirmation, MCP/arbitrary tools and unsafe writes are rejected. Input privacy is primarily prompt policy plus the ordinary write stack, not a guarantee that secrets were removed from all inherited fork context.

## Dream/consolidation

- Rollout gate `tengu_onyx_plover` must make the feature enabled/available before `autoDreamEnabled` can apply. Setting true does not bypass unavailability.
- Checked after root turns, not a daily daemon. SDK entrypoints, remote controller, disabled memory and read-boundary restrictions can suppress it.
- Defaults: at least 24 hours and five other distinct modified sessions since consolidation. Finite positive rollout values can override thresholds. Eligible session scans are throttled to ten minutes.
- Creates a cancellable dream task, uses parent fork context, and has no explicit max-turn override at the call site; shared fork default is **50**, not our five-turn maintenance budget.
- Phases: inspect notes/index, narrowly investigate relevant transcript topics, consolidate/update/prune, repair the index. Do not exhaustively read every transcript by default. Normalize relative dates and handle contradictions with current maintained instructions explicitly.
- Team memories have additional conservative pruning/promotion rules; private facts are not automatically promoted into team scope.
- Local `.consolidate-lock` uses PID/mtime, a one-hour live-holder horizon, write/recheck, and rollback on failure/cancel. It is **not an atomic exclusive-create lock**. Successful acquisition's timestamp serves as consolidation time; a failed rollback can defer the next attempt.
- Some item-record/trial branches are dormant in this build; their literals alone do not establish active behavior.

Sources: `chunk-qg0pk0m6.js` gate `CAt` byte 1437, prompt `Q` 3912, thresholds `fe` 8056, eligibility `he` 8340, runner `wni` 8467; `chunk-th3ec2q4.js` timestamp `uCt` 1150, acquisition `L` 1455, rollback `C` 2043.

## Storage, controls and scope

- Normal local auto memory defaults **on**. Effective false settings disable it; true does not override every safety/session condition.
- Safe, restricted and diskless modes are stronger guards. In-session memory-off flags are also checked. True-like `CLAUDE_CODE_DISABLE_AUTO_MEMORY` disables; false-like values force on against some ordinary defaults/simple-mode conditions, not every stronger guard.
- Directory resolution prefers a valid cowork override, then configured `autoMemoryDirectory`, then default project storage.
- Configuration precedence: policy, command-line settings, eligible trusted local/project settings, then user settings. Repository-controlled directory values are part of the trust boundary and can be forbidden under outside-working-directory read restrictions.
- Default root is `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<project-key>/memory/`, with a separate remote-memory base override.
- Normal Git worktrees/subdirectories share memory through validated common-repository identity. The `.git`/`commondir`/reciprocal `gitdir` chain is validated; it is not an unconditional arbitrary pointer follow.
- Default project keys sanitize paths; only long keys receive a hash suffix. `CLAUDE_CODE_PROJECT_DIR_NAME`, combined with the required qualifying config mode, permits an explicit 1–64-character project key and intentional cross-project sharing.
- `type: user` alone does not make a topic globally scoped. Agent-definition memory and account/team/mounted stores are distinct facilities.

Sources: `chunk-x22hm4b2.js` `Oh` 61517, `Cae` 61596, `gy` 62073, `hy` 63655, resolver class `Pc` 63999, index path `n7` 65786; `chunk-a3hv1nqm.js` validated worktree `dr` 74797 and canonical root `zi` 75562; `chunk-wc9gesh6.js` key `VL` 12398, explicit-key helper `uR` 13204; `chunk-e3ykepp4.js` config directory and explicit-key validation.

## Remaining parity differences

| Surface | Installed Claude behavior | Our current behavior / required follow-up |
| --- | --- | --- |
| Selector scheduling | Concurrent; ready-only attachment at later boundary | Blocking gate fixed; hidden Pi message queued without steering. Legacy transient system-only snapshots are eligible for reselection. |
| Selector/index modes | Rollout-gated selector replaces legacy personal index injection | We currently combine index injection with selector-generated hidden reference messages. Needs explicit mode design, not a claim of exact parity. |
| Candidate metadata | Bounded prefix reads; hydrated per-directory listing | Our candidate scanner reads full bounded topic files and rescans for queries. Needs matching prefix/cache behavior. |
| Local extraction cadence | Eligible turn-end fallback one | Ours uses five-turn/120-second behavior borrowed from the hosted-style path. |
| Fork context | Parent-context fork with prompt-directed window | Ours is a separate bounded prose-only private loop. Safer/minimal input, but not identical. |
| Dream budget/review | Fork default 50, targeted transcript investigation | Ours caps five turns and reviews bounded preselected prose tails. |
| Root write provenance | Timestamp/origin/node metadata from Write/Edit wrappers in root auto-memory | Our root foreground writes do not implement all equivalent stamping. Ordinary definition-scoped writes do not need it for parity. |
| Definition-scoped enablement | Scoped indexes and additional Read/Write/Edit follow the master memory setting | Aligned: combined integration shares the master switch; disabled creation omits indexes/grants; live memory-only grants are revoked. Ordinary grants remain independent. |
| Worktrees | Shared validated repository memory | Ours separates worktrees. |
| Enablement | Normal local default on, richer policy/session gates | Ours default off plus a separate explicit directory grant for automatic access. |
| Directory configuration | Configurable memory root and explicit project-key override | Ours resolves a fixed private per-project store. |
| Models/effort | Sonnet selector; extraction/dream inherit parent options | Ours intentionally uses configurable GPT-6.1 Terra/medium per user request. |
| Account/team stores | Additional transports, scopes, gates and snapshot waits | Not implemented by our local project-memory feature. |
| Safety/concurrency | Validated paths/ordinary permissions; local dream write/recheck lock | Ours uses stricter private Markdown tools, mutation queue, compare-and-swap and exclusive lock. Keep safety differences explicit rather than weaken them blindly. |

The immediate latency fix should not be represented as completion of all these items. A full parity implementation needs an explicit local-vs-hosted-vs-account scope, matching scheduling/metadata and mode semantics, and tests at the actual Pi model-request boundary. Proprietary provider/rollout behavior cannot simply be copied or claimed enabled from static literals.

## Definition-scoped follow-up verification

A focused second pass verified the scoped-agent path rather than extrapolating root behavior. `rEn` in `chunk-3xz9wh62.js` (source UTF-8 byte 2575645) gates the extra tools and memory guidance on `Oh() && definition.memory`. Separate scoped roots are resolved by `oSo` in `chunk-nggxamet.js` (byte 151918), recognized for permission handling by `Zf`/`Grn` (153775/154225), and rendered by `exr`/`Gl` (154288/145710).

The actual Write/Edit stamping helper `BDt` in `chunk-3ckgsfpg.js` (byte 5963) requires a `.md` path under `bY`, the root auto-memory predicate; it does not use `Grn`. Therefore we intentionally do not add automatic scoped-agent stamping. Selected-source REA Evidence: `ev_659a945476eb3c2cfe0028f85ce664018492821a2f9a0ea093d81c1de208c8f3`, both selected syntax parses complete, semantic graph bounded. Detailed source hashes/ranges are in `captures/claude-scoped-memory-metadata-findings.md`.

## Official sources and corrections

- [Memory documentation](https://code.claude.com/docs/en/memory): index/topic overview, memory categories, storage/control UI.
- [Context window](https://code.claude.com/docs/en/context-window#what-survives-compaction): memory reinjection after compaction.
- [Settings reference](https://code.claude.com/docs/en/settings-reference#automemoryenabled) and [environment reference](https://code.claude.com/docs/en/env-vars#variables): enablement and directory controls.
- [Memory index errors](https://code.claude.com/docs/en/errors#memory-index-is-over-its-read-limit): loaded-content limits, reminders and successful-but-over-limit writes.
- [Subagent memory](https://code.claude.com/docs/en/sub-agents#enable-persistent-memory): separate definition-level scopes.
- [Official changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md): extraction-write race (2.1.77), mounted-store recall (2.1.172), restricted memory directory gates (2.1.273), structured-output recall compatibility (2.1.288).

The earlier answer that documented file-tool loading implied no selector was incomplete. The artifact establishes both mechanisms, with different activation and timing. Likewise, five-turn/120-second extraction is a real configured hosted path, not the universal local-file extraction default.
