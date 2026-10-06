import assert from 'node:assert/strict';
import fs, { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installReloadControl } from '../sidecar/reload.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-reload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map(), commands = new Map();
  const pi = { on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command) };
  const ctx = { sessionManager: { getSessionId: () => 'cc-test', getSessionFile: () => '/sessions/test.jsonl' }, isIdle: () => true, waitForIdle: async () => {} };
  installReloadControl(pi, root);
  await handlers.get('session_start')({ reason: 'startup' }, ctx);
  const dir = join(root, 'reload');
  const pending = (id = 'reload-test', sessionFile = '/sessions/test.jsonl') => writeFile(join(dir, 'cc-test.pending'), JSON.stringify({ id, sessionFile }));
  return { root, dir, handlers, commands, ctx, pi, pending };
}

test('reload waits for idle, acknowledges only from the fresh runtime, and leaves reports/questions intact', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'reports'));
  await writeFile(join(f.root, 'reports', 'request.md'), 'existing report');
  await writeFile(join(f.root, 'slot.pending'), 'request');
  await f.pending();
  let idle = false, finishIdle, called = false;
  f.ctx.isIdle = () => idle;
  f.ctx.waitForIdle = () => new Promise(resolve => { finishIdle = resolve; });
  f.ctx.reload = async () => {
    called = true;
    await f.handlers.get('session_shutdown')();
    const fresh = new Map();
    installReloadControl({ on: (n, h) => fresh.set(n, h), registerCommand: () => {} }, f.root);
    await fresh.get('session_start')({ reason: 'reload' }, f.ctx);
  };
  const operation = f.commands.get('sidecar-reload').handler('reload-test', f.ctx);
  await new Promise(r => setImmediate(r));
  assert.equal(called, false);
  idle = true; finishIdle(); await operation;
  assert.equal(JSON.parse(await readFile(join(f.dir, 'reload-test.ack'))).status, 'reloaded');
  assert.equal(await readFile(join(f.root, 'slot.pending'), 'utf8'), 'request');
  assert.equal(await readFile(join(f.root, 'reports', 'request.md'), 'utf8'), 'existing report');
});

test('startup and another session file cannot confirm a reload', async t => {
  const f = await fixture(t);
  await f.pending();
  await f.handlers.get('session_start')({ reason: 'startup' }, f.ctx);
  await assert.rejects(readFile(join(f.dir, 'reload-test.ack')), { code: 'ENOENT' });
  await f.pending('reload-test', '/other/session.jsonl');
  await f.handlers.get('session_start')({ reason: 'reload' }, f.ctx);
  await assert.rejects(readFile(join(f.dir, 'reload-test.ack')), { code: 'ENOENT' });
});

test('a withdrawn reload is not run, and invalid command ids are rejected', async t => {
  const f = await fixture(t);
  f.ctx.reload = () => { throw Error('must not reload'); };
  await f.commands.get('sidecar-reload').handler('reload-withdrawn', f.ctx);
  await assert.rejects(f.commands.get('sidecar-reload').handler('../escape', f.ctx), /Invalid reload/);
});

test('consecutive reloads preserve the next marker written as the first acknowledgement becomes visible', async t => {
  const f = await fixture(t);
  await f.pending('reload-first');
  const rename = fs.rename;
  const intercepted = t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to);
    if (to === join(f.dir, 'reload-first.ack')) {
      // The launcher can now release its lock and start the next reload.
      await assert.rejects(readFile(join(f.dir, 'cc-test.pending')), { code: 'ENOENT' });
      await f.pending('reload-second');
    }
  });
  syncBuiltinESMExports();
  t.after(() => { intercepted.mock.restore(); syncBuiltinESMExports(); });
  await f.handlers.get('session_start')({ reason: 'reload' }, f.ctx);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'cc-test.pending'))).id, 'reload-second');
  const fresh = new Map();
  installReloadControl({ on: (name, handler) => fresh.set(name, handler), registerCommand: () => {} }, f.root);
  await fresh.get('session_start')({ reason: 'reload' }, f.ctx);
  for (const id of ['reload-first', 'reload-second']) {
    assert.equal(JSON.parse(await readFile(join(f.dir, `${id}.ack`))).status, 'reloaded');
  }
  await assert.rejects(readFile(join(f.dir, 'cc-test.pending')), { code: 'ENOENT' });
});

test('a superseded marker is neither consumed nor acknowledged by the earlier runtime', async t => {
  const f = await fixture(t);
  await f.pending('reload-first');
  const originalRead = fs.readFile;
  let replaced = false;
  const intercepted = t.mock.method(fs, 'readFile', async (...args) => {
    const content = await originalRead(...args);
    if (args[0] === join(f.dir, 'cc-test.pending') && !replaced) {
      replaced = true;
      await f.pending('reload-second');
    }
    return content;
  });
  syncBuiltinESMExports();
  t.after(() => { intercepted.mock.restore(); syncBuiltinESMExports(); });
  await f.handlers.get('session_start')({ reason: 'reload' }, f.ctx);
  assert.equal(replaced, true);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'cc-test.pending'))).id, 'reload-second');
  await assert.rejects(readFile(join(f.dir, 'reload-first.ack')), { code: 'ENOENT' });
});

test('Windows session file case and slash spelling match', async t => {
  const f = await fixture(t);
  f.ctx.sessionManager.getSessionFile = () => 'C:\\Pi\\Sessions\\test.jsonl';
  await f.pending('reload-win', 'c:/pi/sessions/TEST.jsonl');
  await f.handlers.get('session_start')({ reason: 'reload' }, f.ctx);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'reload-win.ack'))).status, 'reloaded');
});
