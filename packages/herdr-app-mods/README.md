# Herdr App mods

- `spaces-load` adds activity and load information to the space list.
- `issues` displays the Issues coordinator in Herdr App. It needs `herdr-issues` on `PATH` (or a `herdr-issues.command` override in Herdr's shared settings). The coordinator and its data are not included here.
- `tabs-issues` adds the Issues panel to the tabs bar when the layout includes it.

Install the three directories in `mods/` into the Herdr App `mods/` directory under `~/.config/herdr-app` (or `HERDR_APP_HOME`). Place `layouts/main-load.json` in its `layouts/` directory and select **main-load** in Herdr App. This is a separate layout; it does not replace an existing `main` layout. On NixOS, Home Manager links these paths to the deployed checkout and moves conflicting files aside as `.before-nix`.

The other Herdr App mods are its own bundled defaults. The Claude Code plugin is in `../claude-sidecar`, and the Pi entrypoints remain in the root package.
