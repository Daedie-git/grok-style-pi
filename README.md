# Claude Sidecar

A Claude Code plugin that runs persistent [pi](https://github.com/badlogic/pi-mono) sidecar agents on demand in Herdr panes. The reviewer remembers notes and earlier reviews, reviews plans and diffs, and returns Markdown reports to Claude.

The default model is `openai-codex/gpt-6.1-sol` with `high` thinking. pi needs authentication and access to that model.

## Requirements

- Linux, Bash, Git, jq, and util-linux (`flock`).
- Claude Code with plugin support.
- Herdr with `pane` and `agent` commands on `PATH`; start interactive Claude inside a Herdr pane.
- pi (`@earendil-works/pi-coding-agent`) on `PATH`, authenticated with the model provider.
- To run sidecars on another machine: see [Sidecars on another machine](#sidecars-on-another-machine).

The plugin does not install these dependencies. Session startup only publishes identity and usage guidance; the first task starts its sidecar. The hook skips setup outside Herdr, in headless `claude -p` sessions, or when launcher dependencies are missing.

## Develop locally

```bash
cd /home/aim/git/claude-sidecar
claude --plugin-dir "$PWD"
```

The plugin exposes `/claude-sidecar:sidecar-review` and a `SessionStart` hook. Restart Claude after changing plugin files. Runtime requests, reports, logs, locks, and session markers stay in `~/.cache/claude-sidecar`, outside the plugin checkout.

```bash
python3 -m unittest discover -s tests -v
shellcheck scripts/sidecar
claude plugin validate .claude-plugin/plugin.json
claude plugin validate .claude-plugin/marketplace.json
```

Tests use a fake Herdr and isolated home directories; they never start a real model session.

## Blocked questions

A sidecar that cannot continue without a decision submits its report with `needs_answer`. The launcher then prints `NEEDS_ANSWER: <question>` and exits 3; `sidecar answer TEXT` resumes the same task. Identical requests sent while one is in flight exit 4 instead of queueing. Requests have no deadline; a turn that ends without a report exits 2, and a sidecar blocked in its pane exits 5. A running sidecar loads the extension at start, so restart it (new Herdr pane or `sidecar restart` after ending the old pi) to gain `needs_answer`.

## Install from GitHub

This repository includes a single-plugin marketplace. In Claude Code:

```text
/plugin marketplace add Daedie-git/claude-sidecar
/plugin install claude-sidecar@daedie-sidecar
```

A private repository requires GitHub access on the installing machine. Restart Claude inside Herdr after installation.

## Migrate the existing integration

Before enabling this plugin, remove the old SessionStart hook that invokes `~/.claude/bin/sidecar session-start` from your Claude settings, and move `~/.claude/skills/sidecar-review` outside the skills directory. Otherwise both integrations may launch and Claude may choose the old skill. Keep the old files as backups until a real plugin review succeeds. The plugin reuses the existing runtime cache and live reviewer where possible.

The plugin source sets the new model default. An already-running sidecar retains its model; start a fresh Claude session in a new Herdr pane to use the new default. `restart` only replaces a pane running the wrong pi session; it does not force model changes on a matching live session.

## Use the launcher directly

```bash
./scripts/sidecar status
./scripts/sidecar note "The user approved the plan in docs/plan.md."
./scripts/sidecar plan docs/plan.md "Goals and constraints"
./scripts/sidecar diff HEAD "Intent of the implementation"
./scripts/sidecar ask "Recheck finding 2 after the fix."
./scripts/sidecar --slot 2 ask "Review the parser independently."
./scripts/sidecar --slot 3 ask "Review lifecycle handling independently."
./scripts/sidecar --slot 2 answer "Yes, keep backward compatibility."
./scripts/sidecar --slot 4 --machine laptop ask "Run the suite on the laptop."
```

Commands run against the current working directory. The diff review includes commits since the base, working-tree changes, and untracked files. Requests serialize per slot, while different slots can work concurrently. Slot 1 is the default; each slot retains its own context and pending questions across follow-ups and `/clear`. Sidecars fill Claude's current tab up to four total panes, counting every pane open in it, including Claude's and other Claude panes' sidecars. Each new sidecar halves the largest pane: first left/right, then top/bottom in each column. A full tab sends further sidecars to overflow tabs of up to four panes each; closing a pane frees its room. Reuse slots for later tasks. A blocked reviewer needs human attention in its pane.

Override the model and thinking level in the environment before starting Claude or the launcher:

```bash
export SIDECAR_MODEL=openai-codex/gpt-6.1-sol
export SIDECAR_THINKING=high
```

## Sidecars on another machine

`--machine NAME` runs a slot's sidecar on a [saved Herdr SSH machine](https://herdr.dev/docs/connecting-machines/), such as your laptop, while Claude stays local. `NAME` is a saved machine's label or profile ID. The sidecar is a pi agent in a Herdr pane on that machine, and your local Herdr window lists the pane under the machine. It is opt-in per slot; without the flag, or `SIDECAR_MACHINE`, nothing changes.

```bash
./scripts/sidecar --slot 2 --machine laptop ask "Run the integration tests on macOS and report."
./scripts/sidecar --slot 2 answer "Yes."        # no flag needed: slot 2 remembers its machine
./scripts/sidecar --machine laptop --remote-cwd /Users/me/src/app diff origin/main "Intent"
```

- **Slots stay put.** A slot remembers its machine in `~/.cache/claude-sidecar/<agent>.machine`, so later `note`, `ask`, `answer`, `status` and `restart` route there without the flag. Starting a slot on another machine, or moving a local slot to one, is an error: use another slot. `SIDECAR_MACHINE=laptop` makes new slots start on that machine by default; a slot bound earlier keeps its own.
- **Panes.** Every Herdr call for the slot goes through `herdr --machine`. The panes open in the machine's workspace that already has a pane in the working directory (Herdr picks one when none does), in a "Sidecars" tab that fills 2×2 like the local one. Claude's local tab is never used. Agent names carry a short tag of the local machine, such as `sc-3fa9-pane-1`, so they cannot collide with sidecars that a Claude on that machine starts.
- **Files.** The sidecar reads requests where it runs. The launcher copies each request, diff and plan file over `ssh <target>` into `~/.cache/claude-sidecar/requests` on the machine, reads the report and the `needs_answer` marker back from the machine's `~/.cache/claude-sidecar/reports`, and polls it like a local one. Paths are resolved on the machine, so its home directory may differ. SSH uses the target saved in `herdr machine list`, with `BatchMode=yes` and keepalives, so it never prompts or hangs.
- **Code.** The sidecar works in the machine's own checkout, by default at the same absolute path as the current directory; machine path mappings or `--remote-cwd DIR` name the directory there instead. Requests tell it that path, and for `diff` and `plan` Claude's commit and that its uncommitted changes exist only in the copied files. The checkout may need `git fetch` to reach that commit. The launcher never runs checkout or reset there, and tells the sidecar not to. **Edits and commits a remote sidecar makes land in the machine's checkout, not in the local one.**

Requirements:

- Herdr 0.9.1 or later on both machines. Add the machine with `herdr machine add <ssh-target>` and check `herdr machine list`. The SessionStart hook names the enabled machines to Claude when that command works, and says nothing about machines otherwise.
- On the machine: pi, authenticated with the model provider (for example a Codex login), and Git for repository work. The default `sh` transport also needs a POSIX SSH shell and this plugin at the same path (`SIDECAR_REMOTE_HOME` names the plugin's `sidecar/` directory elsewhere). The Node transport deploys the runtime files automatically. The launcher itself runs only here.
- SSH keys loaded in your agent: a passphrase-protected key is not prompted for.

Clear errors name an unknown or disabled machine, a missing plugin or directory on the machine, and an unreachable SSH connection.

### Windows and machine path mappings

For a Windows machine whose OpenSSH shell is `cmd.exe`, use the Node transport. It uses the Node already required by pi, without changing OpenSSH's `DefaultShell` or launching pi over SSH: Herdr still owns the agent pane. Put per-machine settings in `~/.config/claude-sidecar/machines.json` (override the file with `SIDECAR_MACHINES_FILE`):

```json
{
  "lappy": {
    "transport": "node",
    "paths": {
      "/home/aim/git": "C:/git"
    }
  }
}
```

Keys are saved machine labels or IDs; IDs take precedence. The longest matching directory prefix maps the local checkout, including subdirectories. `--remote-cwd` overrides the mapping and accepts Windows drive paths; the slot remembers the chosen directory. A matching checkout must already exist on the machine. This does not clone, reset or synchronize repositories.

The Node transport copies only `sidecar.ts` and `reviewer.md` into the remote home's `.cache/claude-sidecar/plugin/sidecar`, updating changed files on each invocation. No plugin checkout or remote launcher dependencies are needed. Optional `home` names a different runtime deployment directory; `SIDECAR_REMOTE_HOME` overrides it. Already-running agents retain their loaded extension. Requests, answers and reports also transfer through Node, so the SSH default shell needs no POSIX commands. Pi's own Bash tool still needs its usual Windows shell setup (such as Git Bash).

From a mapped checkout, start a new slot with `./scripts/sidecar --slot 2 --machine lappy ask "Run the tests there."`; follow-ups need only `--slot 2`. This transport has been smoke-tested with pi in a Windows Herdr pane, including tool execution, report delivery and answering a pending question.

## Safety

The reviewer inspects by default, but can edit and commit when asked. It may push and write to GitLab/GitHub when asked. Its Bash guard blocks sudo, spawning agent processes, and detaching processes. This is a best-effort guard, not a security boundary: shell wrappers, alternate tools, and other command forms can bypass it. The agent has access to your filesystem and its own model credentials. Claude remains responsible for verifying findings.
