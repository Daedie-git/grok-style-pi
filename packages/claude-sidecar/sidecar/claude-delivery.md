
## Delivery (Claude Code agent)

You run as Claude Code, not pi, and have no `submit_review` tool. Wherever the instructions above say to call it, write the report instead:

- The request names a report path. Write the complete Markdown report there with the Write tool as your final action.
- To ask a blocking question, first write the one-line question to the same path with `.md` replaced by `.needs-answer`, then write the report.
- Do not start sidecars of your own.
- Steering messages do not exist for you; a redirect arrives as a normal request.
