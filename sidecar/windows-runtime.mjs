// Native Windows control channel: ConPTY/Herdr agent status and terminal input are not reliable here.
import fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const safe = /^[A-Za-z0-9._-]+$/;
const read = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
};
const live = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
};
const publish = (file, value) => {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value));
    // Windows can briefly deny replacement while a reader/virus scanner holds the destination open.
    // Keep the previous complete record visible; retry only sharing violations, with a short hard bound.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, file); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 25) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } finally { fs.rmSync(tmp, { force: true }); }
};

export function installWindowsControl(pi, stateDir) {
  let dir, owner, timer, ctx, status = 'idle';
  const pending = new Map();
  const owns = () => owner && read(join(dir, 'owner.json'))?.token === owner.token;
  const snapshot = () => {
    if (owns()) publish(join(dir, 'status.json'), { ...owner, status, updated: Date.now() });
  };
  const receipt = (id, value) => publish(join(dir, `${id}.ack`), { token: owner.token, ...value });
  const close = () => {
    clearInterval(timer);
    timer = undefined;
    if (owns()) {
      fs.rmSync(join(dir, 'owner.json'), { force: true });
      fs.rmSync(join(dir, 'status.json'), { force: true });
    }
    owner = undefined;
    pending.clear();
  };
  const poll = () => {
    if (!owns()) { clearInterval(timer); return; }
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.inbox')).sort()) {
      const id = file.slice(0, -6);
      if (!safe.test(id)) continue;
      // Rename is the claim boundary: the caller may withdraw only before this succeeds.
      const claimed = join(dir, `${id}.claimed`);
      try { fs.renameSync(join(dir, file), claimed); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      try {
        const message = read(claimed);
        if (message?.token !== owner.token) {
          receipt(id, { status: 'rejected', reason: 'owner changed; nothing was delivered' });
          continue;
        }
        if (status === 'blocked') {
          receipt(id, { status: 'rejected', reason: 'sidecar is blocked in its pane' });
          continue;
        }
        if (typeof message.text !== 'string' || !message.text.trim()) throw Error('empty sidecar message');
        if (message.action === 'reload') {
          if (!/^\/sidecar-reload [A-Za-z0-9._-]+$/.test(message.text)) throw Error('invalid reload command');
          // The command waits for idle itself; only its fresh runtime acknowledges completion.
          receipt(id, { status: 'accepted' });
          pi.sendUserMessage(message.text, { expandPromptTemplates: true });
          continue;
        }
        pending.set(id, { seen: false });
        status = 'working';
        // Custom messages bypass terminal editing and user-input handlers, and can steer a running turn.
        pi.sendMessage({ customType: 'sidecar-control', content: message.text, display: true,
          details: { deliveryId: id } }, { triggerTurn: true, deliverAs: 'steer' });
        if (!pending.get(id)?.seen) receipt(id, { status: 'accepted' });
      } catch (error) {
        pending.delete(id);
        receipt(id, { status: 'rejected', reason: String(error) });
      } finally { fs.rmSync(claimed, { force: true }); }
    }
    snapshot();
  };
  pi.on('session_start', (_event, context) => {
    close();
    ctx = context;
    const session = ctx.sessionManager.getSessionId();
    if (!safe.test(session)) throw Error('Invalid Windows sidecar session id');
    dir = join(stateDir, 'windows', session);
    fs.mkdirSync(dir, { recursive: true });
    const file = join(dir, 'owner.json');
    const previous = read(file);
    if (previous && previous.pid !== process.pid && live(previous.pid)) {
      throw Error(`Windows sidecar session ${session} is already owned by process ${previous.pid}`);
    }
    if (previous) fs.rmSync(file, { force: true });
    const next = { pid: process.pid, sessionFile: ctx.sessionManager.getSessionFile(), token: randomUUID() };
    // Exclusive create also refuses simultaneous starts of the same session.
    fs.writeFileSync(file, JSON.stringify(next), { flag: 'wx' });
    owner = next;
    status = ctx.isIdle() && !ctx.hasPendingMessages() ? 'idle' : 'working';
    snapshot();
    timer = setInterval(() => {
      try { poll(); }
      catch (error) { status = 'error'; snapshot(); ctx.ui.notify(`Windows sidecar control: ${error}`, 'error'); }
    }, 250);
    timer.unref();
  });
  pi.on('agent_start', () => { status = 'working'; snapshot(); });
  pi.on('message_end', event => {
    const message = event.message;
    if (message.role !== 'custom' || message.customType !== 'sidecar-control') return;
    const id = message.details?.deliveryId;
    if (!pending.has(id)) return;
    pending.get(id).seen = true;
    receipt(id, { status: 'seen' });
  });
  // agent_end is too early: retries, compaction and queued continuations can still run afterward.
  pi.on('agent_settled', event => {
    for (const [id, message] of pending) {
      if (!message.seen) {
        // Escape can discard queued custom messages before aborted settlement, so they must not keep us busy.
        // The public API cannot prove whether an unseen custom message was cleared or retained by another abort
        // path. End its waiter with an unknown-delivery outcome, never a claim that resending is safe.
        if (!event.aborted || ctx.hasPendingMessages()) continue;
        receipt(id, { status: 'aborted', reason: 'turn aborted before sidecar delivery was confirmed; inspect the pane before resending' });
      } else {
        receipt(id, { status: 'settled' });
      }
      pending.delete(id);
    }
    status = pending.size || ctx.hasPendingMessages() ? 'working' : 'idle';
    snapshot();
  });
  pi.on('ui_prompt_start', () => { status = 'blocked'; snapshot(); });
  pi.on('ui_prompt_end', () => { status = ctx.isIdle() ? 'idle' : 'working'; snapshot(); });
  pi.on('session_shutdown', close);
}
