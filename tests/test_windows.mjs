import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installWindowsControl } from '../sidecar/windows-runtime.mjs';

const client = fs.readFileSync(new URL('../scripts/windows-control.cjs', import.meta.url), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let end = Date.now() + 5000; Date.now() < end;) { if (predicate()) return; await sleep(25); }
  assert.fail('Timed out waiting for control delivery');
}
function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'sidecar-windows-'));
  const state = join(home, '.cache', 'claude-sidecar');
  const dir = join(state, 'windows', 'cc-test');
  const handlers = new Map(), messages = [], commands = [];
  const pi = { on: (event, handler) => handlers.set(event, handler),
    sendMessage: (message, options) => messages.push({ message, options }),
    sendUserMessage: (text, options) => commands.push({ text, options }) };
  const ctx = { sessionManager: { getSessionId: () => 'cc-test', getSessionFile: () => 'C:/sessions/cc-test.jsonl' },
    isIdle: () => true, hasPendingMessages: () => false, ui: { notify: () => {} } };
  installWindowsControl(pi, state);
  handlers.get('session_start')({}, ctx);
  const emit = (event, data = {}) => handlers.get(event)?.(data, ctx);
  const seen = index => emit('message_end', { message: { role: 'custom', ...messages[index].message } });
  const read = file => JSON.parse(fs.readFileSync(join(dir, file), 'utf8'));
  t.after(() => { emit('session_shutdown'); fs.rmSync(home, { recursive: true, force: true }); });
  function run(action, overrides = {}, text = 'request text') {
    const options = { action, session: 'cc-test', pid: process.pid, progress: 0, ...overrides };
    const source = `const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const args=${JSON.stringify([JSON.stringify(options)])};const text=${JSON.stringify(text)};\n${client}`;
    const child = spawn(process.execPath, ['-e', source], { env: { ...process.env, HOME: home, USERPROFILE: home } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const done = new Promise(resolve => child.on('exit', code => resolve({ code, stdout, stderr })));
    return { child, done };
  }
  return { home, state, dir, messages, commands, ctx, emit, seen, read, run, pi };
}

test('Windows requests wait for the report despite false idle, agent_end, retries and compaction gaps', async t => {
  const f = fixture(t);
  const report = join(f.home, 'report.md');
  const operation = f.run('request', { report });
  await until(() => f.messages.length === 1);
  assert.deepEqual(f.messages[0].options, { triggerTurn: true, deliverAs: 'steer' });
  f.seen(0);
  f.emit('agent_end'); // Not a reliable settlement boundary.
  await sleep(400);
  assert.equal(operation.child.exitCode, null);
  assert.equal(f.read('status.json').status, 'working');
  fs.writeFileSync(report, 'complete report');
  assert.equal((await operation.done).code, 0);
});

test('Windows busy steering uses the same conversation and leaves the report waiter running', async t => {
  const f = fixture(t), report = join(f.home, 'report.md');
  const request = f.run('request', { report });
  await until(() => f.messages.length === 1);
  f.seen(0);
  const steer = f.run('steer', {}, 'new direction');
  await until(() => f.messages.length === 2);
  const response = await steer.done;
  assert.equal(response.code, 0, response.stderr);
  assert.match(response.stdout, /queued/);
  assert.equal(f.messages[1].message.content, 'new direction');
  assert.equal(request.child.exitCode, null);
  f.seen(1);
  fs.writeFileSync(report, 'finished with new direction');
  assert.equal((await request.done).code, 0);
});

test('Windows true settlement without a report returns exit 2, but unconsumed queued messages do not settle', async t => {
  const f = fixture(t);
  const operation = f.run('request');
  await until(() => f.messages.length === 1);
  f.emit('agent_settled');
  await sleep(300);
  assert.equal(operation.child.exitCode, null);
  f.seen(0);
  f.emit('agent_settled');
  assert.equal((await operation.done).code, 2);
  assert.equal(f.read('status.json').status, 'idle');
});

test('Windows note waits for actual settlement and status comes from the runtime', async t => {
  const f = fixture(t);
  const operation = f.run('note');
  await until(() => f.messages.length === 1);
  f.seen(0);
  assert.equal(JSON.parse((await f.run('status').done).stdout).status, 'working');
  f.emit('agent_settled');
  assert.equal((await operation.done).code, 0);
  assert.equal(JSON.parse((await f.run('status').done).stdout).status, 'idle');
});

test('Windows reload idle guard waits for settlement without publishing or interrupting work', async t => {
  const f = fixture(t);
  f.emit('agent_start');
  const operation = f.run('wait');
  await sleep(350);
  assert.equal(operation.child.exitCode, null);
  assert.equal(f.messages.length, 0);
  f.emit('agent_end');
  await sleep(300);
  assert.equal(operation.child.exitCode, null);
  f.emit('agent_settled');
  assert.equal((await operation.done).code, 0);
});

test('Windows owner verification refuses the wrong pane process before publishing anything', async t => {
  const f = fixture(t);
  const response = await f.run('request', { pid: process.pid + 12345 }).done;
  assert.equal(response.code, 1);
  assert.match(response.stderr, /does not match the process/);
  assert.equal(fs.readdirSync(f.dir).filter(file => file.endsWith('.inbox')).length, 0);
});

test('Windows blocking UI returns exit 5 without replacing a pending task', async t => {
  const f = fixture(t);
  const operation = f.run('request');
  await until(() => f.messages.length === 1);
  f.seen(0);
  f.emit('ui_prompt_start');
  assert.equal((await operation.done).code, 5);
  assert.equal((await f.run('steer').done).code, 5);
});

test('Windows old-owner messages are rejected, and another runtime cannot remove the current owner', async t => {
  const f = fixture(t);
  const old = f.read('owner.json');
  fs.writeFileSync(join(f.dir, 'wrong.inbox'), JSON.stringify({ token: 'old-owner', text: 'must not deliver' }));
  await until(() => fs.existsSync(join(f.dir, 'wrong.ack')));
  assert.equal(f.read('wrong.ack').status, 'rejected');
  assert.equal(f.messages.length, 0);
  fs.writeFileSync(join(f.dir, 'owner.json'), JSON.stringify({ ...old, token: 'replacement' }));
  f.emit('session_shutdown');
  assert.equal(f.read('owner.json').token, 'replacement');
});

test('Windows expired unclaimed delivery is withdrawn safely', async t => {
  const f = fixture(t);
  // Stop only the polling interval by replacing ownership, then install a fresh manual owner record.
  const owner = f.read('owner.json');
  f.emit('session_shutdown');
  fs.writeFileSync(join(f.dir, 'owner.json'), JSON.stringify(owner));
  fs.writeFileSync(join(f.dir, 'status.json'), JSON.stringify({ ...owner, status: 'idle', updated: Date.now() }));
  const result = await f.run('steer', { timeout: 50 }).done;
  assert.equal(result.code, 4, result.stderr);
  assert.match(result.stderr, /safe to resend/);
  assert.equal(fs.readdirSync(f.dir).filter(file => file.endsWith('.inbox')).length, 0);
});

test('Windows reload dispatches the extension command, not a model prompt', async t => {
  const f = fixture(t);
  const operation = f.run('reload', {}, '/sidecar-reload reload-test');
  await until(() => f.commands.length === 1);
  assert.deepEqual(f.commands[0], { text: '/sidecar-reload reload-test', options: { expandPromptTemplates: true } });
  assert.equal(f.messages.length, 0);
  // A fast reload can replace the old runtime before the client's next poll.
  f.emit('session_start');
  const result = await operation.done;
  assert.equal(result.code, 0, result.stderr);
});

test('Windows atomic records retry transient sharing violations without exposing partial JSON', t => {
  const f = fixture(t);
  const rename = fs.renameSync;
  let denied = 0;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (args[1] === join(f.dir, 'status.json') && denied < 3) {
      denied++;
      assert.equal(f.read('status.json').status, 'idle');
      throw Object.assign(Error('sharing violation'), { code: 'EPERM' });
    }
    return rename(...args);
  });
  f.emit('agent_start');
  assert.equal(denied, 3);
  assert.equal(f.read('status.json').status, 'working');
});

test('native Windows Git Bash launcher completes through the runtime without terminal prompts', { skip: process.platform !== 'win32' }, async t => {
  const bash = 'C:/Program Files/Git/bin/bash.exe';
  if (!fs.existsSync(bash) || spawnSync(bash, ['-c', 'type -P jq >/dev/null && type -P flock >/dev/null']).status !== 0) {
    t.skip('Git Bash with jq and flock is required for the launcher integration test');
    return;
  }
  const f = fixture(t);
  fs.mkdirSync(join(f.home, 'bin'));
  for (const [suffix, value] of Object.entries({ session: 'cc-test', agent: 'pi', role: 'reviewer', machine: 'local' })) {
    fs.writeFileSync(join(f.state, `sc-windows-test.${suffix}`), `${value}\n`);
  }
  const stub = join(f.home, 'herdr.cjs');
  fs.writeFileSync(stub, `const a=process.argv.slice(2);let result;
    if(a[0]==='agent'&&a[1]==='get')result={agent:{agent:'pi',agent_status:'idle',pane_id:'fixture:p1'}};
    else if(a[0]==='pane'&&a[1]==='process-info')result={process_info:{foreground_processes:[{pid:${process.pid},argv:['node','pi','--session-id','cc-test']}]}};
    else {console.error('unexpected Herdr terminal operation: '+a);process.exit(1)}
    console.log(JSON.stringify({result}));`);
  fs.writeFileSync(join(f.home, 'bin', 'herdr'), `#!/usr/bin/env bash\nexec node '${stub.replace(/\\/g, '/')}' "$@"\n`);
  const launcher = fileURLToPath(new URL('../scripts/sidecar', import.meta.url));
  const child = spawn(bash, ['-c', 'export HOME="$(cygpath -u "$1")"; export PATH="$HOME/bin:$PATH"; exec bash "$2" ask "Native Windows fixture"', '--', f.home, launcher],
    { env: { ...process.env, USERPROFILE: f.home, HERDR_ENV: '1', HERDR_PANE_ID: 'fixture:p1', SIDECAR_AGENT: 'sc-windows-test' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data);
  child.stderr.on('data', data => stderr += data);
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const done = new Promise(resolve => child.on('exit', code => resolve(code)));
  for (let end = Date.now() + 30000; Date.now() < end && !f.messages.length && child.exitCode === null;) await sleep(50);
  assert.equal(child.exitCode, null, stderr);
  assert.equal(f.messages.length, 1, `No native delivery. stdout: ${stdout}; stderr: ${stderr}`);
  f.seen(0);
  const id = f.messages[0].message.content.match(/\[request ([^\]]+)\]/)[1];
  fs.mkdirSync(join(f.state, 'reports'), { recursive: true });
  fs.writeFileSync(join(f.state, 'reports', `${id}.md`), 'Native Windows report received\n');
  f.emit('agent_settled');
  assert.equal(await done, 0, stderr);
  assert.match(stdout, /Native Windows report received/);
  assert.match(f.messages[0].message.content, /Read [A-Za-z]:\//);
});

test('Windows reloading replaces its runtime token and does not retain watchers', t => {
  const f = fixture(t);
  const first = f.read('owner.json');
  f.emit('session_start');
  assert.notEqual(f.read('owner.json').token, first.token);
  f.emit('session_shutdown');
  assert.equal(fs.existsSync(join(f.dir, 'owner.json')), false);
});
