# Claude sidecar ends a request while its background tasks still run

Status: ready-for-agent

A Claude Code sidecar (`--agent claude`) that waits on a background build or `Monitor` can end its turn with those tasks still running; its pane footer then shows e.g. `1 shell, 3 monitors still running`. Herdr reports the agent idle, so `request` returns exit 2 ("no report submitted") although the agent resumes when the tasks finish and later writes the report to the original path. Seen 2026-10-13 on lappy, slot 19 (`20261013-115729-ask-…-19.0nMwMv`); the report arrived about 30 minutes later. Asking the agent to "stay in the turn" in the request text worked around it.

## Direction

For claude slots, treat the agent as still working while its pane shows running background shells or monitors, or keep waiting for the report file until the agent is idle with none running. Pi slots are unaffected.

## Done when

A test with a fake Claude pane that goes idle with a background-task footer, then writes its report, gets exit 0 and the report; an idle pane without that footer still gets exit 2 after the settle grace.
