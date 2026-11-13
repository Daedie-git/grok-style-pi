"""Launcher tests on the Herdr app backend, with a fake hc executable and isolated HOME."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

from test_sidecar import NODE_DIR, ROOT, SSH

# Terminals live in hc.json; t1 is Claude's own. A machine/tN address belongs to that machine, whose home differs.
HC = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
home = pathlib.Path(os.environ['HOME'])
with (home / 'calls.jsonl').open('a') as log:
    log.write(json.dumps(args) + '\n')
if args[0] == 'send' and os.environ.get('HC_TERMINAL_ID'):
    # hc would wrap the text as <hc from=...>.
    print('send carries the caller identity', file=sys.stderr)
    sys.exit(9)
state_path = home / 'hc.json'
state = json.loads(state_path.read_text()) if state_path.exists() else {'next': 2, 'terminals': {
    't1': {'address': 't1', 'state': 'live', 'status': {'app': 'claude-code', 'state': 'working'}, 'labels': {}}}}
machines = json.loads((home / 'hc-machines.json').read_text()) if (home / 'hc-machines.json').exists() else []
def save():
    state_path.write_text(json.dumps(state))
def take(flag, default=None):
    if flag in args:
        i = args.index(flag)
        value = args[i + 1]
        del args[i:i + 2]
        return value
    return default
def drop(*flags):
    for flag in flags:
        while flag in args:
            args.remove(flag)
def terminal(address):
    found = state['terminals'].get(address)
    if not found:
        print(json.dumps({'error': {'kind': 'not_found', 'message': 'no terminal'}}))
        sys.exit(3)
    return found
def data_home(address):
    if '/' not in address:
        return home
    name = address.split('/')[0]
    return home / 'remote' / next(m['target'] for m in machines if m['name'] == name)
command = args.pop(0)
drop('--json')
if command == 'run' and os.environ.get('FAKE_RUN_FAIL'):
    print('ssh: connection reset', file=sys.stderr)
    sys.exit(1)
if command == 'run':
    drop('--bg', '--no-notify', '--outlive-parent')
    parent, on, cwd, name = take('--parent', os.environ.get('HC_TERMINAL_ID')), take('--on'), take('--cwd'), take('--name')
    if name and any(t.get('name') == name and t['state'] == 'live' for t in state['terminals'].values()):
        print(json.dumps({'error': {'kind': 'name_taken', 'message': 'name taken'}}))
        sys.exit(3)
    labels = {}
    while '--label' in args:
        key, value = take('--label').split('=', 1)
        labels[key] = value
    if args[0] == '--':
        args.pop(0)
    address = (on + '/' if on else '') + 't' + str(state['next'])
    state['next'] += 1
    app = {'pi': 'pi', 'claude': 'claude-code'}.get(args[0])
    if args[0] == 'pi':
        # The sidecar extension's receipt for the session this pi runs.
        session = args[args.index('--session-id') + 1]
        receipts = data_home(address) / '.cache/claude-sidecar/reload'
        receipts.mkdir(parents=True, exist_ok=True)
        (receipts / (session + '.ready')).write_text(json.dumps({'pid': 4242, 'sessionFile': '/s/' + session + '.jsonl'}))
    state['terminals'][address] = {'address': address, 'state': 'live', 'parent': parent, 'cwd': cwd, 'labels': labels, 'name': name,
                                   'status': {'app': app, 'state': 'idle'}, 'argv': args,
                                   # pi retitles its process, so the foreground argv carries no flags.
                                   'foreground': {'pid': 4242, 'argv': ['pi'] if args[0] == 'pi' else args}}
    save()
    print(json.dumps({'address': address, 'state': 'live'}))
elif command == 'ls':
    want = dict(item.split('=', 1) for item in [take('--label')] if item)
    print(json.dumps({'terminals': [t for t in state['terminals'].values() if t['state'] == 'live'
                                    and all(t['labels'].get(k) == v for k, v in want.items())]}))
elif command == 'get':
    print(json.dumps(terminal(args[0])))
elif command == 'send':
    drop('--wait')
    take('--timeout')
    address, text = args
    terminal(address)
    if text.startswith('/sidecar-reload ') or text == '/reload':
        directory = data_home(address) / '.cache/claude-sidecar/reload'
        for marker in directory.glob('*.pending'):
            request = json.loads(marker.read_text())
            (directory / (request['id'] + '.ack')).write_text(json.dumps({'status': 'reloaded'}))
            marker.unlink()
    if text.startswith('[request '):
        request_id = text.split(']', 1)[0].split()[1]
        reports = data_home(address) / '.cache/claude-sidecar/reports'
        reports.mkdir(parents=True, exist_ok=True)
        if not os.environ.get('FAKE_NO_REPORT'):
            (reports / (request_id + '.md')).write_text('## Verdict\nhc ship\n')
    print(json.dumps({'status': 'idle'}))
elif command == 'wait':
    take('--timeout')
    print(json.dumps({'status': terminal(args[0])['status']['state']}))
elif command == 'read':
    print('earlier line\nreading src/foo.ts')
elif command == 'kill':
    terminal(args[0])['state'] = 'finished'
    save()
    print(json.dumps({'address': args[0]}))
elif command == 'rm':
    state['terminals'].pop(args[0], None)
    save()
    print(json.dumps({'removed': args[0]}))
elif command == 'label':
    address = args.pop(0)
    for item in args:
        key, value = item.split('=', 1)
        terminal(address)['labels'][key] = value
    save()
    print('{}')
elif command == 'machine' and args[0] == 'ls':
    print(json.dumps({'machines': machines}))
else:
    print('unexpected hc call ' + json.dumps(args), file=sys.stderr)
    sys.exit(2)
'''


class HcTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.state = self.home / '.cache/claude-sidecar'
        self.state.mkdir(parents=True)
        (self.state / 'sweep-hc.timestamp').write_text(str(int(time.time())))
        self.plugin = self.home / 'plugin'
        shutil.copytree(ROOT / 'scripts', self.plugin / 'scripts')
        shutil.copytree(ROOT / 'sidecar', self.plugin / 'sidecar')
        self.launcher = self.plugin / 'scripts/sidecar'
        bin_dir = self.home / 'bin'
        bin_dir.mkdir()
        for name, source in (('hc', HC), ('ssh', SSH), ('pi', '#!/bin/sh\nexit 0\n')):
            (bin_dir / name).write_text(source)
            (bin_dir / name).chmod(0o755)
        self.env = dict(os.environ, HOME=str(self.home), PATH=f'{bin_dir}:/usr/bin:/bin:{NODE_DIR}',
                        HC_TERMINAL_ID='t1', SIDECAR_CLOSE_WHEN_DONE='0')
        for key in ('HERDR_ENV', 'HERDR_PANE_ID', 'SIDECAR_AGENT', 'SIDECAR_PI_SESSION', 'SIDECAR_MODEL', 'SIDECAR_MUX',
                    'SIDECAR_THINKING', 'CLAUDE_ENV_FILE', 'SIDECAR_MACHINE', 'SIDECAR_REMOTE_HOME', 'HC_SCOPE'):
            self.env.pop(key, None)

    def run_cli(self, *args, env=None, check=True):
        return subprocess.run([str(self.launcher), *args], input='', text=True, capture_output=True,
                              env=env or self.env, cwd=self.home, check=check)

    def calls(self):
        path = self.home / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def terminals(self):
        return json.loads((self.home / 'hc.json').read_text())['terminals']

    def test_ask_starts_one_labelled_child_terminal_and_returns_its_report(self):
        first = self.run_cli('ask', 'Task')
        self.assertIn('hc ship', first.stdout)
        self.run_cli('ask', 'Follow-up')
        runs = [c for c in self.calls() if c[0] == 'run']
        self.assertEqual(len(runs), 1)
        run = runs[0]
        for flag in ('--bg', '--no-notify', '--outlive-parent'):
            self.assertIn(flag, run)
        self.assertEqual(self.terminals()['t2']['parent'], 't1')
        self.assertEqual(run[run.index('--name') + 1], 'reviewer')
        self.assertIn('sidecar.agent=sc-hc-t1', run)
        argv = run[run.index('--') + 1:]
        self.assertEqual(argv[:3], ['pi', '--session-id', 'cc-pane-hc-t1'])
        self.assertFalse(any(c[0] == 'machine' for c in self.calls()))

    def test_stop_ends_the_terminal_and_the_next_request_resumes_the_session(self):
        self.run_cli('start')
        stopped = self.run_cli('stop')
        self.assertIn('sc-hc-t1 stopped (closed t2)', stopped.stdout)
        self.assertNotIn('t2', self.terminals())
        self.assertIn('stopped', self.run_cli('status').stdout)
        self.run_cli('ask', 'Again')
        argv = [c for c in self.calls() if c[0] == 'run'][-1]
        self.assertIn('cc-pane-hc-t1', argv)

    def test_restart_relabels_a_pi_that_switched_sessions_and_starts_another(self):
        self.run_cli('start')
        # /new in the sidecar's pi moves its receipt to the new session; the launch argv still names the old one.
        (self.state / 'reload/cc-pane-hc-t1.ready').unlink()
        result = self.run_cli('restart')
        self.assertTrue(self.terminals()['t2']['labels']['sidecar.agent'].startswith('sc-hc-t1-other-'), result.stderr)
        self.assertEqual(self.terminals()['t3']['labels']['sidecar.agent'], 'sc-hc-t1')

    def test_a_taken_name_falls_back_to_one_with_claudes_terminal(self):
        self.run_cli('--slot', '2', '--role', 'implementer', 'start')
        self.run_cli('--slot', '2', '--role', 'implementer', 'start', env=dict(self.env, HC_TERMINAL_ID='t9'))
        names = sorted(t['name'] for t in self.terminals().values() if t.get('name'))
        self.assertEqual(names, ['implementer-2', 'implementer-2-t9'])

    def test_a_failed_launch_is_not_retried_under_another_name(self):
        result = self.run_cli('start', env=dict(self.env, FAKE_RUN_FAIL='1'), check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len([c for c in self.calls() if c[0] == 'run']), 1)

    def test_reload_sends_a_bare_slash_command(self):
        self.run_cli('start')
        result = self.run_cli('reload')
        self.assertIn('reloaded between requests', result.stdout)
        self.assertTrue(any(c[0] == 'send' and c[-1].startswith('/') for c in self.calls()))

    def test_a_recent_herdr_sweep_does_not_hold_back_the_hc_sweep(self):
        (self.state / 'sweep.timestamp').write_text(str(int(time.time())))
        (self.state / 'sweep-hc.timestamp').unlink()
        self.run_cli('status')
        deadline = time.monotonic() + 10
        while not any(c[0] == 'ls' and '--label' not in c for c in self.calls()):
            self.assertLess(time.monotonic(), deadline, 'the hc sweep did not run')
            time.sleep(0.1)

    def test_claude_agent_starts_claude_with_its_session_uuid(self):
        self.run_cli('--agent', 'claude', 'ask', 'Task')
        argv = [c for c in self.calls() if c[0] == 'run'][0]
        argv = argv[argv.index('--') + 1:]
        self.assertEqual(argv[0], 'claude')
        self.assertEqual(argv[1], '--session-id')

    def test_sweep_closes_slots_of_a_gone_owner_and_ignores_herdr_slots(self):
        self.run_cli('start')
        # A herdr slot of another owner must not be judged by hc.
        for suffix, text in (('agent', 'pi'), ('owner', 'sc-w1-p1'), ('owner-pane', 'w1:p1'), ('mux', 'herdr')):
            (self.state / f'sc-w1-p1.{suffix}').write_text(text + '\n')
        self.run_cli('sweep')
        self.assertEqual(self.terminals()['t2']['state'], 'live')
        state = json.loads((self.home / 'hc.json').read_text())
        del state['terminals']['t1']
        (self.home / 'hc.json').write_text(json.dumps(state))
        self.run_cli('sweep')
        self.assertNotIn('t2', self.terminals())
        self.assertFalse(any(c[:2] == ['get', 'w1:p1'] for c in self.calls()))

    def test_remote_slot_runs_on_the_hc_machine(self):
        (self.home / 'hc-machines.json').write_text(json.dumps([
            {'id': 'abc', 'name': 'hermes', 'target': 'hermes-cloud', 'state': 'connected'}]))
        runtime = self.home / 'remote/hermes-cloud' / self.plugin.relative_to(self.home) / 'sidecar'
        shutil.copytree(self.plugin / 'sidecar', runtime)
        result = self.run_cli('--machine', 'hermes', '--remote-cwd', str(self.home), 'ask', 'Remote task',
                              env=dict(self.env, SIDECAR_MACHINE_TAG='tt01'))
        self.assertIn('hc ship', result.stdout)
        run = [c for c in self.calls() if c[0] == 'run'][0]
        self.assertEqual(run[run.index('--on') + 1], 'hermes')
        # An explicit --parent would be resolved on hermes; hc's default parent is the calling terminal.
        self.assertNotIn('--parent', run)
        self.assertEqual(run[run.index('--name') + 1], 'hermes-reviewer')
        self.assertIn('sidecar.agent=sc-tt01-hc-t1', run)
        self.assertEqual((self.state / 'sc-hc-t1.machine').read_text().split('\n')[0], 'abc')

    def test_outside_any_host_session_start_does_nothing(self):
        env = dict(self.env)
        env.pop('HC_TERMINAL_ID')
        result = self.run_cli('session-start', env=env)
        self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
