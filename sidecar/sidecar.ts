// Loaded into Claude's pi review sidecar by scripts/sidecar.
// Reports go to files because the fullscreen pi TUI keeps its transcript on
// the alternate screen, where herdr cannot read it back.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const stateDir = join(homedir(), ".cache", "claude-sidecar");
const reportDir = join(stateDir, "reports");

// The sidecar may inspect, build, test, and edit anywhere, including Claude's
// checkout, but never pushes or writes to GitLab. A guardrail, not a sandbox.
const alwaysBlocked: [RegExp, string][] = [
  [/\bgit\b.*\s(push|send-email)\b/, "git push"],
  [/\bglab\b.*\b(note|approve|revoke|merge|update|close|reopen|create|delete|rebase)\b/, "glab writes"],
  [/\bglab\s+api\b.*(-X|--method)\s*(POST|PUT|PATCH|DELETE)/i, "glab api writes"],
  [/\bgh\s+(pr|issue)\s+(comment|create|edit|merge|close|review)\b/, "gh writes"],
  [/\bsudo\b/, "sudo"],
];

function checkBash(command: string): string | undefined {
  for (const [pattern, what] of alwaysBlocked) if (pattern.test(command)) return what;
  return undefined;
}

const guidance = "Pushing and GitLab writes are Claude's job.";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    let reason: string | undefined;
    if (event.toolName === "bash") reason = checkBash(String(event.input.command ?? ""));
    return reason ? { block: true, reason: `Sidecar guard blocked ${reason}. ${guidance}` } : undefined;
  });

  pi.registerTool({
    name: "submit_review",
    label: "Submit review to Claude",
    description:
      "Deliver your answer for a Claude sidecar request. Call exactly once per request that names a request_id, as your final action. " +
      "The report is Markdown and is the only thing Claude sees; your chat text is not delivered.",
    parameters: Type.Object({
      request_id: Type.String({ description: "The request_id given in the request, verbatim" }),
      report: Type.String({ description: "Complete Markdown report" }),
      needs_answer: Type.Optional(Type.String({
        description:
          "Set to ONE concrete question when you are blocked on a decision only Claude or the user can make, instead of finishing. " +
          "Claude answers with `sidecar answer` and you resume the same task. Do not use it for questions you can resolve from the code.",
      })),
    }),
    async execute(_id, params) {
      if (!/^[A-Za-z0-9._-]+$/.test(params.request_id)) throw new Error(`invalid request_id: ${params.request_id}`);
      await mkdir(reportDir, { recursive: true });
      const path = join(reportDir, `${params.request_id}.md`);
      await writeFile(path, params.report);
      const marker = join(reportDir, `${params.request_id}.needs-answer`);
      if (params.needs_answer?.trim()) await writeFile(marker, params.needs_answer.replace(/\s+/g, " ").trim() + "\n");
      return { content: [{ type: "text", text: `Delivered to Claude (${path}).` }], details: undefined };
    },
  });
}
