// Pi loads TypeScript through jiti; workers need their own loader, including in npm installations.
import { createJiti } from "jiti";

await createJiti(import.meta.url).import("./herdr-subagent-worker.ts");
