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
function fixture(t, { start = true } = {}) {
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
  if (start) handlers.get('session_start')({}, ctx);
  const emit = (event, data = {}) => handlers.get(event)?.(data, ctx);
  const seen = index => emit('message_end', { message: { role: 'custom', ...messages[index].message } });
  const read = file => JSON.parse(fs.readFileSync(join(dir, file), 'utf8'));
  t.after(() => { emit('session_shutdown'); fs.rmSync(home, { recursive: true, force: true }); });
  function run(action, overrides = {}, text = 'request text', beforeClient = '') {
    const options = { action, session: 'cc-test', pid: process.pid, progress: 0, startupTimeout: 1000, ...overrides };
    const source = `const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const args=${JSON.stringify([JSON.stringify(options)])};const text=${JSON.stringify(text)};\n${beforeClient}\n${client}`;
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

test('Windows readiness waits for session_start without sending any message', async t => {
  const f = fixture(t, { start: false });
  const operation = f.run('ready', { startupTimeout: 3000 });
  await sleep(400);
  assert.equal(operation.child.exitCode, null);
  f.emit('session_start');
  const result = await operation.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.messages.length, 0);
  assert.equal(fs.readdirSync(f.dir).some(file => file.endsWith('.inbox')), false);
});

test('Windows readiness waits for the matching heartbeat after owner publication', async t => {
  const f = fixture(t), owner = f.read('owner.json');
  f.emit('session_shutdown');
  fs.writeFileSync(join(f.dir, 'owner.json'), JSON.stringify(owner));
  fs.writeFileSync(join(f.dir, 'status.json'), JSON.stringify({ ...owner, updated: 0, status: 'idle' }));
  const operation = f.run('ready', { startupTimeout: 3000 });
  await sleep(400);
  assert.equal(operation.child.exitCode, null);
  f.emit('session_start');
  assert.equal((await operation.done).code, 0);
  assert.equal(f.messages.length, 0);
});

test('Windows readiness is bounded, sends nothing, and does not slow down status probes', async t => {
  const f = fixture(t, { start: false });
  const operation = f.run('ready', { startupTimeout: 500 });
  assert.equal((await f.run('status').done).code, 1);
  const result = await operation.done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /timed out waiting.*control receiver/);
  assert.match(result.stderr, /nothing was sent/);
  assert.equal(fs.existsSync(f.dir), false);
});

test('Windows readiness rejects a live foreign owner and an exited pane process', async t => {
  const f = fixture(t);
  const foreign = await f.run('ready', { pid: process.pid + 12345 }, 'unused',
    `process.kill=()=>true;require('child_process').execFileSync=()=>{throw Error('no ancestry')};`).done;
  assert.equal(foreign.code, 1);
  assert.match(foreign.stderr, /does not match/);
  const exited = await f.run('ready', {}, 'unused',
    `process.kill=()=>{throw Object.assign(Error('exited'),{code:'ESRCH'})};`).done;
  assert.equal(exited.code, 1);
  assert.match(exited.stderr, /process exited before/);
  assert.equal(f.messages.length, 0);
});

test('Windows readiness tolerates a dead previous owner until the new runtime replaces it', async t => {
  const f = fixture(t), owner = f.read('owner.json');
  f.emit('session_shutdown');
  fs.writeFileSync(join(f.dir, 'owner.json'), JSON.stringify({ ...owner, pid: 2147483647 }));
  const operation = f.run('ready', { startupTimeout: 3000 }, 'unused',
    `require('child_process').execFileSync=()=>{throw Error('no ancestry')};`);
  await sleep(400);
  assert.equal(operation.child.exitCode, null);
  f.emit('session_start');
  assert.equal((await operation.done).code, 0);
  assert.equal(f.messages.length, 0);
});

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

test('aborting discarded unseen requests and notes releases their waiters and the reload idle guard', { timeout: 5000 }, async t => {
  const f = fixture(t);
  for (const action of ['request', 'note']) {
    const index = f.messages.length;
    const operation = f.run(action);
    await until(() => f.messages.length === index + 1);
    // Pi's Escape path clears queued custom messages before emitting aborted settlement.
    f.emit('agent_settled', { aborted: true });
    const result = await operation.done;
    assert.equal(result.code, 6, result.stderr);
    assert.match(result.stderr, /aborted.*before.*confirmed/);
    assert.match(result.stderr, /before resending/);
    assert.equal(f.read('status.json').status, 'idle');
    assert.equal((await f.run('wait').done).code, 0);
  }
});

test('aborting an already acknowledged queued steer does not leave the runtime busy', async t => {
  const f = fixture(t);
  const steer = f.run('steer');
  await until(() => f.messages.length === 1);
  assert.equal((await steer.done).code, 0);
  f.emit('agent_settled', { aborted: true });
  assert.equal(f.read('status.json').status, 'idle');
  assert.equal((await f.run('wait').done).code, 0);
});

test('aborted settlement preserves unseen messages when Pi still has queued work', async t => {
  const f = fixture(t);
  const operation = f.run('request');
  await until(() => f.messages.length === 1);
  f.ctx.hasPendingMessages = () => true;
  f.emit('agent_settled', { aborted: true });
  await sleep(300);
  assert.equal(operation.child.exitCode, null);
  assert.equal(f.read('status.json').status, 'working');
  f.ctx.hasPendingMessages = () => false;
  f.seen(0);
  f.emit('agent_settled');
  assert.equal((await operation.done).code, 2);
});

test('a completed report survives immediate runtime shutdown or replacement', async t => {
  const f = fixture(t);
  for (const event of ['session_shutdown', 'session_start']) {
    if (event === 'session_start') f.emit('session_start');
    const report = join(f.home, `${event}.md`), index = f.messages.length;
    const operation = f.run('request', { report });
    await until(() => f.messages.length === index + 1);
    fs.writeFileSync(report, 'complete report');
    f.emit(event);
    const result = await operation.done;
    assert.equal(result.code, 0, result.stderr);
  }
});

test('a report published during the liveness check also takes precedence over shutdown', async t => {
  const f = fixture(t), report = join(f.home, 'raced-report.md');
  const beforeClient = `const originalRead=fs.readFileSync;
    fs.readFileSync=function(file,...rest){
      if(String(file)===${JSON.stringify(join(f.dir, 'owner.json'))} && fs.readdirSync(${JSON.stringify(f.dir)}).some(f=>f.endsWith('.inbox'))){
        fs.writeFileSync(${JSON.stringify(report)},'complete raced report');
        fs.rmSync(file,{force:true});
      }
      return originalRead.call(fs,file,...rest);
    };`;
  const result = await f.run('request', { report }, 'request text', beforeClient).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(report, 'utf8'), 'complete raced report');
});

test('a completed report also wins over a thrown Windows sharing violation during liveness checks', async t => {
  const f = fixture(t), report = join(f.home, 'sharing-raced-report.md');
  const beforeClient = `const originalRead=fs.readFileSync;
    fs.readFileSync=function(file,...rest){
      if(String(file)===${JSON.stringify(join(f.dir, 'owner.json'))} && fs.readdirSync(${JSON.stringify(f.dir)}).some(f=>f.endsWith('.inbox'))){
        fs.writeFileSync(${JSON.stringify(report)},'complete report before EBUSY');
        throw Object.assign(Error('Windows sharing violation'),{code:'EBUSY'});
      }
      return originalRead.call(fs,file,...rest);
    };`;
  const result = await f.run('request', { report }, 'request text', beforeClient).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(report, 'utf8'), 'complete report before EBUSY');
});

test('ownership loss without a report still fails instead of claiming completion', async t => {
  const f = fixture(t);
  const operation = f.run('request');
  await until(() => f.messages.length === 1);
  f.emit('session_shutdown');
  const result = await operation.done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /owner changed|heartbeat is missing or stale/);
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

test('Windows heartbeat survives exhausted status retries and recovers without changing agent state', async t => {
  let tick;
  t.mock.method(globalThis, 'setInterval', callback => {
    tick = callback;
    return { unref() {} };
  });
  const f = fixture(t), previous = f.read('status.json');
  const notifications = [];
  f.ctx.ui.notify = (...args) => notifications.push(args);
  // Leave a stale but complete record: failed writes must not fake a healthy heartbeat.
  previous.updated = Date.now() - 20000;
  fs.writeFileSync(join(f.dir, 'status.json'), JSON.stringify(previous));
  const rename = fs.renameSync;
  let locked = true, denied = 0;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (locked && args[1] === join(f.dir, 'status.json')) {
      denied++;
      throw Object.assign(Error('sharing violation'), { code: 'EPERM' });
    }
    return rename(...args);
  });
  assert.doesNotThrow(() => tick());
  assert.doesNotThrow(() => tick());
  assert.equal(denied, 52);
  assert.deepEqual(f.read('status.json'), previous);
  assert.equal(fs.readdirSync(f.dir).some(file => file.endsWith('.tmp')), false);
  assert.equal(notifications.length, 1, 'persistent locks must not flood the pane');
  assert.match(notifications[0][0], /EPERM|sharing violation/);
  const stale = await f.run('status').done;
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /heartbeat is missing or stale/);
  locked = false;
  tick();
  assert.equal(f.read('status.json').status, 'idle');
  assert.ok(f.read('status.json').updated > previous.updated);
  locked = true;
  assert.doesNotThrow(() => tick());
  assert.equal(notifications.length, 2, 'a new outage must be reported after recovery');
});

test('Windows status locks do not interrupt startup or agent and approval transitions', t => {
  let tick;
  t.mock.method(globalThis, 'setInterval', callback => {
    tick = callback;
    return { unref() {} };
  });
  const f = fixture(t, { start: false });
  const rename = fs.renameSync;
  let locked = true;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (locked && args[1] === join(f.dir, 'status.json')) {
      throw Object.assign(Error('sharing violation'), { code: 'EPERM' });
    }
    return rename(...args);
  });
  assert.doesNotThrow(() => f.emit('session_start'));
  assert.doesNotThrow(() => f.emit('agent_start'));
  assert.doesNotThrow(() => f.emit('ui_prompt_start'));
  locked = false;
  tick();
  assert.equal(f.read('status.json').status, 'blocked');
  locked = true;
  assert.doesNotThrow(() => f.emit('agent_settled'));
  locked = false;
  tick();
  assert.equal(f.read('status.json').status, 'idle');
  locked = true;
  assert.doesNotThrow(() => f.emit('agent_start'));
  locked = false;
  tick();
  assert.equal(f.read('status.json').status, 'working');
});

function nativeLauncherFixture(t, { start = true } = {}) {
  const bash = 'C:/Program Files/Git/bin/bash.exe';
  if (!fs.existsSync(bash) || spawnSync(bash, ['-c', 'type -P jq >/dev/null && type -P flock >/dev/null']).status !== 0) {
    t.skip('Git Bash with jq and flock is required for the launcher integration test');
    return;
  }
  const f = fixture(t, { start });
  fs.mkdirSync(f.state, { recursive: true });
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
  const node = process.execPath.replace(/\\/g, '/');
  fs.writeFileSync(join(f.home, 'bin', 'node'), `#!/usr/bin/env bash
    if [[ $1 == -e && $2 == *'eval(fs.readFileSync(0'* ]]; then
      program=$2; shift 2
      exec '${node}' -e "require('node:fs').writeFileSync(process.env.CONTROL_PID_FILE,String(process.pid));$program" "$@"
    fi
    exec '${node}' "$@"
`);
  const launcher = fileURLToPath(new URL('../scripts/sidecar', import.meta.url));
  const child = spawn(bash, ['-c', 'export HOME="$(cygpath -u "$1")"; export PATH="$HOME/bin:$PATH"; printf "%s\\n" "$$" > "$HOME/launcher.pid"; exec bash "$2" ask "Native Windows fixture"', '--', f.home, launcher],
    { env: { ...process.env, USERPROFILE: f.home, HERDR_ENV: '1', HERDR_PANE_ID: 'fixture:p1', SIDECAR_AGENT: 'sc-windows-test',
      SIDECAR_PI_SESSION: '', SIDECAR_MACHINE: '', CONTROL_PID_FILE: join(f.home, 'client.pid') } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data);
  child.stderr.on('data', data => stderr += data);
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const done = new Promise(resolve => child.on('exit', code => resolve(code)));
  const waitForMessage = async () => {
    for (let end = Date.now() + 30000; Date.now() < end && !f.messages.length && child.exitCode === null;) await sleep(50);
    assert.equal(child.exitCode, null, stderr);
    assert.equal(f.messages.length, 1, `No native delivery. stdout: ${stdout}; stderr: ${stderr}`);
  };
  const publishReport = () => {
    const id = f.messages[0].message.content.match(/\[request ([^\]]+)\]/)[1];
    fs.mkdirSync(join(f.state, 'reports'), { recursive: true });
    fs.writeFileSync(join(f.state, 'reports', `${id}.md`), 'Native Windows report received\n');
  };
  return { ...f, bash, child, done, waitForMessage, publishReport, output: () => ({ stdout, stderr }) };
}

test('native Windows Git Bash launcher completes through the runtime without terminal prompts', { skip: process.platform !== 'win32' }, async t => {
  const f = nativeLauncherFixture(t);
  if (!f) return;
  await f.waitForMessage();
  f.seen(0);
  f.publishReport();
  f.emit('agent_settled');
  assert.equal(await f.done, 0, f.output().stderr);
  assert.match(f.output().stdout, /Native Windows report received/);
  assert.match(f.messages[0].message.content, /Read [A-Za-z]:\//);
});

test('native Windows launcher waits for delayed receiver initialization in an existing pane', { skip: process.platform !== 'win32' }, async t => {
  const f = nativeLauncherFixture(t, { start: false });
  if (!f) return;
  await until(() => fs.existsSync(join(f.home, 'client.pid')));
  await sleep(400);
  assert.equal(f.child.exitCode, null, f.output().stderr);
  assert.equal(f.messages.length, 0);
  f.emit('session_start');
  await f.waitForMessage();
  f.seen(0);
  f.publishReport();
  f.emit('agent_settled');
  assert.equal(await f.done, 0, f.output().stderr);
});

test('native Windows SIGTERM cancels the launcher promptly, reaps its client, and releases the slot', { skip: process.platform !== 'win32' }, async t => {
  const f = nativeLauncherFixture(t);
  if (!f) return;
  await f.waitForMessage();
  const clientPid = Number(fs.readFileSync(join(f.home, 'client.pid'), 'utf8'));
  const launcherPid = fs.readFileSync(join(f.home, 'launcher.pid'), 'utf8').trim();
  // Node.kill() uses TerminateProcess; send an actual MSYS signal to exercise Bash's trapped SIGTERM instead.
  const signal = spawnSync(f.bash, ['-c', 'kill -TERM "$1"', '--', launcherPid]);
  assert.equal(signal.status, 0, signal.stderr.toString());
  await Promise.race([f.done, sleep(8000)]);
  const cancelledPromptly = f.child.exitCode !== null;
  // If a regression defers TERM, release the old foreground wait so the failed test still cleans up its child.
  if (!cancelledPromptly) { f.publishReport(); await f.done; }
  assert.equal(cancelledPromptly, true, f.output().stderr);
  assert.equal(f.child.exitCode, 143, f.output().stderr);
  const request = JSON.parse(fs.readFileSync(join(f.state, 'sc-windows-test.request.json'), 'utf8'));
  assert.equal(request.exit_code, 143);
  assert.ok(request.finished);
  assert.equal(fs.existsSync(join(f.state, 'sc-windows-test.inflight')), false);
  assert.equal(fs.readdirSync(f.state).filter(name => name.startsWith('windows-control.')).length, 0);
  assert.throws(() => process.kill(clientPid, 0), /ESRCH/);
  const lock = spawnSync(f.bash, ['-c', 'exec 9>"$(cygpath -u "$1")"; flock -n 9', '--', join(f.state, 'sc-windows-test.lock')]);
  assert.equal(lock.status, 0, lock.stderr.toString());
});

test('native Windows lock-waiting launcher remains cancellable before admission', { skip: process.platform !== 'win32' }, async t => {
  const bash = 'C:/Program Files/Git/bin/bash.exe';
  if (!fs.existsSync(bash) || spawnSync(bash, ['-c', 'type -P flock >/dev/null']).status !== 0) {
    t.skip('Git Bash with flock is required for the launcher lock test');
    return;
  }
  const f = fixture(t), lockPath = join(f.state, 'sc-windows-test.lock');
  const holder = spawn(bash, ['-c', 'exec 9>"$(cygpath -u "$1")"; flock 9; echo locked; read -r release', '--', lockPath]);
  let held = '';
  holder.stdout.on('data', data => held += data);
  const unlocked = new Promise(resolve => holder.on('exit', resolve));
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  await until(() => held.includes('locked'));
  const launcher = fileURLToPath(new URL('../scripts/sidecar', import.meta.url));
  const child = spawn(bash, ['-c', 'export HOME="$(cygpath -u "$1")"; printf "%s\\n" "$$" > "$HOME/lock-launcher.pid"; exec bash "$2" wait', '--', f.home, launcher],
    { env: { ...process.env, USERPROFILE: f.home, SIDECAR_AGENT: 'sc-windows-test' } });
  const done = new Promise(resolve => child.on('exit', resolve));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await until(() => fs.existsSync(join(f.home, 'lock-launcher.pid')));
  await sleep(350); // Let the launcher block in foreground flock.
  const pid = fs.readFileSync(join(f.home, 'lock-launcher.pid'), 'utf8').trim();
  assert.equal(spawnSync(bash, ['-c', 'kill -TERM "$1"', '--', pid]).status, 0);
  await Promise.race([done, sleep(3000)]);
  const cancelledBeforeUnlock = child.exitCode !== null;
  holder.stdin.end('release\n');
  await unlocked;
  await done;
  assert.equal(cancelledBeforeUnlock, true, 'TERM must not wait for the original request to release its slot');
});

test('Windows reloading replaces its runtime token and does not retain watchers', t => {
  const f = fixture(t);
  const first = f.read('owner.json');
  f.emit('session_start');
  assert.notEqual(f.read('owner.json').token, first.token);
  f.emit('session_shutdown');
  assert.equal(fs.existsSync(join(f.dir, 'owner.json')), false);
});
