import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const backend = fs.readFileSync(new URL('../scripts/mux/herdr', import.meta.url), 'utf8');
const hd = backend.match(/^hd\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(hd, 'the herdr backend must define its Herdr invocation boundary');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test('Herdr preserves remote arguments without changing local paths or Linux behavior', t => {
  const windows = process.platform === 'win32';
  const bash = windows ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  if (windows && !fs.existsSync(bash)) { t.skip('Git Bash is required'); return; }
  const home = fs.mkdtempSync(join(tmpdir(), 'sidecar-paths-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const helper = join(home, 'herdr.cjs');
  fs.writeFileSync(helper, `console.log(JSON.stringify({args:process.argv.slice(2),
    conversion:process.env.MSYS2_ARG_CONV_EXCL??null,noConversion:process.env.MSYS_NO_PATHCONV??null}));`);
  const args = ['agent', 'start', 'reviewer', '--', '-e', '/home/bjorn/git/sidecar with spaces/sidecar.ts',
    '--append-system-prompt', '/home/bjorn/git/claude-sidecar/sidecar/reviewer.md'];
  const env = { ...process.env };
  delete env.MSYS2_ARG_CONV_EXCL;
  delete env.MSYS_NO_PATHCONV;
  const script = `${hd}
    NODE=${quote(process.execPath.replaceAll('\\', '/'))}
    SCRIPT=${quote(helper.replaceAll('\\', '/'))}
    herdr() { "$NODE" "$SCRIPT" "$@"; }
    HOST_WINDOWS=${windows ? '1' : ''}
    MACHINE=
    hd "$@"
    MACHINE=remote-machine
    hd "$@"
    MACHINE=
    hd "$@"
  `;
  const result = spawnSync(bash, ['-c', script, '--', ...args], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const [local, remote, afterRemote] = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(remote.args, ['--machine', 'remote-machine', ...args]);
  assert.deepEqual(afterRemote, local, 'remote conversion settings must not leak to local Herdr');
  assert.equal(local.conversion, null);
  assert.equal(local.noConversion, null);
  if (windows) {
    assert.equal(remote.conversion, '*');
    assert.equal(remote.noConversion, '1');
    assert.notDeepEqual(local.args, args, 'exercise real Git Bash conversion, not a simulated shell');
  } else {
    assert.deepEqual(local.args, args);
    assert.equal(remote.conversion, null);
    assert.equal(remote.noConversion, null);
  }
});
