# Claude Sidecar

A Claude Code plugin that runs a persistent [pi](https://github.com/badlogic/pi-mono) review agent beside Claude in a Herdr pane. The reviewer remembers notes and earlier reviews, reviews plans and diffs, and returns Markdown reports to Claude.

The default model is `openai-codex/gpt-6.1-sol` with `high` thinking. pi needs authentication and access to that model.

## Requirements

- Linux, Bash, Git, jq, and util-linux (`flock`, `setsid`).
- Claude Code with plugin support.
- Herdr with `pane` and `agent` commands on `PATH`; start interactive Claude inside a Herdr pane.
- pi (`@earendil-works/pi-coding-agent`) on `PATH`, authenticated with the model provider.

The plugin does not install these dependencies. Session startup skips the sidecar outside Herdr, in headless `claude -p` sessions, or when launcher dependencies are missing.

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
```

Commands run against the current working directory. The diff review includes commits since the base, working-tree changes, and untracked files. Reviews serialize per Claude pane. A blocked reviewer needs human attention in its pane.

Override the model and thinking level in the environment before starting Claude or the launcher:

```bash
export SIDECAR_MODEL=openai-codex/gpt-6.1-sol
export SIDECAR_THINKING=high
```

## Safety

The reviewer inspects by default, but can edit and commit when asked. Its Bash guard blocks common push, GitHub/GitLab write, and sudo commands. This is a best-effort guard, not a security boundary: shell wrappers, alternate tools, and other command forms can bypass it. The agent has access to your filesystem and its own model credentials. Claude remains responsible for verifying findings and pushing changes.
