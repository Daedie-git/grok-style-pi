// Pi loads TypeScript through jiti; workers need their own loader, including in npm installations.
import { importTs } from "./load-ts.mjs";

await importTs("./worker.ts");
