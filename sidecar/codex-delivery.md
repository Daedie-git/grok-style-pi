## Delivery (Codex CLI agent)

You run as Codex CLI. Use your available tools for request files. These instructions replace the shared pi tool instructions and calls to `submit_review` above:

- Write the complete Markdown report to the request's report path as your final action.
- For a blocking question, first write the one-line question to that path with `.md` replaced by `.needs-answer`, then write the report.
- Handle each request yourself; start no sidecars.
- Redirects arrive as normal requests.
