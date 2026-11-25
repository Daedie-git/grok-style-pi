# codex-accounts

A standalone Pi extension that uses two ChatGPT accounts for OpenAI Codex and fails over between them when one hits its usage limit.

- `openai-codex` is account 1, Pi's built-in login.
- `openai-codex-2` is account 2. Log in with `/login` → "OpenAI (ChatGPT Plus/Pro) — OpenAI Codex (account 2)", in a browser signed in to the second account (a private window works).
- `codex-auto/<model>` mirrors each Codex model. It stays on the account that answered last, and when that account hits its usage limit it retries the request on the other account.

A spent account is recorded under `~/.pi/agent/codex-accounts/`, shared by every Pi process, until the reset time ChatGPT reports (15 minutes when it reports none, 2 minutes for a bare 429). `/codex-accounts` shows each account's state; `/codex-accounts reset` clears it.

## Install

The Grok package manifest does not load this extension. Copy it into Pi's global extensions directory on each machine:

```sh
cp packages/codex-accounts/codex-accounts.ts ~/.pi/agent/extensions/
```

Then select a `codex-auto` model, or set `"defaultProvider": "codex-auto"` in `~/.pi/agent/settings.json`.

## Limits

- Compaction summaries bypass the agent loop, so a usage limit hit by one neither fails over nor marks the account. A later agent turn that hits the limit does both.
- Models selected as `openai-codex/...` stay on account 1.
- Extensions that key on the `openai-codex` provider id, such as `pi-codex-compaction`'s native compaction, do not apply on account 2.
