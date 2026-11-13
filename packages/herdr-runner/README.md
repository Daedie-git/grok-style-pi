# herdr-runner

The shared core that runs Pi and Claude Code agents in [Herdr](https://herdr.dev) panes and Herdr app terminals, locally or on saved machines. It owns the coordination database (`control.sqlite`), runs and their notices, pane placement and lifecycle, remote stdio workers, and the Claude Code hook bridge.

Front-ends add tools and delivery on top:

- [herdr-subagents](../herdr-subagents/README.md): Pi extension (standalone tools, or the Grok engine's headless backend).
- [claude-sidecar](../claude-sidecar/README.md): Claude Code plugin.

Behavior, configuration and upgrade rules are documented in the herdr-subagents README; they hold for every front-end.

## Layout

| Module | Role |
|---|---|
| `runner.ts` | `HerdrRunner`: spawn, resume, read, wait, steer, cancel, maintenance |
| `store.ts`, `worker.ts`, `worker-entry.mjs` | Database client, its worker thread or remote SSH worker |
| `backend.ts` | Headless handle with a notice outbox and explicit acknowledgement |
| `client.ts`, `hc.ts`, `host.ts` | Herdr TUI and Herdr app clients, host detection |
| `child.ts` | The child side of a Pi pane run |
| `claude.ts`, `claude-hook-entry.mjs` | Claude Code children: arguments and command hooks |
| `session-ready.ts` | Read-only Pi session validation |
| `load-ts.mjs` | Loads TypeScript through jiti when installed, else Node's type stripping |

Claude Code children may run on saved machines: that machine's worker names the Node, hook entry and store their hooks use. herdr-subagents' Pi tools still launch Claude Code locally only.

The package has no required npm dependencies. Pi's session API is loaded from the Pi package when present, else from the `pi` on `PATH`; without either, saved Pi sessions never count as loadable, so their panes stay open and cold resume refuses.

## Development

```bash
npm test
```
