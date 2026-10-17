// Loaded into Claude's pi review sidecar by scripts/sidecar.
// Reports go to files because the fullscreen pi TUI keeps its transcript on
// the alternate screen, where herdr cannot read it back.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { installReloadControl } from "./reload.mjs";
import { installWindowsControl } from "./windows-runtime.mjs";

const stateDir = join(homedir(), ".cache", "claude-sidecar");
const reportDir = join(stateDir, "reports");

export default function (pi: ExtensionAPI) {
  installReloadControl(pi, stateDir);
  if (process.platform === "win32") installWindowsControl(pi, stateDir);
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
      const marker = join(reportDir, `${params.request_id}.needs-answer`);
      if (params.needs_answer?.trim()) await writeFile(marker, params.needs_answer.replace(/\s+/g, " ").trim() + "\n");
      else await rm(marker, { force: true });
      // The report's appearance is the completion signal. Publish only after its question marker and full body.
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, params.report); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
      return { content: [{ type: "text", text: `Delivered to Claude (${path}).` }], details: undefined };
    },
  });
}
