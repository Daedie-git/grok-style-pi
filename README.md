# grok-style-pi

Grok Build-inspired chrome for [Pi](https://pi.dev): a GrokNight color theme, a `cwd │ model │ N% ctx` footer, a low-contrast focused composer frame, and diamond (`◆`) tool rows.

This package uses only documented Pi extension APIs (`setFooter`, `setEditorComponent` wrapping `CustomEditor`, and same-name `registerTool` overrides with `renderShell: "self"`). It does not patch Pi internals.

## Install

From a clone:

```bash
pi install /home/aim/git/grok-style-pi
```

From GitHub:

```bash
pi install git:github.com/Daedie-git/grok-style-pi
```

Try without installing:

```bash
pi -e /path/to/grok-style-pi
```

Then pick the **groknight** theme in `/settings`, or set it in `~/.pi/agent/settings.json`:

```json
{
  "theme": "groknight",
  "tuiMode": "fullscreen",
  "quietStartup": true,
  "editorPaddingX": 1,
  "outputPad": 1
}
```

Restart Pi after changing `tuiMode`.

## What you get

| Surface | Behavior |
|---|---|
| Theme | Neutral near-black gray + magenta `#bb9af7` (GrokNight) |
| Footer | `cwd │ model │ N% ctx` |
| Composer | Muted idle border, brighter focused border |
| Tools | `◆ Tool(args)` with dim collapsed output; expand for the full result |

Built-in tools (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) keep Pi’s `create*Tool` execute path. Only rendering changes.

## Tests

```bash
npm test
```

Requires Node 22+ (type stripping) and `@earendil-works/pi-coding-agent` for the factory/consumer tests (`npm install`).
