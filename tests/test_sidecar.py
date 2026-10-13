"""Launcher integration tests with isolated HOME and a fake Herdr executable."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
import signal
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
NODE_DIR = str(Path(shutil.which('node') or '/usr/bin/node').parent)

HERDR = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, time
args = sys.argv[1:]
home = pathlib.Path(os.environ['HOME'])
# Herdr before 0.9 has no `machine` command.
machine = None
if args[0] == '--machine':
    machine, args = args[1], args[2:]
if args[:2] == ['machine', 'list']:
    listing = home / 'machines.json'
    if not listing.exists():
        print('error: unknown command machine', file=sys.stderr)
        sys.exit(2)
    print(listing.read_text())
    sys.exit(0)
# A machine is a separate herdr server: its own panes and agents, and the sidecar's home is the machine's home.
state_dir, data_home = home, home
if machine:
    target = next(m['target'] for m in json.loads((home / 'machines.json').read_text()) if m['id'] == machine)
    state_dir = home / 'remote-state' / machine
    state_dir.mkdir(parents=True, exist_ok=True)
    data_home = home / 'remote' / target
name = args[2] if args[0] == 'agent' else ''
state_path = state_dir / ('agent.json' if name == 'sc-pane-1' else name + '.agent.json')
state = json.loads(state_path.read_text()) if state_path.exists() else None
with (home / 'calls.jsonl').open('a') as log:
    log.write(json.dumps((['--machine', machine] if machine else []) + args) + '\n')
panes_path = state_dir / 'panes.json'
if args[:2] == ['agent', 'start']:
    time.sleep(float(os.environ.get('HERDR_START_DELAY', '0')))
# Serialize pane state updates from concurrent launchers.
if args[0] in ('pane', 'tab') or args[:2] == ['agent', 'start']:
    import fcntl
    lock = (state_dir / 'panes.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX)
# Panes in list order, which is spatial within a tab as in Herdr's layout output.
panes = json.loads(panes_path.read_text()) if panes_path.exists() else [] if machine else [
    {'pane_id': 'PANE:1', 'tab_id': 't1', 'workspace_id': 'workspace-1', 'agent': 'claude', 'width': 324, 'height': 97}]
def pane_info(p):
    return {k: p.get(k) for k in ('pane_id', 'tab_id', 'workspace_id', 'agent', 'cwd')}
def find(pane_id):
    return next(p for p in panes if p['pane_id'] == pane_id)
if args[:2] == ['pane', 'layout']:
    tab = find(args[args.index('--pane') + 1])['tab_id']
    print(json.dumps({'result': {'layout': {'tab_id': tab, 'panes': [
        {'pane_id': p['pane_id'], 'rect': {'width': p['width'], 'height': p['height']}}
        for p in panes if p['tab_id'] == tab]}}}))
elif args[:2] == ['pane', 'list']:
    print(json.dumps({'result': {'panes': [pane_info(p) for p in panes]}}))
elif args[:2] == ['pane', 'get']:
    print(json.dumps({'result': {'pane': pane_info(find(args[2]))}}))
elif args[:2] in (['pane', 'split'], ['tab', 'create']):
    # Herdr never reuses a closed pane's ID.
    counter_path = state_dir / 'pane-counter'
    number = int(counter_path.read_text()) + 1 if counter_path.exists() else max(len(panes), 1)
    counter_path.write_text(str(number))
    pane = {'pane_id': ('remote-pane-' if machine else 'review-pane-') + str(number), 'agent': None}
    if args[0] == 'tab':
        pane.update(tab_id='t' + str(len({p['tab_id'] for p in panes}) + 1),
                    workspace_id=args[args.index('--workspace') + 1] if '--workspace' in args else 'rw-new', width=324, height=97)
        panes.append(pane)
    else:
        target = find(args[args.index('--pane') + 1])
        key = 'width' if args[args.index('--direction') + 1] == 'right' else 'height'
        target[key] //= 2
        pane.update(tab_id=target['tab_id'], workspace_id=target['workspace_id'],
                    width=target['width'], height=target['height'])
        panes.insert(panes.index(target) + 1, pane)
    panes_path.write_text(json.dumps(panes))
    key = 'root_pane' if args[0] == 'tab' else 'pane'
    print(json.dumps({'result': {key: {'pane_id': pane['pane_id']}}}))
elif args[:2] == ['agent', 'get']:
    time.sleep(float(os.environ.get('HERDR_GET_DELAY', '0')))
    if state is None:
        sys.exit(1)
    if os.environ.get('FAKE_DELAYED_SESSION'):
        counter = state_dir / (name + '.session-probes')
        probes = int(counter.read_text()) if counter.exists() else 0
        counter.write_text(str(probes + 1))
        if probes < 2:
            state = dict(state, agent_session={'value': ''})
    if os.environ.get('FAKE_AGENT_WORKING'):
        state = dict(state, agent_status='working')
    print(json.dumps({'result': {'agent': state}}))
elif args[:2] == ['agent', 'start']:
    target = find(args[args.index('--pane') + 1])
    if target['agent'] is not None or target.get('busy'):
        print('agent_pane_busy', file=sys.stderr)
        sys.exit(1)
    kind = args[args.index('--kind') + 1] if '--kind' in args else 'pi'
    target['agent'] = kind
    panes_path.write_text(json.dumps(panes))
    session = args[args.index('--session-id' if '--session-id' in args else '--resume') + 1]
    with state_path.open('x') as output:
        json.dump({'agent': kind, 'agent_status': 'idle', 'agent_session': {'value': '/tmp/time_' + session + '.jsonl'}}, output)
elif args[:2] == ['agent', 'wait']:
    while state_path.exists() and json.loads(state_path.read_text())['agent_status'] == 'working':
        time.sleep(0.05)
elif args[:2] == ['agent', 'read']:
    print('earlier line\nreading src/foo.ts')
elif args[:2] == ['agent', 'rename']:
    state_path.unlink()
elif args[:2] == ['agent', 'prompt']:
    prompt = args[3]
    if prompt == '/reload' or prompt.startswith('/sidecar-reload '):
        if not os.environ.get('FAKE_NO_RELOAD'):
            session = state['agent_session']['value'].split('time_', 1)[1][:-6]
            directory = data_home / '.cache/claude-sidecar/reload'
            marker = directory / (session + '.pending')
            request = json.loads(marker.read_text())
            (directory / (request['id'] + '.ack')).write_text(json.dumps({'status': 'reloaded'}))
            marker.unlink()
    elif prompt.startswith('[request '):
        request_id = prompt.split(']', 1)[0].split()[1]
        reports = data_home / '.cache/claude-sidecar/reports'
        reports.mkdir(parents=True, exist_ok=True)
        time.sleep(float(os.environ.get('HERDR_PROMPT_DELAY', '0')))
        if os.environ.get('FAKE_NO_REPORT'):
            sys.exit(0)
        if os.environ.get('FAKE_LATE_REPORT'):
            # The turn outlives the prompt call: report lands later, then the agent settles.
            state['agent_status'] = 'working'
            state_path.write_text(json.dumps(state))
            import subprocess
            subprocess.Popen([sys.executable, '-c', (
                'import json,pathlib,time,sys;time.sleep(1);'
                'pathlib.Path(sys.argv[1]).write_text("## Verdict\\nlate ship\\n");'
                's=json.loads(pathlib.Path(sys.argv[2]).read_text());s["agent_status"]="idle";'
                'pathlib.Path(sys.argv[2]).write_text(json.dumps(s))'),
                str(reports / (request_id + '.md')), str(state_path)])
            sys.exit(0)
        (reports / (request_id + '.md')).write_text('## Verdict\nship\n')
        if os.environ.get('FAKE_QUESTION'):
            (reports / (request_id + '.needs-answer')).write_text(os.environ['FAKE_QUESTION'] + '\n')
'''


# Runs the command on a "machine" whose home differs from ours, as a real SSH login would.
SSH = r'''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys, time
args = sys.argv[1:]
home = pathlib.Path(os.environ['HOME'])
options = []
while args and args[0].startswith('-') and args[0] != '--':
    options.append(args.pop(0))
    if options[-1] == '-o':
        options.append(args.pop(0))
if args[0] == '--':
    args.pop(0)
target, command = args[0], args[1]
with (home / 'ssh-calls.jsonl').open('a') as log:
    log.write(json.dumps({'options': options, 'target': target, 'command': command}) + '\n')
time.sleep(float(os.environ.get('FAKE_SSH_DELAY', '0')))
if os.environ.get('FAKE_SSH_DOWN'):
    print('ssh: connect to host ' + target + ' port 22: Connection refused', file=sys.stderr)
    sys.exit(255)
remote_home = home / 'remote' / target
remote_home.mkdir(parents=True, exist_ok=True)
sys.exit(subprocess.run(['sh', '-c', command], env=dict(os.environ, HOME=str(remote_home))).returncode)
'''


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        # Exercise plugin paths containing spaces, as installation paths can.
        self.plugin = self.home / 'plugin with spaces'
        shutil.copytree(ROOT / 'scripts', self.plugin / 'scripts')
        shutil.copytree(ROOT / 'sidecar', self.plugin / 'sidecar')
        self.launcher = self.plugin / 'scripts/sidecar'
        bin_dir = self.home / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'herdr').write_text(HERDR)
        (bin_dir / 'herdr').chmod(0o755)
        (bin_dir / 'pi').write_text('#!/bin/sh\nexit 0\n')
        (bin_dir / 'pi').chmod(0o755)
        (bin_dir / 'ssh').write_text(SSH)
        (bin_dir / 'ssh').chmod(0o755)
        self.env = dict(os.environ, HOME=str(self.home), PATH=f'{bin_dir}:/usr/bin:/bin:{NODE_DIR}',
                        HERDR_ENV='1', HERDR_PANE_ID='PANE:1', HERDR_WORKSPACE_ID='workspace-1')
        for key in ('SIDECAR_AGENT', 'SIDECAR_PI_SESSION', 'SIDECAR_MODEL', 'SIDECAR_THINKING', 'CLAUDE_ENV_FILE',
                    'SIDECAR_MACHINE', 'SIDECAR_REMOTE_HOME', 'GROK_STEER_DIR', 'XDG_STATE_HOME'):
            self.env.pop(key, None)

    def run_cli(self, *args, input='', env=None, cwd=None, check=True):
        return subprocess.run([str(self.launcher), *args], input=input, text=True,
                              capture_output=True, env=env or self.env, cwd=cwd, check=check)

    def calls(self):
        path = self.home / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_editing_launcher_during_request_preserves_success_exit(self):
        original = self.launcher.read_bytes()
        process = subprocess.Popen([str(self.launcher), 'ask', 'Task'], text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=dict(self.env, HERDR_PROMPT_DELAY='1'))
        try:
            deadline = time.monotonic() + 5
            while not any(c[:2] == ['agent', 'prompt'] for c in self.calls()):
                self.assertIsNone(process.poll(), 'launcher exited before submitting request')
                self.assertLess(time.monotonic(), deadline, 'request was not submitted')
                time.sleep(0.01)
            # Simulate an in-place update while Bash executes the already-parsed dispatch.
            # The new file is valid Bash, but its old EOF offset now falls inside a comment,
            # on "inst". Re-reading from that offset must not execute a bogus trailing command.
            self.launcher.write_bytes(b'#' + b' ' * (len(original) - 1) + b'inst\n' + original)
            stdout, stderr = process.communicate(timeout=10)
            self.assertIn('ship', stdout, 'the actual work and report should complete')
            self.assertEqual(process.returncode, 0, stderr)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_start_default_and_idempotency(self):
        self.run_cli('start')
        self.run_cli('start')
        starts = [c for c in self.calls() if c[:2] == ['agent', 'start']]
        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0][starts[0].index('--model') + 1], 'openai-codex/gpt-6.1-sol')
        self.assertEqual(starts[0][starts[0].index('--thinking') + 1], 'high')
        self.assertEqual(starts[0][starts[0].index('-e') + 1], str(self.plugin / 'sidecar/sidecar.ts'))

    def test_implementer_defaults_to_medium_and_remembers_role(self):
        self.run_cli('--slot', '2', '--role', 'implementer', 'start')
        self.run_cli('--slot', '2', 'ask', 'Continue implementing')
        starts = [c for c in self.calls() if c[:2] == ['agent', 'start']]
        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0][starts[0].index('--thinking') + 1], 'medium')
        self.assertEqual((self.home / '.cache/claude-sidecar/sc-pane-1-2.role').read_text().strip(),
                         'implementer')
        result = self.run_cli('--slot', '2', '--role', 'reviewer', 'start', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('use a new slot', result.stderr)

    def test_claude_agent_starts_claude_and_resumes_its_session(self):
        self.run_cli('--agent', 'claude', 'start')
        start = next(c for c in self.calls() if c[:2] == ['agent', 'start'])
        self.assertEqual(start[start.index('--kind') + 1], 'claude')
        self.assertEqual(start[start.index('--model') + 1], 'opus')
        self.assertEqual(start[start.index('--effort') + 1], 'high')
        self.assertEqual(start[start.index('-n') + 1], 'claude-sidecar')
        self.assertNotIn('--thinking', start)
        self.assertNotIn('--permission-mode', start)
        self.assertRegex(start[start.index('--session-id') + 1],
                         r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$')
        prompt = Path(start[start.index('--append-system-prompt-file') + 1])
        self.assertIn('Delivery (Claude Code agent)', prompt.read_text())
        # The remembered agent keeps later commands on claude without the flag; a stale pane resumes the session.
        self.run_cli('start')
        self.assertEqual(len([c for c in self.calls() if c[:2] == ['agent', 'start']]), 1)

    def test_claude_implementer_defaults_to_sonnet_medium(self):
        self.run_cli('--slot', '2', '--agent', 'claude', '--role', 'implementer', 'start')
        start = next(c for c in self.calls() if c[:2] == ['agent', 'start'])
        self.assertEqual(start[start.index('--model') + 1], 'sonnet')
        self.assertEqual(start[start.index('--effort') + 1], 'medium')

    def test_claude_request_asks_for_a_written_report(self):
        result = self.run_cli('--agent', 'claude', 'ask', 'Look at x')
        self.assertIn('## Verdict', result.stdout)
        prompt = next(c for c in self.calls() if c[:2] == ['agent', 'prompt'])[3]
        self.assertIn('with the Write tool', prompt)
        self.assertNotIn('submit_review', prompt)

    def test_slot_cannot_switch_agent(self):
        self.run_cli('--agent', 'claude', 'start')
        result = self.run_cli('--agent', 'pi', 'start', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('use a new slot', result.stderr)
        self.assertEqual(self.run_cli('--agent', 'gpt', 'start', check=False).returncode, 1)

    def test_claude_slot_rejects_a_foreign_agent_in_its_pane(self):
        self.run_cli('--agent', 'claude', 'start')
        state = self.home / 'agent.json'
        data = json.loads(state.read_text())
        data['agent'] = 'pi'
        state.write_text(json.dumps(data))
        result = self.run_cli('start', check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('already running', result.stdout)
        self.assertTrue(any(c[:2] == ['agent', 'rename'] for c in self.calls()))

    def test_waiting_request_rechecks_the_slot_agent(self):
        self.run_cli('--agent', 'pi', 'start')
        result = self.run_cli('--agent', 'claude', 'ask', 'x', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('use a new slot', result.stderr)

    def test_claude_slot_has_no_reload(self):
        self.run_cli('--agent', 'claude', 'start')
        result = self.run_cli('reload', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('pi sidecars only', result.stderr)

    def test_claude_sidecar_session_gets_no_sidecars(self):
        entry = self.home / 'claude'
        entry.write_text('"$LAUNCHER" session-start <<<\'{"session_id":"child"}\'\n')
        result = subprocess.run(['bash', '-c', 'exec -a claude bash "$1" -n claude-sidecar', 'x', str(entry)],
                                env=dict(self.env, LAUNCHER=str(self.launcher)), capture_output=True, text=True,
                                check=True)
        self.assertEqual(result.stdout, '')
        self.assertEqual(self.calls(), [])

    def test_thinking_override_applies_to_implementer(self):
        self.run_cli('--role', 'implementer', 'start',
                     env=dict(self.env, SIDECAR_THINKING='low'))
        start = next(c for c in self.calls() if c[:2] == ['agent', 'start'])
        self.assertEqual(start[start.index('--thinking') + 1], 'low')

    def test_invalid_role_is_rejected(self):
        result = self.run_cli('--role', 'writer', 'start', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('--role requires reviewer or implementer', result.stderr)
        self.assertEqual(self.calls(), [])

    def test_legacy_live_reviewer_cannot_become_implementer(self):
        self.run_cli('start')
        (self.home / '.cache/claude-sidecar/sc-pane-1.role').unlink()
        result = self.run_cli('--role', 'implementer', 'start', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('running reviewer', result.stderr)

    def test_concurrent_start_splits_once(self):
        env = dict(self.env, HERDR_GET_DELAY='0.1')
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.run_cli, 'start', env=env) for _ in range(2)]
            for future in futures:
                future.result()
        self.assertEqual(sum(c[:2] == ['tab', 'create'] for c in self.calls()), 0)
        self.assertEqual(sum(c[:2] == ['pane', 'split'] for c in self.calls()), 1)
        self.assertEqual(sum(c[:2] == ['agent', 'start'] for c in self.calls()), 1)

    def test_clear_before_first_request_keeps_identity(self):
        env_file = self.home / 'claude.env'
        env = dict(self.env, HERDR_START_DELAY='0.2', CLAUDE_ENV_FILE=str(env_file))
        self.run_cli('session-start', input='{"session_id":"first"}', env=env)
        self.run_cli('session-start', input='{"session_id":"after-clear"}', env=env)
        self.assertEqual(self.calls(), [])
        self.run_cli('ask', 'First deferred task', env=env)
        self.assertEqual(sum(c[:2] == ['agent', 'start'] for c in self.calls()), 1)
        self.assertFalse(any(c[:2] == ['agent', 'rename'] for c in self.calls()))
        self.assertEqual(env_file.read_text().count('SIDECAR_PI_SESSION=cc-first'), 2)

    def test_direct_command_reuses_hook_session(self):
        state_dir = self.home / '.cache/claude-sidecar'
        state_dir.mkdir(parents=True)
        (state_dir / 'sc-pane-1.session').write_text('cc-claude-session\n')
        self.run_cli('start')
        self.run_cli('ask', 'Follow up')
        self.assertIn('cc-claude-session', self.run_cli('status').stdout)
        self.assertFalse(any(c[:2] == ['agent', 'rename'] for c in self.calls()))

    def test_headless_native_and_interpreter(self):
        for interpreter in (False, True):
            entry = self.home / ('claude-code/cli.js' if interpreter else 'claude')
            entry.parent.mkdir(exist_ok=True)
            entry.write_text('"$LAUNCHER" session-start <<<\'{"session_id":"headless"}\'\n')
            env = dict(self.env, LAUNCHER=str(self.launcher))
            command = 'exec -a "$0" bash "$1" -p test'
            result = subprocess.run(['bash', '-c', command, 'node' if interpreter else 'claude', str(entry)],
                                    env=env, capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout, '')
            self.assertEqual(self.calls(), [])

    def test_eight_sidecars_fill_caller_then_overflow_tabs(self):
        for slot in range(1, 9):
            self.run_cli('--slot', str(slot), 'ask', 'Independent task')
        tabs = [c for c in self.calls() if c[:2] == ['tab', 'create']]
        splits = [c for c in self.calls() if c[:2] == ['pane', 'split']]
        self.assertEqual(len(tabs), 2)
        self.assertEqual(len(splits), 6)
        self.assertEqual([c[c.index('--direction') + 1] for c in splits],
                         ['right', 'down', 'down'] * 2)
        self.assertEqual([c[c.index('--pane') + 1] for c in splits],
                         ['PANE:1', 'PANE:1', 'review-pane-1',
                          'review-pane-4', 'review-pane-4', 'review-pane-5'])
        starts = [c for c in self.calls() if c[:2] == ['agent', 'start']]
        self.assertEqual(len({c[c.index('--session-id') + 1] for c in starts}), 8)
        self.run_cli('--slot', '2', 'ask', 'Follow up')
        self.assertEqual(sum(c[:2] == ['agent', 'start'] for c in self.calls()), 8)
        for call in tabs + splits:
            self.assertIn('--no-focus', call)

    def test_concurrent_slots_share_topology(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(self.run_cli, '--slot', str(i), 'start') for i in range(1, 9)]
            for future in futures:
                future.result()
        self.assertEqual(sum(c[:2] == ['tab', 'create'] for c in self.calls()), 2)
        self.assertEqual(sum(c[:2] == ['pane', 'split'] for c in self.calls()), 6)

    def test_slot_question_is_independent(self):
        self.run_cli('--slot', '2', 'ask', 'Task', env=dict(self.env, FAKE_QUESTION='Proceed?'), check=False)
        self.assertNotEqual(self.run_cli('answer', 'Yes', check=False).returncode, 0)
        self.assertIn('ship', self.run_cli('--slot', '2', 'answer', 'Yes').stdout)

    def panes(self):
        path = self.home / 'panes.json'
        return json.loads(path.read_text()) if path.exists() else None

    def set_panes(self, panes):
        (self.home / 'panes.json').write_text(json.dumps(panes))

    def add_pane(self, pane_id, agent=None, width=162, height=97):
        panes = self.panes()
        panes.append({'pane_id': pane_id, 'tab_id': 't1', 'workspace_id': 'workspace-1',
                      'agent': agent, 'width': width, 'height': height})
        self.set_panes(panes)

    def topology(self):
        return [c[:2] for c in self.calls() if c[:2] in (['pane', 'split'], ['tab', 'create'])]

    def test_closed_pane_frees_room_in_tab(self):
        self.run_cli('start')
        self.run_cli('--slot', '2', 'start')
        self.set_panes([p for p in self.panes() if p['pane_id'] != 'review-pane-1'])
        self.run_cli('--slot', '3', 'start')
        self.assertEqual(self.topology(), [['pane', 'split']] * 3)
        self.assertEqual([p['pane_id'] for p in self.panes()], ['PANE:1', 'review-pane-3', 'review-pane-2'])

    def test_existing_panes_count_toward_limit(self):
        self.set_panes([])
        self.add_pane('PANE:1', agent='claude')
        self.add_pane('existing-right')
        for slot in range(1, 4):
            self.run_cli('--slot', str(slot), 'start')
        topology = [c for c in self.calls() if c[:2] in (['pane', 'split'], ['tab', 'create'])]
        self.assertEqual([c[:2] for c in topology], [['pane', 'split'], ['pane', 'split'], ['tab', 'create']])
        self.assertEqual([c[c.index('--pane') + 1] for c in topology[:2]], ['PANE:1', 'existing-right'])
        self.assertTrue(all(c[c.index('--direction') + 1] == 'down' for c in topology[:2]))

    def test_pane_opened_later_counts_toward_limit(self):
        self.run_cli('start')
        self.add_pane('opened-by-hand')
        self.run_cli('--slot', '2', 'start')
        self.run_cli('--slot', '3', 'start')
        self.assertEqual(self.topology(), [['pane', 'split'], ['pane', 'split'], ['tab', 'create']])
        self.assertEqual(sum(p['tab_id'] == 't1' for p in self.panes()), 4)

    def test_claude_panes_sharing_a_tab_share_its_limit(self):
        self.set_panes([])
        self.add_pane('PANE:1', agent='claude')
        self.add_pane('PANE:2', agent='claude')
        other = dict(self.env, HERDR_PANE_ID='PANE:2')
        self.run_cli('start')
        self.run_cli('start', env=other)
        self.run_cli('--slot', '2', 'start')
        self.run_cli('--slot', '2', 'start', env=other)
        # Each Claude pane overflows into its own tab.
        self.assertEqual(self.topology(), [['pane', 'split'], ['pane', 'split'], ['tab', 'create'], ['tab', 'create']])
        self.assertEqual(sum(p['tab_id'] == 't1' for p in self.panes()), 4)

    def test_cached_pane_taken_by_another_agent_is_left_alone(self):
        self.run_cli('start')
        (self.home / 'agent.json').unlink()  # The name is gone; another pi keeps the pane.
        self.run_cli('start')
        starts = [c[c.index('--pane') + 1] for c in self.calls() if c[:2] == ['agent', 'start']]
        self.assertEqual(starts, ['review-pane-1', 'review-pane-2'])

    def test_busy_cached_pane_gets_replacement(self):
        self.run_cli('start')
        (self.home / 'agent.json').unlink()
        panes = self.panes()
        for pane in panes:
            if pane['pane_id'] == 'review-pane-1':
                pane.update(agent=None, busy=True)  # A non-agent program now runs there.
        self.set_panes(panes)
        self.run_cli('start')
        starts = [c[c.index('--pane') + 1] for c in self.calls() if c[:2] == ['agent', 'start']]
        self.assertEqual(starts, ['review-pane-1', 'review-pane-1', 'review-pane-2'])
        self.run_cli('start')
        self.assertEqual(sum(c[:2] == ['agent', 'start'] for c in self.calls()), 3)

    def test_idle_cached_pane_is_reused(self):
        self.run_cli('start')
        (self.home / 'agent.json').unlink()
        panes = self.panes()
        for pane in panes:
            if pane['pane_id'] == 'review-pane-1':
                pane['agent'] = None  # pi exited back to the shell.
        self.set_panes(panes)
        self.run_cli('start')
        starts = [c[c.index('--pane') + 1] for c in self.calls() if c[:2] == ['agent', 'start']]
        self.assertEqual(starts, ['review-pane-1', 'review-pane-1'])

    def test_slot_started_outside_claude_keeps_claude_session(self):
        env_file = self.home / 'claude.env'
        self.run_cli('session-start', input='{"session_id":"first"}',
                     env=dict(self.env, CLAUDE_ENV_FILE=str(env_file)))
        self.run_cli('--slot', '2', 'start')
        claude = dict(self.env, SIDECAR_AGENT='sc-pane-1', SIDECAR_PI_SESSION='cc-first')
        self.run_cli('--slot', '2', 'ask', 'Task', env=claude)
        starts = [c for c in self.calls() if c[:2] == ['agent', 'start']]
        self.assertEqual([c[c.index('--session-id') + 1] for c in starts], ['cc-first-2'])
        self.assertFalse(any(c[:2] == ['agent', 'rename'] for c in self.calls()))

    def test_invalid_slot(self):
        for slot in ('0', '-1', 'abc', '10000'):
            self.assertNotEqual(self.run_cli('--slot', slot, 'start', check=False).returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_overrides(self):
        env = dict(self.env, SIDECAR_MODEL='test/model', SIDECAR_THINKING='xhigh')
        self.run_cli('start', env=env)
        start = next(c for c in self.calls() if c[:2] == ['agent', 'start'])
        self.assertIn('test/model', start)
        self.assertIn('xhigh', start)

    def test_hook_outside_herdr_is_noop(self):
        result = self.run_cli('session-start', env=dict(self.env, HERDR_ENV='0'), input='{}')
        self.assertEqual(result.stdout, '')
        self.assertEqual(self.calls(), [])

    def test_missing_dependency_hook_is_nonfatal(self):
        (self.home / 'bin/pi').unlink()
        result = self.run_cli('session-start', input='{}')
        self.assertIn('missing dependency pi', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_hook_reuses_live_session(self):
        self.run_cli('start')
        env_file = self.home / 'claude.env'
        result = self.run_cli('session-start', input='{"session_id":"new-session"}',
                              env=dict(self.env, CLAUDE_ENV_FILE=str(env_file)))
        output = json.loads(result.stdout)
        self.assertIn('claude-sidecar:sidecar-review', output['hookSpecificOutput']['additionalContext'])
        self.assertIn('SIDECAR_PI_SESSION=cc-pane-pane-1', env_file.read_text())
        self.assertEqual(sum(c[:2] == ['agent', 'start'] for c in self.calls()), 1)

    def test_requests_use_unique_reports(self):
        for _ in range(2):
            self.assertIn('ship', self.run_cli('ask', 'Review the design').stdout)
        reports = list((self.home / '.cache/claude-sidecar/reports').glob('*.md'))
        self.assertEqual(len(reports), 2)

    def test_question_exit_code_and_answer_resume(self):
        env = dict(self.env, FAKE_QUESTION='May I add X?')
        result = self.run_cli('ask', 'Do the work', env=env, check=False)
        self.assertEqual(result.returncode, 3)
        self.assertTrue(result.stdout.startswith('NEEDS_ANSWER: May I add X?'))
        answered = self.run_cli('answer', 'Yes, with constraint Y')
        self.assertIn('ship', answered.stdout)
        request_files = sorted((self.home / '.cache/claude-sidecar/requests').glob('*-answer-*.md'))
        self.assertIn('Yes, with constraint Y', request_files[0].read_text())
        self.assertFalse(self.run_cli('answer', 'again', check=False).returncode == 0)

    def test_answer_without_pending_question(self):
        result = self.run_cli('answer', 'hello', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no pending question', result.stderr)

    def test_identical_inflight_request_rejected(self):
        env = dict(self.env, HERDR_PROMPT_DELAY='1.5')
        self.run_cli('start')
        with ThreadPoolExecutor(1) as pool:
            first = pool.submit(self.run_cli, 'ask', 'Same body', env=env)
            time.sleep(0.7)
            second = self.run_cli('ask', 'Same body', env=env, check=False)
            self.assertEqual(second.returncode, 4)
            self.assertIn('already in flight', second.stderr)
            self.assertIn('ship', first.result().stdout)

    def test_settled_without_report_fails_fast(self):
        env = dict(self.env, FAKE_NO_REPORT='1', SIDECAR_SETTLE_GRACE_S='0')
        result = self.run_cli('ask', 'Do the work', env=env, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn('no report submitted', result.stderr)

    def test_waits_for_report_after_prompt_returns(self):
        env = dict(self.env, FAKE_LATE_REPORT='1', SIDECAR_SETTLE_GRACE_S='0')
        self.run_cli('start')
        result = self.run_cli('ask', 'Long task', env=env)
        self.assertIn('late ship', result.stdout)

    def test_requests_have_no_deadline(self):
        self.run_cli('ask', 'Review')
        prompts = [c for c in self.calls() if c[:2] == ['agent', 'prompt'] and c[3].startswith('[request ')]
        self.assertNotIn('--timeout', prompts[0])

    def test_blocked_agent_preserved(self):
        self.run_cli('start')
        path = self.home / 'agent.json'
        state = json.loads(path.read_text())
        state['agent_status'] = 'blocked'
        path.write_text(json.dumps(state))
        result = self.run_cli('ask', 'Review', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('blocked', result.stderr)
        self.assertFalse(any(c[:2] == ['agent', 'prompt'] for c in self.calls()))

    def test_stale_session_restarted(self):
        self.run_cli('start')
        path = self.home / 'agent.json'
        state = json.loads(path.read_text())
        state['agent_session']['value'] = '/tmp/wrong-session.jsonl'
        path.write_text(json.dumps(state))
        self.run_cli('start')
        self.assertTrue(any(c[:2] == ['agent', 'rename'] for c in self.calls()))
        self.assertEqual(sum(c[:2] == ['agent', 'start'] for c in self.calls()), 2)

    def test_diff_includes_untracked_files(self):
        repo = self.home / 'repo'
        repo.mkdir()
        def git(*args):
            subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)
        git('init')
        git('config', 'user.name', 'Test')
        git('config', 'user.email', 'test@example.com')
        git('commit', '--allow-empty', '-m', 'Initial')
        (repo / 'new.txt').write_text('untracked content\n')
        (repo / 'café.txt').write_text('unicode content\n')
        (repo / 'line\nbreak.txt').write_text('newline content\n')
        subdir = repo / 'subdir'
        subdir.mkdir()
        self.run_cli('diff', cwd=subdir)
        diffs = list((self.home / '.cache/claude-sidecar/requests').glob('*.diff'))
        diff = diffs[0].read_text()
        for content in ('untracked content', 'unicode content', 'newline content'):
            self.assertIn('+' + content, diff)

    def repo_with_change(self):
        repo = self.home / 'repo'
        repo.mkdir()
        def git(*args):
            subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)
        git('init')
        git('config', 'user.name', 'Test')
        git('config', 'user.email', 'test@example.com')
        (repo / 'a.txt').write_text('one\n')
        git('add', '.')
        git('commit', '-m', 'Initial')
        (repo / 'a.txt').write_text('two\n')
        return repo, git

    def test_diff_request_requires_reproduced_findings(self):
        repo, _ = self.repo_with_change()
        self.run_cli('diff', cwd=repo)
        request = next((self.home / '.cache/claude-sidecar/requests').glob('*-diff-*.md')).read_text()
        self.assertIn('Reproduce each finding before you report it', request)
        self.assertIn('unverified', request)

    def test_unreviewed_tracks_changes_since_the_last_diff_review(self):
        repo, git = self.repo_with_change()
        before = self.run_cli('unreviewed', cwd=repo, check=False)
        self.assertEqual(before.returncode, 1)
        self.assertIn('no diff review recorded', before.stdout)
        self.run_cli('diff', cwd=repo)
        self.assertEqual(self.run_cli('unreviewed', cwd=repo).returncode, 0)
        (repo / 'a.txt').write_text('three\n')
        (repo / 'b.txt').write_text('new\n')
        changed = self.run_cli('unreviewed', cwd=repo, check=False)
        self.assertEqual(changed.returncode, 1)
        self.assertIn('a.txt', changed.stdout)
        self.assertIn('b.txt', changed.stdout)
        (repo / 'a.txt').write_text('two\n')
        (repo / 'b.txt').unlink()
        # Committing reviewed content is not a change.
        git('commit', '-am', 'Reviewed work')
        self.assertEqual(self.run_cli('unreviewed', cwd=repo).returncode, 0)

    def reviewed_repo(self):
        repo, git = self.repo_with_change()
        self.run_cli('diff', cwd=repo)
        self.assertEqual(self.run_cli('unreviewed', cwd=repo).returncode, 0)
        return repo, git

    def assert_unreviewed(self, repo, name):
        result = self.run_cli('unreviewed', cwd=repo, check=False)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(name, result.stdout)

    def test_unreviewed_sees_symlink_retargets_and_mode_changes(self):
        repo, git = self.repo_with_change()
        (repo / 'one').write_text('same\n')
        (repo / 'two').write_text('same\n')
        (repo / 'link').symlink_to('one')
        self.run_cli('diff', cwd=repo)
        (repo / 'link').unlink()
        (repo / 'link').symlink_to('two')
        self.assert_unreviewed(repo, 'link')
        (repo / 'link').unlink()
        (repo / 'link').symlink_to('one')
        self.assertEqual(self.run_cli('unreviewed', cwd=repo).returncode, 0)
        (repo / 'a.txt').chmod(0o755)
        self.assert_unreviewed(repo, 'a.txt')

    def test_unreviewed_sees_a_submodule_move(self):
        repo, git = self.repo_with_change()
        sub = self.home / 'sub'
        sub.mkdir()
        def sgit(*args):
            subprocess.run(['git', '-C', str(sub), *args], check=True, capture_output=True)
        sgit('init')
        sgit('config', 'user.name', 'Test')
        sgit('config', 'user.email', 'test@example.com')
        (sub / 'f').write_text('1\n')
        sgit('add', '.')
        sgit('commit', '-m', 'one')
        subprocess.run(['git', '-c', 'protocol.file.allow=always', '-C', str(repo), 'submodule', 'add', str(sub), 'sub'],
                       check=True, capture_output=True)
        git('commit', '-m', 'Add submodule')
        base = subprocess.run(['git', '-C', str(repo), 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True).stdout.strip()
        (repo / 'sub/f').write_text('2\n')
        subprocess.run(['git', '-C', str(repo / 'sub'), 'config', 'user.name', 'Test'], check=True)
        subprocess.run(['git', '-C', str(repo / 'sub'), 'config', 'user.email', 'test@example.com'], check=True)
        subprocess.run(['git', '-C', str(repo / 'sub'), 'commit', '-am', 'two'], check=True, capture_output=True)
        self.run_cli('diff', base, cwd=repo)
        self.assertEqual(self.run_cli('unreviewed', cwd=repo).returncode, 0)
        (repo / 'sub/f').write_text('3\n')
        subprocess.run(['git', '-C', str(repo / 'sub'), 'commit', '-am', 'three'], check=True, capture_output=True)
        self.assert_unreviewed(repo, 'sub')

    def test_unreviewed_ignores_diff_relative_and_locale(self):
        repo, git = self.repo_with_change()
        git('config', 'diff.relative', 'true')
        (repo / 'sub').mkdir()
        (repo / 'sub/x.txt').write_text('x\n')
        (repo / 'café.txt').write_text('unicode\n')
        self.run_cli('diff', cwd=repo / 'sub')
        delivered = next((self.home / '.cache/claude-sidecar/requests').glob('*.diff')).read_text()
        self.assertIn('a.txt', delivered, 'the delivered diff covers the whole repository')
        c_locale = dict(self.env, LC_ALL='C')
        result = self.run_cli('unreviewed', cwd=repo, env=c_locale)
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_interrupt_releases_the_slot_and_stops_the_prompt(self):
        process = subprocess.Popen([str(self.launcher), 'ask', 'Task'], text=True, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=dict(self.env, HERDR_PROMPT_DELAY='20'),
                                   start_new_session=True)
        try:
            deadline = time.monotonic() + 5
            while not any(c[:2] == ['agent', 'prompt'] for c in self.calls()):
                self.assertLess(time.monotonic(), deadline, 'request was not submitted')
                time.sleep(0.02)
            os.killpg(process.pid, signal.SIGINT)
            process.communicate(timeout=10)
            lock = next((self.home / '.cache/claude-sidecar').glob('*.lock'))
            held = subprocess.run(['flock', '-n', str(lock), 'true'])
            self.assertEqual(held.returncode, 0, 'the slot lock must be free after Ctrl-C')
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()

    def test_interrupt_stops_a_prompt_client_started_by_a_wrapper(self):
        bin_dir = self.home / 'bin'
        (bin_dir / 'herdr-real').write_text((bin_dir / 'herdr').read_text())
        (bin_dir / 'herdr-real').chmod(0o755)
        # A delegating wrapper that does not exec, so the client is a grandchild.
        (bin_dir / 'herdr').write_text('#!/bin/sh\nherdr-real "$@"\n')
        process = subprocess.Popen([str(self.launcher), 'ask', 'Task'], text=True, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=dict(self.env, HERDR_PROMPT_DELAY='20'),
                                   start_new_session=True)
        try:
            deadline = time.monotonic() + 5
            while not any(c[:2] == ['agent', 'prompt'] for c in self.calls()):
                self.assertLess(time.monotonic(), deadline, 'request was not submitted')
                time.sleep(0.02)
            os.killpg(process.pid, signal.SIGINT)
            process.communicate(timeout=10)  # hangs while a grandchild holds the output pipes
            leftovers = subprocess.run(['pgrep', '-f', f'agent prompt.*{self.home}'], capture_output=True, text=True).stdout
            self.assertEqual(leftovers.strip(), '', 'no prompt client may survive Ctrl-C')
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()

    def test_a_failing_filter_never_counts_as_coverage(self):
        repo, git = self.repo_with_change()
        (repo / '.gitattributes').write_text('*.bin filter=broken\n')
        git('add', '.gitattributes')
        git('commit', '-m', 'Attributes')
        git('config', 'filter.broken.clean', 'false')
        git('config', 'filter.broken.required', 'true')
        (repo / 'bad.bin').write_text('x\n')
        failed = self.run_cli('unreviewed', cwd=repo, check=False)
        self.assertNotEqual(failed.returncode, 0)
        self.assertNotIn('no changes', failed.stdout)
        result = self.run_cli('diff', cwd=repo)
        self.assertIn('not recorded as covering', result.stderr)
        self.assertEqual(self.run_cli('unreviewed', cwd=repo, check=False).returncode, 1)

    def test_unreviewed_sees_tracked_changes_outside_a_sparse_cone(self):
        repo, git = self.repo_with_change()
        for name in ('in', 'out'):
            (repo / name).mkdir()
            (repo / name / 'x').write_text('one\n')
        git('add', '.')
        git('commit', '-m', 'Dirs')
        git('sparse-checkout', 'init', '--cone')
        git('sparse-checkout', 'set', 'in')
        self.assertFalse((repo / 'out').exists())
        self.run_cli('diff', cwd=repo)
        self.assertEqual(self.run_cli('unreviewed', cwd=repo).returncode, 0)
        (repo / 'out').mkdir()
        (repo / 'out' / 'x').write_text('unreviewed\n')
        self.assert_unreviewed(repo, 'out/x')

    def test_long_requests_report_progress(self):
        env = dict(self.env, HERDR_PROMPT_DELAY='2.5', SIDECAR_PROGRESS_S='1')
        result = self.run_cli('ask', 'Task', env=env)
        self.assertIn('ship', result.stdout)
        self.assertRegex(result.stderr, r'still working \(0m[12]s\); last output: reading src/foo.ts')
        quiet = self.run_cli('ask', 'Task two', env=dict(env, SIDECAR_PROGRESS_S='0'))
        self.assertNotIn('still working', quiet.stderr)

    # --- Saved herdr machines (herdr 0.9.1+) ---

    def add_machines(self, machines=None):
        machines = machines or [
            {'id': 'm1', 'label': 'laptop', 'target': 'laptop-host', 'session': None, 'enabled': True, 'selected': False},
            {'id': 'm2', 'label': 'desk', 'target': 'user@desk:2222', 'session': None, 'enabled': True, 'selected': False},
            {'id': 'm3', 'label': 'off', 'target': 'off-host', 'session': None, 'enabled': False, 'selected': False}]
        (self.home / 'machines.json').write_text(json.dumps(machines))
        self.work = self.home / 'work dir'
        self.work.mkdir(exist_ok=True)
        self.remote_env = dict(self.env, SIDECAR_MACHINE_TAG='tt01')

    def remote_run(self, *args, env=None, check=True):
        return self.run_cli(*args, env=env or self.remote_env, cwd=self.work, check=check)

    def remote_calls(self, machine='m1'):
        return [c[2:] for c in self.calls() if c[:2] == ['--machine', machine]]

    def local_calls(self):
        # Calls to Claude's own herdr, except the read-only probe for a pre-existing local sidecar of the slot.
        return [c for c in self.calls() if c[0] != '--machine' and c[:2] != ['agent', 'get']]

    def all_starts(self):
        return [c for c in self.calls() if 'agent' in c[:3] and 'start' in c[1:4] and c[-1] != '--wait']

    def remote_home(self, target='laptop-host'):
        return self.home / 'remote' / target

    def remote_panes(self, panes, machine='m1'):
        path = self.home / 'remote-state' / machine
        path.mkdir(parents=True, exist_ok=True)
        (path / 'panes.json').write_text(json.dumps(panes))

    def test_node_transport_deploys_and_maps_checkout(self):
        self.add_machines()
        checkout = self.home / "remote checkout 'quoted'"
        checkout.mkdir()
        config = self.home / 'sidecar-machines.json'
        config.write_text(json.dumps({'laptop': {'transport': 'node', 'paths': {str(self.work): str(checkout)}}}))
        env = dict(self.remote_env, SIDECAR_MACHINES_FILE=str(config))
        result = self.remote_run('--machine', 'laptop', 'ask', 'Task', env=env)
        self.assertIn('ship', result.stdout)
        runtime = self.remote_home() / '.cache/claude-sidecar/plugin/sidecar'
        self.assertTrue((runtime / 'sidecar.ts').is_file())
        self.assertTrue((runtime / 'reviewer.md').is_file())
        started = self.all_starts()[0]
        self.assertIn(str(runtime / 'sidecar.ts'), started)
        tab = next(c for c in self.remote_calls() if c[:2] == ['tab', 'create'])
        self.assertEqual(tab[tab.index('--cwd') + 1], str(checkout))
        ssh_calls = [json.loads(line) for line in (self.home / 'ssh-calls.jsonl').read_text().splitlines()]
        self.assertTrue(all(c['command'].startswith('node -e ') for c in ssh_calls))
        # The slot retains its original directory even after the configured mapping changes.
        config.write_text(json.dumps({'laptop': {'transport': 'node', 'paths': {str(self.work): '/missing'}}}))
        self.assertIn('ship', self.remote_run('ask', 'Follow up', env=env).stdout)
        self.assertEqual(len(self.all_starts()), 1)

    def test_mapping_added_later_does_not_move_existing_slot(self):
        self.add_machines()
        self.remote_run('--machine', 'laptop', 'ask', 'Task')
        checkout = self.home / 'other'
        checkout.mkdir()
        config = self.home / 'sidecar-machines.json'
        config.write_text(json.dumps({'laptop': {'paths': {str(self.work) + '/': str(checkout)}}}))
        env = dict(self.remote_env, SIDECAR_MACHINES_FILE=str(config))
        self.remote_run('ask', 'Follow up', env=env)
        self.assertNotIn(str(checkout), json.dumps(self.remote_calls()))

    def test_concurrent_node_deploys_both_succeed(self):
        self.add_machines()
        config = self.home / 'sidecar-machines.json'
        config.write_text(json.dumps({'laptop': {'transport': 'node'}}))
        env = dict(self.remote_env, SIDECAR_MACHINES_FILE=str(config))
        procs = [subprocess.Popen([str(self.launcher), '--slot', str(n), '--machine', 'laptop', 'start'],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, cwd=self.work)
                 for n in (1, 2)]
        for p in procs:
            _, err = p.communicate(timeout=60)
            self.assertEqual(p.returncode, 0, err)

    def test_delayed_session_identity_does_not_spawn_duplicate(self):
        self.add_machines()
        result = self.remote_run('--machine', 'laptop', 'ask', 'Task',
                                 env=dict(self.remote_env, FAKE_DELAYED_SESSION='1'))
        self.assertIn('ship', result.stdout)
        self.assertEqual(len(self.all_starts()), 1)
        self.assertFalse(any(c[:2] == ['agent', 'rename'] for c in self.remote_calls()))

    def test_node_transport_rejects_missing_checkout(self):
        self.add_machines()
        config = self.home / 'sidecar-machines.json'
        config.write_text(json.dumps({'m1': {'transport': 'node'}}))
        result = self.remote_run('--machine', 'laptop', '--remote-cwd', 'C:/missing', 'ask', 'Task',
                                 env=dict(self.remote_env, SIDECAR_MACHINES_FILE=str(config)), check=False)
        self.assertIn('cannot access checkout C:/missing', result.stderr)
        self.assertEqual(self.all_starts(), [])

    def test_hook_names_saved_machines(self):
        env = dict(self.env, CLAUDE_ENV_FILE=str(self.home / 'claude.env'))
        context = lambda: json.loads(self.run_cli('session-start', input='{"session_id":"s"}', env=env).stdout)[
            'hookSpecificOutput']['additionalContext']
        self.assertNotIn('machine', context())  # herdr 0.8 has no `machine list`
        self.add_machines()
        text = context()
        self.assertIn('--machine', text)
        self.assertIn('laptop (laptop-host), desk (user@desk:2222).', text)
        self.assertNotIn('off', text)
        self.assertEqual(self.calls(), [])

    def test_remote_implementer_defaults_to_medium(self):
        self.add_machines()
        self.remote_run('--slot', '2', '--role', 'implementer', '--machine', 'laptop', 'start')
        self.remote_run('--slot', '2', 'ask', 'Continue implementing')
        starts = [c for c in self.remote_calls() if c[:2] == ['agent', 'start']]
        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0][starts[0].index('--thinking') + 1], 'medium')

    def test_remote_claude_agent_reads_its_prompt_and_writes_its_report_on_the_machine(self):
        self.add_machines()
        env = dict(self.remote_env, SIDECAR_CLAUDE_PERMISSION_MODE='bypassPermissions')
        result = self.remote_run('--agent', 'claude', '--role', 'implementer', '--machine', 'laptop', 'ask', 'Task', env=env)
        self.assertIn('ship', result.stdout)
        self.assertIn('# Sidecar report (laptop:' + str(self.remote_home()), result.stdout)
        self.assertEqual(self.local_calls(), [])
        inner = self.remote_calls()
        start = next(c for c in inner if c[:2] == ['agent', 'start'])
        self.assertEqual(start[start.index('--kind') + 1], 'claude')
        self.assertEqual(start[start.index('--model') + 1], 'sonnet')
        self.assertEqual(start[start.index('--permission-mode') + 1], 'bypassPermissions')
        prompt = Path(start[start.index('--append-system-prompt-file') + 1])
        self.assertTrue(prompt.is_relative_to(self.remote_home()))
        self.assertIn('Delivery (Claude Code agent)', prompt.read_text())
        request = next(c for c in inner if c[:2] == ['agent', 'prompt'])[3]
        self.assertIn('with the Write tool', request)
        self.assertIn(str(self.remote_home() / '.cache/claude-sidecar/reports'), request)

    def test_remote_claude_prompt_copy_failure_starts_nothing(self):
        self.add_machines()
        ssh = self.home / 'bin/ssh'
        original = ssh.read_text()
        ssh.write_text(original.replace("if os.environ.get('FAKE_SSH_DOWN'):",
                                        "if os.environ.get('FAKE_SSH_DOWN') or 'claude-prompt' in command:", 1))
        result = self.remote_run('--agent', 'claude', '--machine', 'laptop', 'start', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('could not copy the Claude prompt to laptop', result.stderr)
        self.assertFalse([c for c in self.remote_calls() if c[:2] == ['agent', 'start']])
        self.assertFalse(list((self.home / '.cache/claude-sidecar').glob('*.claude-started')))

    def test_machine_routes_every_herdr_call_and_files(self):
        self.add_machines()
        result = self.remote_run('--machine', 'laptop', 'ask', 'Task')
        self.assertIn('ship', result.stdout)
        self.assertIn('# Sidecar report (laptop:' + str(self.remote_home()), result.stdout)
        calls = self.calls()
        self.assertTrue(self.remote_calls())
        self.assertEqual(self.local_calls(), [])
        inner = self.remote_calls()
        tab = next(c for c in inner if c[:2] == ['tab', 'create'])
        self.assertEqual(tab[tab.index('--cwd') + 1], str(self.work))
        self.assertEqual(tab[tab.index('--label') + 1], 'Sidecars')
        self.assertNotIn('--workspace', tab)  # no remote pane sits in that directory; herdr picks
        start = next(c for c in inner if c[:2] == ['agent', 'start'])
        self.assertEqual(start[2], 'sc-tt01-pane-1')
        self.assertEqual(start[start.index('--pane') + 1], 'remote-pane-1')
        self.assertEqual(start[start.index('-e') + 1], str(self.plugin / 'sidecar/sidecar.ts'))
        self.assertEqual(start[start.index('--append-system-prompt') + 1], str(self.plugin / 'sidecar/reviewer.md'))
        # The request is read on the machine, under the machine's own home.
        requests = list((self.remote_home() / '.cache/claude-sidecar/requests').glob('*.md'))
        self.assertEqual(len(requests), 1)
        prompt = next(c for c in inner if c[:2] == ['agent', 'prompt'])
        self.assertIn('Read ' + str(requests[0]) + ' ', prompt[3])
        text = requests[0].read_text()
        self.assertIn('Follow-up from Claude', text)
        self.assertIn("land in this machine's checkout", text)
        self.assertIn(str(self.work), text)
        # Panes are never taken from Claude's local tab.
        self.assertFalse(any(c[:2] == ['--machine', 'm1'] and 'PANE:1' in c for c in calls))
        ssh = [json.loads(line) for line in (self.home / 'ssh-calls.jsonl').read_text().splitlines()]
        self.assertTrue(all(c['target'] == 'laptop-host' for c in ssh))
        self.assertIn('BatchMode=yes', ssh[0]['options'])
        self.assertTrue(any(o.startswith('ServerAliveInterval=') for o in ssh[0]['options']))

    def test_machine_tag_defaults_to_a_short_hash(self):
        self.add_machines()
        self.remote_run('--machine', 'laptop', 'start', env=self.env)
        start = next(c for c in self.remote_calls() if c[:2] == ['agent', 'start'])
        self.assertRegex(start[2], r'^sc-[0-9a-f]{4}-pane-1$')

    def test_machine_panes_use_the_workspace_at_the_directory_and_fill_2x2(self):
        self.add_machines()
        self.remote_panes([{'pane_id': 'w1:p1', 'tab_id': 'rt1', 'workspace_id': 'rw-7', 'agent': None,
                            'width': 324, 'height': 97, 'cwd': str(self.work)},
                           {'pane_id': 'w2:p1', 'tab_id': 'rt2', 'workspace_id': 'rw-8', 'agent': None,
                            'width': 324, 'height': 97, 'cwd': '/elsewhere'}])
        for slot in range(1, 6):
            self.remote_run('--slot', str(slot), '--machine', 'laptop', 'start')
        inner = self.remote_calls()
        tabs = [c for c in inner if c[:2] == ['tab', 'create']]
        splits = [c for c in inner if c[:2] == ['pane', 'split']]
        self.assertEqual(len(tabs), 2)
        self.assertEqual(len(splits), 3)
        self.assertEqual([c[c.index('--workspace') + 1] for c in tabs], ['rw-7', 'rw-7'])
        self.assertEqual([c[c.index('--direction') + 1] for c in splits], ['right', 'down', 'down'])
        for call in tabs + splits:
            self.assertIn('--no-focus', call)
        names = [c[2] for c in inner if c[:2] == ['agent', 'start']]
        self.assertEqual(names, ['sc-tt01-pane-1'] + ['sc-tt01-pane-1-%d' % n for n in range(2, 6)])
        # Local herdr never saw a pane or tab.
        self.assertEqual(self.local_calls(), [])

    def test_slot_remembers_its_machine(self):
        self.add_machines()
        self.remote_run('--machine', 'laptop', 'start')
        self.assertEqual((self.home / '.cache/claude-sidecar/sc-pane-1.machine').read_text(), 'm1\n')
        self.assertIn('on laptop', self.remote_run('status').stdout)
        self.remote_run('ask', 'Follow up')
        self.remote_run('--machine', 'm1', 'note', 'By ID')
        self.assertEqual(self.local_calls(), [])
        self.assertEqual(sum(c[:2] == ['agent', 'start'] for c in self.remote_calls()), 1)

    def test_slot_cannot_switch_machines(self):
        self.add_machines()
        self.remote_run('--machine', 'laptop', 'start')
        before = len(self.calls())
        result = self.remote_run('--machine', 'desk', 'start', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("bound to machine 'laptop'", result.stderr)
        self.assertEqual(len(self.calls()), before)
        self.remote_run('--slot', '2', '--machine', 'desk', 'start')  # another slot may use it

    def test_local_slot_cannot_move_to_a_machine_and_back(self):
        self.add_machines()
        self.run_cli('start')
        result = self.remote_run('--machine', 'laptop', 'start', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('already runs locally', result.stderr)
        self.remote_run('--slot', '2', '--machine', 'laptop', 'start')
        result = self.remote_run('--slot', '2', 'start')  # stays on the machine
        self.assertIn('already running', result.stdout)
        self.assertEqual(len(self.all_starts()), 2)

    def test_sidecar_machine_sets_the_default_for_new_slots(self):
        self.add_machines()
        env = dict(self.remote_env, SIDECAR_MACHINE='laptop')
        self.remote_run('--slot', '2', 'start', env=self.env)  # local before the default exists
        self.remote_run('--slot', '2', 'start', env=env)  # a bound slot keeps its machine
        self.remote_run('--slot', '3', 'start', env=env)
        starts = self.all_starts()
        self.assertEqual([c[:2] for c in starts], [['agent', 'start'], ['--machine', 'm1']])
        self.assertEqual(starts[1][2:4], ['agent', 'start'])
        self.assertEqual(starts[1][4], 'sc-tt01-pane-1-3')

    def test_machine_errors(self):
        self.run_cli('start', env=self.env)
        cases = [(('--machine', 'laptop'), 'cannot list herdr machines')]  # herdr without `machine list`
        for args, message in cases:
            result = self.run_cli(*args, '--slot', '2', 'start', check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(message, result.stderr)
        self.add_machines()
        for selector, message in (('nope', 'unknown herdr machine'), ('off', 'disabled')):
            result = self.run_cli('--slot', '2', '--machine', selector, 'start', check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(message, result.stderr)
        self.add_machines([
            {'id': 'a', 'label': 'twin', 'target': 'x', 'enabled': True}, {'id': 'b', 'label': 'twin', 'target': 'y', 'enabled': True}])
        result = self.run_cli('--slot', '2', '--machine', 'twin', 'start', check=False)
        self.assertIn('ambiguous', result.stderr)
        self.assertEqual(self.run_cli('--slot', '2', '--machine', 'b', 'status').returncode, 0)
        self.assertEqual(sum(c[:2] == ['agent', 'start'] for c in self.calls()), 1)

    def test_unreachable_machine_fails_before_starting_anything(self):
        self.add_machines()
        result = self.remote_run('--machine', 'laptop', 'ask', 'Task', env=dict(self.remote_env, FAKE_SSH_DOWN='1'), check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('cannot reach laptop', result.stderr)
        self.assertIn('ssh-agent', result.stderr)
        self.assertEqual(self.local_calls(), [])
        self.assertEqual(self.remote_calls(), [])
        self.assertFalse((self.home / '.cache/claude-sidecar/sc-pane-1.machine').exists())

    def test_remote_plugin_path_and_directory_are_checked_and_overridable(self):
        self.add_machines()
        result = self.remote_run('--machine', 'laptop', 'start', env=dict(self.remote_env, SIDECAR_REMOTE_HOME='/nonexistent'), check=False)
        self.assertIn('plugin is not at /nonexistent on laptop', result.stderr)
        result = self.remote_run('--machine', 'laptop', '--remote-cwd', '/nonexistent/repo', 'start', check=False)
        self.assertIn('/nonexistent/repo does not exist on laptop', result.stderr)
        self.assertEqual(self.local_calls() + self.remote_calls(), [])
        elsewhere = self.home / 'elsewhere'
        shutil.copytree(self.plugin / 'sidecar', elsewhere)
        checkout = self.home / 'laptop-checkout'
        checkout.mkdir()
        self.remote_run('--machine', 'laptop', '--remote-cwd', str(checkout) + '/', 'start',
                        env=dict(self.remote_env, SIDECAR_REMOTE_HOME=str(elsewhere)))
        inner = self.remote_calls()
        start = next(c for c in inner if c[:2] == ['agent', 'start'])
        self.assertEqual(start[start.index('-e') + 1], str(elsewhere / 'sidecar.ts'))
        self.assertEqual(start[start.index('--append-system-prompt') + 1], str(elsewhere / 'reviewer.md'))
        tab = next(c for c in inner if c[:2] == ['tab', 'create'])
        self.assertEqual(tab[tab.index('--cwd') + 1], str(checkout))
        result = self.run_cli('--slot', '2', '--remote-cwd', str(checkout), 'start', check=False)
        self.assertIn('--remote-cwd needs --machine', result.stderr)

    def make_repo(self):
        repo = self.home / 'repo'
        repo.mkdir()
        def git(*args):
            return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()
        git('init')
        git('config', 'user.name', 'Test')
        git('config', 'user.email', 'test@example.com')
        git('commit', '--allow-empty', '-m', 'Initial')
        (repo / 'new.txt').write_text('untracked content\n')
        (repo / 'sub').mkdir()
        return repo, git('rev-parse', 'HEAD')

    def test_remote_diff_copies_the_diff_and_names_the_repo_and_base(self):
        self.add_machines()
        repo, sha = self.make_repo()
        checkout = self.home / 'laptop-checkout'
        (checkout / 'sub').mkdir(parents=True)
        result = self.run_cli('--machine', 'laptop', '--remote-cwd', str(checkout / 'sub'), 'diff', 'HEAD', 'Intent',
                              env=self.remote_env, cwd=repo / 'sub')
        self.assertIn('ship', result.stdout)
        requests = self.remote_home() / '.cache/claude-sidecar/requests'
        diff = next(requests.glob('*.diff'))
        self.assertIn('+untracked content', diff.read_text())
        text = next(requests.glob('*diff*.md')).read_text()
        self.assertIn('`%s`' % diff, text)
        self.assertIn('repository: `%s`, base `HEAD`' % checkout, text)
        self.assertIn(sha, text)
        self.assertIn('git fetch', text)
        self.assertIn('uncommitted or untracked', text)
        self.assertIn('Never run git checkout, reset or stash', text)
        self.assertIn("not in Claude's", text)

    def test_remote_plan_copies_the_plan_file(self):
        self.add_machines()
        plan = self.home / 'plan.md'
        plan.write_text('# My plan\n')
        self.run_cli('--machine', 'laptop', 'plan', str(plan), 'Context', env=self.remote_env, cwd=self.work)
        copies = list((self.remote_home() / '.cache/claude-sidecar/requests').glob('*-planfile-*.md'))
        self.assertEqual(len(copies), 1)
        self.assertEqual(copies[0].read_text(), '# My plan\n')
        text = next(p for p in (self.remote_home() / '.cache/claude-sidecar/requests').glob('*-plan-*.md') if p != copies[0]).read_text()
        self.assertIn('`%s`' % copies[0], text)

    def test_remote_checkout_is_remembered_with_the_slot(self):
        self.add_machines()
        checkout = self.home / 'laptop-checkout'
        checkout.mkdir()
        env = dict(self.remote_env, FAKE_QUESTION='May I?')
        self.remote_run('--machine', 'laptop', '--remote-cwd', str(checkout), 'ask', 'Do it', env=env, check=False)
        self.assertEqual((self.home / '.cache/claude-sidecar/sc-pane-1.machine').read_text(), 'm1\n%s\n' % checkout)
        self.remote_run('answer', 'Yes')
        answer = next((self.remote_home() / '.cache/claude-sidecar/requests').glob('*-answer-*.md')).read_text()
        self.assertIn('Work in `%s` there' % checkout, answer)
        self.remote_run('status')  # the flag may be repeated, but only with the same checkout
        self.remote_run('--remote-cwd', str(checkout), 'status')
        result = self.remote_run('--remote-cwd', str(self.home), 'status', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('works in %s on that machine' % checkout, result.stderr)
        # Tabs for later slot members open in the remembered checkout too.
        tab = next(c for c in self.remote_calls() if c[:2] == ['tab', 'create'])
        self.assertEqual(tab[tab.index('--cwd') + 1], str(checkout))

    def test_concurrent_starts_cannot_bind_a_slot_to_two_machines(self):
        self.add_machines()
        env = dict(self.remote_env, FAKE_SSH_DELAY='0.7')  # both resolve before either binds
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.remote_run, '--machine', machine, 'start', env=env, check=False)
                       for machine in ('laptop', 'desk')]
            results = [future.result() for future in futures]
        self.assertEqual(sorted(r.returncode == 0 for r in results), [False, True])
        failed = next(r for r in results if r.returncode != 0)
        self.assertIn('already bound', failed.stderr)
        self.assertEqual(len(self.all_starts()), 1)
        bound = (self.home / '.cache/claude-sidecar/sc-pane-1.machine').read_text().strip()
        self.assertIn(bound, ('m1', 'm2'))
        self.assertEqual(self.run_cli('status', env=self.remote_env, cwd=self.work).returncode, 0)

    def test_same_second_plans_get_distinct_remote_files(self):
        self.add_machines()
        date = self.home / 'bin/date'
        date.write_text('#!/bin/sh\ncase "$1" in +%Y%m%d-%H%M%S) echo 20260101-000000;; *) exec /usr/bin/date "$@";; esac\n')
        date.chmod(0o755)
        for index in (1, 2):
            folder = self.home / ('plans%d' % index)
            folder.mkdir()
            (folder / 'plan.md').write_text('plan number %d\n' % index)
            self.run_cli('--machine', 'laptop', 'plan', str(folder / 'plan.md'), env=self.remote_env, cwd=self.work)
        requests = self.remote_home() / '.cache/claude-sidecar/requests'
        copies = sorted(p.read_text() for p in requests.glob('*-planfile-*.md'))
        self.assertEqual(copies, ['plan number 1\n', 'plan number 2\n'])
        mentioned = [p.read_text() for p in requests.glob('*-plan-*.md')]
        for copy in requests.glob('*-planfile-*.md'):
            self.assertEqual(sum('`%s`' % copy in text for text in mentioned), 1)

    def test_remote_diff_sends_head_as_well_as_the_base(self):
        self.add_machines()
        repo, base = self.make_repo()
        subprocess.run(['git', '-C', str(repo), 'add', 'new.txt'], check=True)
        subprocess.run(['git', '-C', str(repo), 'commit', '-m', 'Second'], check=True, capture_output=True)
        head = subprocess.run(['git', '-C', str(repo), 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True).stdout.strip()
        self.assertNotEqual(base, head)
        (self.home / 'repo/new.txt').write_text('changed\n')
        self.run_cli('--machine', 'laptop', '--remote-cwd', str(self.work), 'diff', base, env=self.remote_env, cwd=repo)
        text = next((self.remote_home() / '.cache/claude-sidecar/requests').glob('*-diff-*.md')).read_text()
        self.assertIn('checkout is at commit `%s`' % head, text)
        self.assertIn('review base is commit `%s`' % base, text)
        self.assertIn('git fetch', text)
        self.assertIn('git show %s:PATH' % head, text)
        self.assertIn('Never run git checkout, reset or stash', text)
        # A plan request gets HEAD too.
        plan = self.home / 'plan.md'
        plan.write_text('# Plan\n')
        self.run_cli('--slot', '2', '--machine', 'laptop', '--remote-cwd', str(self.work), 'plan', str(plan), env=self.remote_env, cwd=repo)
        plans = [p.read_text() for p in (self.remote_home() / '.cache/claude-sidecar/requests').glob('*-plan-*.md')]
        self.assertTrue(any('checkout is at commit `%s`' % head in t for t in plans))

    def test_remote_question_and_answer_route_to_the_machine(self):
        self.add_machines()
        env = dict(self.remote_env, FAKE_QUESTION='May I?')
        result = self.remote_run('--machine', 'laptop', 'ask', 'Do it', env=env, check=False)
        self.assertEqual(result.returncode, 3)
        self.assertTrue(result.stdout.startswith('NEEDS_ANSWER: May I?'))
        answered = self.remote_run('answer', 'Yes')
        self.assertIn('ship', answered.stdout)
        answers = list((self.remote_home() / '.cache/claude-sidecar/requests').glob('*-answer-*.md'))
        self.assertIn('Yes', answers[0].read_text())

    def test_remote_report_is_polled_after_prompt_returns(self):
        self.add_machines()
        env = dict(self.remote_env, FAKE_LATE_REPORT='1', SIDECAR_SETTLE_GRACE_S='0')
        self.remote_run('--machine', 'laptop', 'start')
        self.assertIn('late ship', self.remote_run('ask', 'Long task', env=env).stdout)

    def test_remote_no_report_points_at_ssh(self):
        self.add_machines()
        env = dict(self.remote_env, FAKE_NO_REPORT='1', SIDECAR_SETTLE_GRACE_S='0')
        result = self.remote_run('--machine', 'laptop', 'ask', 'Task', env=env, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn('no report submitted', result.stderr)
        self.assertIn('ssh laptop-host true', result.stderr)

    def test_reload_extension_lifecycle(self):
        subprocess.run(['node', '--test', str(ROOT / 'tests/test_reload.mjs')], check=True, capture_output=True)

    def test_reload_waits_for_the_request_and_preserves_its_report(self):
        self.run_cli('start')
        busy = subprocess.Popen([str(self.launcher), 'ask', 'Long task'], text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=dict(self.env, HERDR_PROMPT_DELAY='1.5'))
        self.addCleanup(busy.wait)
        deadline = time.monotonic() + 5
        while not any(c[:2] == ['agent', 'prompt'] for c in self.calls()):
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.01)
        result = self.run_cli('reload')
        stdout, stderr = busy.communicate(timeout=5)
        self.assertEqual(busy.returncode, 0, stderr)
        self.assertIn('ship', stdout)
        self.assertIn('reloaded between requests', result.stdout)
        prompts = [c[3] for c in self.calls() if c[:2] == ['agent', 'prompt']]
        self.assertTrue(prompts[0].startswith('[request '))
        self.assertEqual(prompts[-1], '/reload')
        self.assertEqual(sum(c[:2] == ['agent', 'start'] for c in self.calls()), 1)

    def test_reload_preserves_pending_question_and_uses_the_idle_command(self):
        self.run_cli('start')
        state = self.home / '.cache/claude-sidecar'
        (state / 'sc-pane-1.pending').write_text('existing-request')
        directory = state / 'reload'
        directory.mkdir()
        (directory / 'cc-pane-pane-1.ready').write_text(json.dumps({'pid': os.getpid(), 'sessionFile': '/tmp/time_cc-pane-pane-1.jsonl'}))
        self.run_cli('reload')
        self.assertEqual((state / 'sc-pane-1.pending').read_text(), 'existing-request')
        prompts = [c[3] for c in self.calls() if c[:2] == ['agent', 'prompt']]
        self.assertTrue(prompts[-1].startswith('/sidecar-reload reload-'))
        self.assertFalse(list(directory.glob('*.pending')))

    def test_remote_reload_preserves_the_session(self):
        self.add_machines()
        self.remote_run('--machine', 'laptop', 'start')
        result = self.remote_run('reload')
        self.assertIn('reloaded between requests', result.stdout)
        self.assertEqual(sum(c[:2] == ['agent', 'start'] for c in self.remote_calls()), 1)

    def test_reload_timeout_is_not_reported_as_success(self):
        self.run_cli('start')
        result = self.run_cli('reload', env=dict(self.env, FAKE_NO_RELOAD='1', SIDECAR_RELOAD_TIMEOUT_S='1'), check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('reload was not confirmed', result.stderr)
        self.assertFalse(list((self.home / '.cache/claude-sidecar/reload').glob('*.pending')))

    def test_reload_refuses_a_foreign_session(self):
        self.run_cli('start')
        path = self.home / 'agent.json'
        state = json.loads(path.read_text())
        state['agent_session']['value'] = '/tmp/time_foreign.jsonl'
        path.write_text(json.dumps(state))
        result = self.run_cli('reload', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('does not run this sidecar session', result.stderr)
        self.assertFalse(any(c[:2] == ['agent', 'rename'] for c in self.calls()))

    def test_idle_steer_prints_a_request_report_without_an_inbox(self):
        self.run_cli('start')
        text = 'quote "double" and é\nsecond line'
        result = self.run_cli('steer', text)
        self.assertIn('Sidecar report', result.stdout)
        self.assertIn('ship', result.stdout)
        request = next((self.home / '.cache/claude-sidecar/requests').glob('*.md'))
        self.assertIn(text, request.read_text())
        self.assertFalse((self.home / '.local/state/grok-style-pi/steer').exists())

    def test_idle_steer_preserves_request_question_exit(self):
        self.run_cli('start')
        result = self.run_cli('steer', 'Need a decision', env=dict(self.env, FAKE_QUESTION='Which?'), check=False)
        self.assertEqual(result.returncode, 3)
        self.assertIn('NEEDS_ANSWER: Which?', result.stdout)

    def test_idle_remote_steer_returns_the_remote_report(self):
        self.add_machines()
        self.remote_run('--machine', 'laptop', 'start')
        result = self.remote_run('steer', 'Review remotely')
        self.assertIn('ship', result.stdout)
        self.assertEqual(len(list((self.remote_home() / '.cache/claude-sidecar/requests').glob('*.md'))), 1)
        self.assertFalse((self.remote_home() / '.local/state/grok-style-pi/steer').exists())

    def write_owner(self, home, session='cc-pane-pane-1', pid=None, session_file=None):
        inbox = home / '.local/state/grok-style-pi/steer' / session
        inbox.mkdir(parents=True, exist_ok=True)
        (inbox / '.owner').write_text(json.dumps({
            'pid': os.getpid() if pid is None else pid, 'token': 't', 'startedAt': 'x',
            'sessionFile': session_file or '/tmp/time_' + session + '.jsonl'}))

    def steer_inbox(self, home, reply=None, session='cc-pane-pane-1', owner=True, session_file=None):
        """Plays the pi extension: owns the inbox and acknowledges every message dropped in it. Returns the messages seen."""
        root = home / '.local/state/grok-style-pi/steer'
        seen, stop = [], threading.Event()
        if owner:
            (root / session).mkdir(parents=True, exist_ok=True)
            (root / session / '.owner').write_text(json.dumps({
                'pid': os.getpid(), 'token': 't', 'startedAt': 'x',
                'sessionFile': session_file or '/tmp/time_' + session + '.jsonl'}))

        def watch():
            while not stop.is_set():
                for path in sorted(root.glob('*/*.json')) if root.exists() else []:
                    seen.append(json.loads(path.read_text()))
                    path.unlink()
                    path.with_suffix('.ack').write_text(json.dumps(reply or {'status': 'delivered', 'delivery': 'steer'}))
                time.sleep(0.02)
        thread = threading.Thread(target=watch)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(stop.set)
        return seen

    def test_steer_reaches_a_busy_slot_without_waiting_for_its_request(self):
        self.run_cli('--slot', '3', 'start')
        seen = self.steer_inbox(self.home, session='cc-pane-pane-1-3')
        busy = subprocess.Popen([str(self.launcher), '--slot', '3', 'ask', 'Long task'], text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=dict(self.env, HERDR_PROMPT_DELAY='3'))
        self.addCleanup(busy.wait)
        time.sleep(0.5)
        started = time.monotonic()
        result = self.run_cli('--slot', '3', 'steer', 'Only fix the failing test.')
        self.assertLess(time.monotonic() - started, 2.5)
        self.assertIsNone(busy.poll())
        self.assertIn('steered: delivered into', result.stdout)
        self.assertEqual([m['text'] for m in seen], ['Only fix the failing test.'])
        self.assertEqual(seen[0]['from'], 'Claude Code')
        session = 'cc-pane-pane-1-3'
        self.assertEqual([p.name for p in (self.home / '.local/state/grok-style-pi/steer' / session).iterdir()], ['.owner'])
        busy.communicate()

    def test_steer_keeps_text_verbatim_and_reports_an_idle_prompt(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.run_cli('start')
        seen = self.steer_inbox(self.home, {'status': 'delivered', 'delivery': 'prompt'})
        text = 'quote \' and "double" $HOME `x` \\ \u00e9 \n second line'
        result = self.run_cli('steer', text)
        self.assertIn('delivered to idle', result.stdout)
        self.assertEqual(seen[0]['text'], text)

    def test_steer_withdraws_an_unacknowledged_message_and_fails(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.run_cli('start')
        self.write_owner(self.home)
        result = self.run_cli('steer', 'Hello', env=dict(self.env, SIDECAR_STEER_TIMEOUT_S='1'), check=False)
        self.assertEqual(result.returncode, 4)
        self.assertIn('withdrawn', result.stderr)
        self.assertEqual(list((self.home / '.local/state/grok-style-pi/steer').glob('*/*.json')) + list((self.home / '.local/state/grok-style-pi/steer').glob('*/*.taken')), [])

    def test_steer_that_was_claimed_but_not_acknowledged_is_not_called_withdrawn(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.run_cli('start')
        self.write_owner(self.home)
        root = self.home / '.local/state/grok-style-pi/steer'
        stop = threading.Event()

        def claim():  # the receiver renames the message, then stalls
            while not stop.is_set():
                for path in list(root.glob('*/*.json')) if root.exists() else []:
                    path.rename(path.with_suffix('.taken'))
                time.sleep(0.02)
        thread = threading.Thread(target=claim)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(stop.set)
        result = self.run_cli('steer', 'Hello', env=dict(self.env, SIDECAR_STEER_TIMEOUT_S='1', SIDECAR_STEER_CLAIM_GRACE_S='1'), check=False)
        self.assertEqual(result.returncode, 6)
        self.assertIn('outcome unknown', result.stderr)
        self.assertNotIn('withdrawn', result.stderr)

    def test_steer_claimed_late_but_acknowledged_within_the_grace_succeeds(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.run_cli('start')
        self.write_owner(self.home)
        root = self.home / '.local/state/grok-style-pi/steer'

        def slow_receiver():
            for _ in range(500):
                for path in list(root.glob('*/*.json')) if root.exists() else []:
                    taken = path.with_suffix('.taken')
                    path.rename(taken)
                    time.sleep(1.5)  # past the sender's 1s timeout
                    taken.unlink()
                    path.with_suffix('.ack').write_text(json.dumps({'status': 'delivered', 'delivery': 'prompt'}))
                    return
                time.sleep(0.02)
        thread = threading.Thread(target=slow_receiver)
        thread.start()
        self.addCleanup(thread.join)
        result = self.run_cli('steer', 'Hello', env=dict(self.env, SIDECAR_STEER_TIMEOUT_S='1', SIDECAR_STEER_CLAIM_GRACE_S='3'))
        self.assertIn('delivered to idle', result.stdout)

    def test_steer_delivers_json_looking_text_verbatim(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        # The text is data: a JSON-looking message is delivered verbatim, never parsed by the launcher.
        self.run_cli('start')
        seen = self.steer_inbox(self.home)
        self.run_cli('steer', 'null')
        self.assertEqual(seen[0]['text'], 'null')

    def test_remote_steer_command_has_a_fixed_size_for_any_text(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.add_machines()
        self.remote_run('--machine', 'laptop', 'start')
        seen = self.steer_inbox(self.remote_home())
        text = 'x\u00e9 ' * 20000
        self.remote_run('steer', text)
        self.assertEqual(seen[0]['text'], text)
        ssh = [json.loads(line) for line in (self.home / 'ssh-calls.jsonl').read_text().splitlines()]
        self.assertLess(max(len(c['command']) for c in ssh), 6000)

    def test_steer_reports_an_unconfirmed_message_as_unknown(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.run_cli('start')
        self.steer_inbox(self.home, {'status': 'unconfirmed', 'reason': 'Pi did not report the message'})
        result = self.run_cli('steer', 'Hello', check=False)
        self.assertEqual(result.returncode, 6)
        self.assertIn('outcome unknown', result.stderr)

    def test_steer_queued_behind_a_running_turn_exits_zero_and_says_it_is_unconfirmed(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.run_cli('start')
        self.steer_inbox(self.home, {'status': 'queued'})
        result = self.run_cli('steer', 'Hello')
        self.assertIn('queued (not yet confirmed in conversation)', result.stdout)

    def test_steer_names_the_verified_owner_instance_in_the_message(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.run_cli('start')
        seen = self.steer_inbox(self.home)
        self.run_cli('steer', 'Hello')
        self.assertEqual(seen[0]['owner'], 't')

    def test_steer_reports_an_owner_change_after_verification(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.run_cli('start')
        self.steer_inbox(self.home, {'status': 'rejected', 'reason': 'owner changed: the message was addressed to another receiver instance'})
        result = self.run_cli('steer', 'Hello', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('owner changed', result.stderr)

    def test_steer_refuses_an_inbox_without_a_receiver(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.run_cli('start')
        result = self.run_cli('steer', 'Hello', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('no steering receiver owns this session inbox', result.stderr)
        self.assertEqual(list((self.home / '.local/state/grok-style-pi/steer').glob('*/*.json')), [])

    def test_steer_refuses_an_inbox_owned_by_another_pi(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.run_cli('start')
        seen = self.steer_inbox(self.home, session_file='/tmp/time_cc-pane-pane-1-other.jsonl')
        result = self.run_cli('steer', 'Hello', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('not by this sidecar', result.stderr)
        self.assertEqual(seen, [])

    def test_steer_refuses_a_dead_receiver(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.run_cli('start')
        self.write_owner(self.home, pid=999999)
        result = self.run_cli('steer', 'Hello', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('is gone', result.stderr)

    def test_steer_says_so_when_the_targets_session_file_is_unknown(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.run_cli('start')
        self.write_owner(self.home)
        state = next(self.home.glob('agent.json'))
        data = json.loads(state.read_text())
        data['agent_session'] = {'value': ''}
        state.write_text(json.dumps(data))
        result = self.run_cli('steer', 'Hello', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('cannot tell which session file herdr runs', result.stderr)

    def test_steer_accepts_windows_style_session_paths_from_herdr(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.run_cli('start')
        self.steer_inbox(self.home, session_file='C:\\Users\\AIM\\s\\x.jsonl')
        state = next(self.home.glob('agent.json'))
        data = json.loads(state.read_text())
        data['agent_session'] = {'value': 'c:/users/aim/s/x.jsonl'}
        state.write_text(json.dumps(data))
        self.assertIn('steered', self.run_cli('steer', 'Hello').stdout)

    def test_steer_reports_a_refusal(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.run_cli('start')
        self.steer_inbox(self.home, {'status': 'rejected', 'reason': 'expired before this session read it'})
        result = self.run_cli('steer', 'Hello', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('expired before this session read it', result.stderr)

    def test_steer_needs_a_running_sidecar(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        result = self.run_cli('--slot', '4', 'steer', 'Hello', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('no running sidecar in slot 4', result.stderr)
        self.assertFalse((self.home / '.local/state/grok-style-pi/steer').exists())

    def test_remote_steer_routes_over_ssh_to_the_machines_inbox(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.add_machines()
        self.remote_run('--machine', 'laptop', 'start')
        seen = self.steer_inbox(self.remote_home())
        result = self.remote_run('steer', 'Switch to the Windows build.')
        self.assertIn('steered: delivered into', result.stdout)
        self.assertEqual([m['text'] for m in seen], ['Switch to the Windows build.'])
        self.assertFalse((self.home / '.local/state/grok-style-pi/steer').exists())
        ssh = [json.loads(line) for line in (self.home / 'ssh-calls.jsonl').read_text().splitlines()]
        self.assertIn('BatchMode=yes', ssh[-1]['options'])

    def test_remote_steer_reports_an_unreachable_machine(self):
        self.env['FAKE_AGENT_WORKING'] = '1'
        self.add_machines()
        self.remote_run('--machine', 'laptop', 'start')
        result = self.remote_run('steer', 'Hello', env=dict(self.remote_env, FAKE_SSH_DOWN='1'), check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('cannot reach laptop', result.stderr)


if __name__ == '__main__':
    unittest.main()
