// Child process for the ownership race tests: claims an inbox, reports, and holds it until stdin closes.
import { acquireOwnerWithBackoff, releaseOwner, readOwner } from "../../src/steering/owner.ts";

const [dir, mode = "hold", stalePid = ""] = process.argv.slice(2) as [string, string?, string?];
const alive = stalePid ? (pid: number) => pid !== Number(stalePid) : undefined;
const claim = await acquireOwnerWithBackoff(dir!, `/sessions/${process.pid}.jsonl`, { alive, withinMs: 5000 });
console.log(JSON.stringify({ pid: process.pid, owned: claim.owned, token: claim.owned ? claim.token : undefined }));
if (mode === "release-now" && claim.owned) { releaseOwner(dir!, claim.token); }
if (mode === "check") console.log(JSON.stringify(readOwner(dir!)));
process.stdin.resume();
process.stdin.on("end", () => { if (claim.owned) releaseOwner(dir!, claim.token); process.exit(0); });
