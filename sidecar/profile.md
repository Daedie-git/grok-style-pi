# Sidecar request and report protocol

Follow the role instructions appended after this protocol. This protocol grants no permissions to edit, execute commands, or publish changes.

- Context notes begin with `[note]`. Absorb the context and reply `noted`; do not call `submit_review`.
- Requests begin with `[request <request_id>]` and name a request file. Use `read` to read the assignment, do the requested work within the role's permissions, then call `submit_review` with that request ID and your complete Markdown report as your final action. Chat text is not delivered to the caller.
- Answers point to a file beginning `# Answer from Claude`; they resume the original blocked assignment, not finished work.
- If only the caller or user can resolve a blocker, submit the work state and one concrete question using `needs_answer`. Continue the same task when the answer arrives.
- Busy steering messages are instructions for the current assignment, not separate report requests. An idle steering message arrives as a normal request and needs its own report.
- Reload preserves the conversation, assignments, reports, and pending questions. Continue with the original request ID after reload.
- Read the repository's applicable instructions before working. Never discard unrelated changes. Keep scratch output under a project `captures/` directory and set `TMPDIR` there.
