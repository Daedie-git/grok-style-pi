# Claude Code memory parity: selector (2.1.329), retrieval mode (2.1.330)

Pi no longer has a memory system of its own. Claude Code writes memory. Pi's subagent engine reads Claude Code's personal project memory in index or selector mode (`packages/subagent-engine/src/claude-memory/`). Every Pi agent is blocked from changing Claude Code memory.

## Evidence

Read from the installed bundle `~/.local/npm/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` (Claude Code 2.1.329) as inert strings; nothing was executed except one live `claude -p` selector request to confirm the transport. Minified names are this build's and change between releases.

| Behavior | Claude Code site | Pi |
| --- | --- | --- |
| Personal memory mode: a nonblank `CLAUDE_MEMORY_STORES` or `tengu_moth_copse` selects topics; otherwise load `MEMORY.md` before the first request | 2.1.330 embedded JS byte 313867873 (gate), 314504859 (flag resolution), 323493987 (index intake); confirmed against the Fury `memories` request | `mode.ts`, `index-content.ts`, `recall.ts` |
| Selector request: system prompt `XAi`, `Available memories:` first message, `Select memories relevant to:\n\n<query>`, `selected_memories` JSON schema | `RMo`, `exi`, `OSt` | `selector.ts`: `SELECTOR_SYSTEM_PROMPT`, `selectMemories` |
| Default Sonnet: `ANTHROPIC_DEFAULT_SONNET_MODEL`, else the resolved `sonnet` alias | `HS` | `configuredSonnet`, else `--model sonnet` (Claude Code resolves it) |
| Fallback: up to 2 other Sonnet models, newest first, priced (1M in + 1M out) no higher than the first; none when `CLAUDE_CODE_NO_MODEL_FALLBACK` is set or the first price is unknown | `nxi`, `vMo`, `txi` | `selectorModels` with Pi's model catalog prices |
| Fallback only on model refusals: 404 `not_found_error` or 403 `permission_error` naming the model | `oxi`, `CMo` (`vst`, `h8e`) | `claudeCodeRunner` sets `refused` |
| Leading `[type] ` stripped from returned names; unknown names dropped | `ZAi` | `selectMemories` |
| Manifest line `- [type] file (ISO mtime): description` | `wKo` | `memoryManifest` |
| Candidates: topic `.md` files, root `MEMORY.md` excluded, newest 200, frontmatter from the first 30 lines | `wvn`, doc'd in 2.1.322 as `mQe`/`$no` | `scanClaudeMemories`, `memoryHeader` |
| Folder: `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, then `autoMemoryDirectory`, then `<config>/projects/<key>/memory/` with the Git root as key base | class `yc` `resolveEntry`, `Dh`, `QL` | `claudeMemoryDirectory`, `projectKey` |
| Key: non-alphanumerics to `-`, over 200 characters truncated plus `-` and base-36 of a 32-bit string hash | `QL`, `dre` | `projectKey` |
| Attachment text: "Retrieved for possible relevance …", per-note `Memory: <path>:` with an age warning past one day | `relevant_memories` case, `aRe`, `F6t` | `recalledMemoryText` |
| Accumulated recall budget 61,440 string units | 2.1.322 analysis | `RECALL_BUDGET` |
| Selection runs alongside the main request; an unfinished one is discarded when the turn ends | 2.1.322 analysis (`mIi`, ready-only consumption) | `before_agent_start` launches without awaiting; `agent_settled` cancels |

## Known differences

- **Transport.** Pi has no Anthropic login, so the request runs through `claude -p` with `--tools ""`, `--setting-sources user` (login, provider and gateway settings), `--settings` with hooks off and, as flag-level `env` that outranks user settings, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` (no memory index or CLAUDE.md in the request), plus `--strict-mcp-config` and `--no-session-persistence`. Claude Code completes structured output with its own tool round, so thinking and `max_tokens` are Claude Code's, not the selector's `512 + 2048` budget. Process start adds about a second, which leaves less time before the turn ends and the selection is discarded.
- **Selector history.** Claude Code keeps one selector conversation per memory folder and appends each query and reply. Each Pi request is stateless. Instead of relying on the history line "Do not re-select …", Pi leaves already recalled and already read notes out of the manifest.
- **Delivery point.** Claude Code attaches a ready selection at the next tool boundary of the same run. Pi queues it as a hidden message (`triggerTurn: false`); Pi flushes queued custom messages at the end of each turn, so it reaches the next model request in the same run.
- **Settings scope.** Recall follows managed (per platform, with `managed-settings.d`) and user settings for `autoMemoryDirectory`, `autoMemoryEnabled` and settings `env`. It ignores project and local `.claude/settings*.json`, which Claude Code applies only for trusted folders, and `CLAUDE_CODE_PROJECT_DIR_NAME`; the write guard still protects a folder those files name.
- **Rollout and stores.** Pi uses the startup disk cache (`cachedGrowthBookFeatures ?? cachedFeatureFlags`, default false); it cannot see a running Claude process's live rollout payload or its internal feature-evaluation eligibility. It never fetches remote assignments. In index mode it adds the bounded `MEMORY.md` text as user-role request context instead of merging it with Claude Code's other startup instructions. Account, team and mounted memory stores are not read; the `team/` subtree is skipped, where Claude Code shows it only while mounted (`EFe`).
- **Writes.** Claude Code's extraction and dream passes write memory. Pi has none, and blocks `write`, `edit` and shell commands that target `projects/*/memory`, the configured folder, or `agent-memory` folders. File paths resolve as Pi's tools resolve them; the shell check is best-effort text matching.
