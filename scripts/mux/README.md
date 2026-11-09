# Terminal hosts

The launcher runs slots in one of two hosts and sources the matching file here: `herdr` (the herdr TUI, `HERDR_ENV=1` and `HERDR_PANE_ID`) or `hc` (the Herdr app's core, `HC_TERMINAL_ID`). The innermost host wins: a herdr TUI started inside an app terminal uses `herdr`. `SIDECAR_MUX=herdr|hc` forces one. Each slot records its host in `<agent>.mux`; a sweep only judges slots of its own host.

Every backend defines `MUX_CLI`, `MUX_MACHINE_LIST` and these functions. `NAME` is the launcher's agent name; calls go to the slot's machine when `MACHINE` is set.

| Function | Contract |
|---|---|
| `mux_owner_id` | Claude's own pane or terminal ID; the owner name is `sc-` plus it, lowercased |
| `mux_list_machines [TIMEOUT]` | saved machines as `[{id, label, target, enabled}]`; fails when the host cannot list them |
| `mux_status NAME` | `idle`, `working`, `done`, `blocked`, `unknown`, or empty when absent |
| `mux_kind NAME` | `pi` or `claude` |
| `mux_session_file NAME` | the pi session file, or empty when unknown |
| `mux_runs_pi_session NAME SESSION` | true when NAME's pi runs SESSION |
| `mux_processes NAME [KIND]` | foreground processes as `[{pid, argv, cmdline?}]`; fails unless the agent is KIND |
| `mux_launch NAME KIND PANE ARGS...` | starts `KIND ARGS` (PANE empty: placed by the host) and prints where |
| `mux_prompt`, `mux_prompt_wait NAME TEXT MS`, `mux_prompt_detached NAME TEXT` | submit TEXT; wait for the turn; or `exec` a cancellable waiting client |
| `mux_wait NAME [MS]`, `mux_read NAME LINES` | wait until it stops working; print recent output |
| `mux_rename NAME NEW`, `mux_close NAME`, `mux_forget NAME`, `mux_unfocused NAME` | rename; end it and print what closed; drop cached placement; true unless the user has it focused |
| `mux_snapshot`, `mux_owner_listed OWNER CANDIDATE`, `mux_owner_presence ID` | sweep: list once into `SWEEP_PANES`; owner in that list; `alive`, `gone` or `unknown` |

hc slots are child terminals of Claude's terminal, started with `--outlive-parent` so the sweep decides when they end, and found by their `sidecar.agent` label because hc cannot rename. The app lists them under Claude; `SIDECAR_HC_PLACE=right|down|tab` gives each new one a pane beside the focused pane.
