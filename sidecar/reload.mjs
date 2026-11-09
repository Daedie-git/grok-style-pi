// File receipts survive extension replacement; request/report files are deliberately left untouched.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const safeId = /^[A-Za-z0-9._-]+$/;
const normalize = value => /^[A-Za-z]:/.test(value) ? value.replace(/\\/g, '/').toLowerCase() : value;
async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function publish(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value)); await rename(tmp, path); }
  finally { await rm(tmp, { force: true }); }
}

export function installReloadControl(pi, stateDir) {
  const dir = join(stateDir, 'reload');
  let ready;
  pi.on('session_start', async (event, ctx) => {
    const session = ctx.sessionManager.getSessionId();
    const next = safeId.test(session) ? join(dir, `${session}.ready`) : undefined;
    // A receipt names the session this pi runs now; the launcher trusts it to identify the sidecar.
    if (ready && ready !== next) await rm(ready, { force: true });
    ready = next;
    if (!ready) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    await mkdir(dir, { recursive: true });
    await publish(ready, { pid: process.pid, sessionFile });
    if (event.reason !== 'reload') return;
    const path = join(dir, `${session}.pending`);
    const request = await readJson(path);
    if (!request || typeof request.id !== 'string' || !safeId.test(request.id) || normalize(request.sessionFile) !== normalize(sessionFile)) return;
    const current = await readJson(path);
    if (current?.id !== request.id || normalize(current.sessionFile) !== normalize(sessionFile)) return;
    // The acknowledgement releases the launcher's request lock. Finish consuming
    // our marker first so cleanup cannot delete the next reload's marker.
    await rm(path, { force: true });
    await publish(join(dir, `${request.id}.ack`), { status: 'reloaded', sessionFile });
  });
  pi.registerCommand('sidecar-reload', {
    description: 'Reload sidecar resources once the current operation is idle',
    handler: async (id, ctx) => {
      if (!safeId.test(id)) throw new Error('Invalid reload receipt id');
      const session = ctx.sessionManager.getSessionId();
      if (!safeId.test(session)) throw new Error('Invalid sidecar session id');
      do { await ctx.waitForIdle(); } while (!ctx.isIdle());
      const request = await readJson(join(dir, `${session}.pending`));
      if (request?.id !== id) return; // The caller withdrew a timed-out reload before it began.
      // Reload is terminal: its fresh session_start handler publishes the receipt.
      await ctx.reload();
    },
  });
  pi.on('session_shutdown', async () => {
    if (ready) await rm(ready, { force: true });
    ready = undefined;
  });
}
