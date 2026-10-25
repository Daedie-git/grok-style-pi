"""Launcher integration tests with isolated HOME and a fake Herdr executable."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
import re
import signal
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
NODE_DIR = str(Path(shutil.which('node') or '/usr/bin/node').parent)

HERDR = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, time, uuid
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
    return {k: p.get(k, False) if k == 'focused' else p.get(k)
            for k in ('pane_id', 'tab_id', 'workspace_id', 'agent', 'cwd', 'focused')}
def find(pane_id):
    return next(p for p in panes if p['pane_id'] == pane_id or pane_id in p.get('aliases', []))
if args[:2] == ['pane', 'layout']:
    tab = find(args[args.index('--pane') + 1])['tab_id']
    print(json.dumps({'result': {'layout': {'tab_id': tab, 'panes': [
        {'pane_id': p['pane_id'], 'rect': {'width': p['width'], 'height': p['height']}}
        for p in panes if p['tab_id'] == tab]}}}))
elif args[:2] == ['pane', 'list']:
    print(json.dumps({'result': {'panes': [pane_info(p) for p in panes]}}))
elif args[:2] == ['pane', 'get']:
    errors_path = state_dir / 'pane-errors.json'
    errors = json.loads(errors_path.read_text()) if errors_path.exists() else {}
    if args[2] in errors:
        error = errors[args[2]]
        time.sleep(error.get('delay', 0))
        print(error.get('stdout', ''), end='')
        print(error.get('stderr', ''), file=sys.stderr, end='')
        sys.exit(error.get('returncode', 1))
    try:
        pane = find(args[2])
    except StopIteration:
        print(json.dumps({'error': {'code': 'pane_not_found', 'message': 'pane not found'}}))
        sys.exit(1)
    print(json.dumps({'result': {'pane': pane_info(pane)}}))
elif args[:2] == ['pane', 'process-info']:
    pane = args[args.index('--pane') + 1]
    states = [json.loads(p.read_text()) for p in state_dir.glob('*.agent.json')]
    states += [json.loads((state_dir / 'agent.json').read_text())] if (state_dir / 'agent.json').exists() else []
    current = next(s for s in states if s.get('pane_id') == pane)
    # Simulate user activity arriving during the destructive-action ownership check.
    if os.environ.get('FAKE_WORKING_ON_PROCESS_INFO'):
        for agent_file in list(state_dir.glob('*.agent.json')) + [state_dir / 'agent.json']:
            if agent_file.exists():
                record = json.loads(agent_file.read_text())
                if record.get('pane_id') == pane:
                    record['agent_status'] = 'working'
                    agent_file.write_text(json.dumps(record))
    if os.environ.get('FAKE_FOCUS_ON_PROCESS_INFO'):
        find(pane)['focused'] = True
        panes_path.write_text(json.dumps(panes))
    if '_argv' in current:
        argv = current['_argv']
    else:
        argv = ['node', 'pi', '--session-id', current['agent_session']['value'].split('time_', 1)[1][:-6]]
    print(json.dumps({'result': {'process_info': {'foreground_processes': [
        {'pid': current.get('native_pid', 1), 'argv': argv}]}}}))
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
elif args[:2] == ['pane', 'close']:
    closed = args[2]
    panes = [p for p in panes if p['pane_id'] != closed]
    panes_path.write_text(json.dumps(panes))
    for agent_file in list(state_dir.glob('*.agent.json')) + [state_dir / 'agent.json']:
        if agent_file.exists() and json.loads(agent_file.read_text()).get('pane_id') == closed:
            agent_file.unlink()
    print(json.dumps({'result': {}}))
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
    if kind == 'codex':
        session = args[args.index('resume') + 1] if 'resume' in args else str(uuid.uuid4())
        session_value = ''
    else:
        session = args[args.index('--session-id' if '--session-id' in args else '--resume') + 1]
        session_value = '/tmp/time_' + session + '.jsonl'
    record = {'agent': kind, 'agent_status': 'idle', 'pane_id': target['pane_id'],
              'agent_session': {'value': session_value}}
    if kind == 'codex':
        record['_codex_session'] = session
    if kind == 'claude':
        flag = '--session-id' if '--session-id' in args else '--resume'
        record['_argv'] = ['claude', flag, session]
    if kind == 'pi' and os.environ.get('FAKE_WINDOWS_CONTROL'):
        import subprocess
        runtime = pathlib.Path(args[args.index('-e') + 1]).with_name('windows-runtime.mjs')
        if not runtime.is_absolute():
            runtime = data_home / runtime
        source = r"""
        const fs=require('node:fs'),path=require('node:path');
        (async()=>{
          const {installWindowsControl}=await import(require('node:url').pathToFileURL(process.argv[1]));
          const handlers=new Map(),state=path.join(process.env.HOME,'.cache/claude-sidecar');
          const session=process.argv[2],noReport=process.env.FAKE_NO_REPORT;
          const pi={on:(e,h)=>handlers.set(e,h),sendMessage:message=>{
            setTimeout(()=>{
              handlers.get('message_end')({message:{role:'custom',...message}});
              setTimeout(()=>{
                const id=message.content.match(/\[request ([^\]]+)\]/)?.[1];
                if(id&&!noReport){
                  fs.mkdirSync(path.join(state,'reports'),{recursive:true});
                  if(process.env.FAKE_QUESTION)fs.writeFileSync(path.join(state,'reports',id+'.needs-answer'),process.env.FAKE_QUESTION);
                  fs.writeFileSync(path.join(state,'reports',id+'.md'),'## Verdict\nWindows ship\n');
                }
                handlers.get('agent_settled')({});
              },Number(process.env.HERDR_PROMPT_DELAY||'0')*1000);
            },0);
          }};
          installWindowsControl(pi,state);
          await new Promise(resolve=>setTimeout(resolve,Number(process.env.FAKE_WINDOWS_START_DELAY||'0')*1000));
          handlers.get('session_start')({}, {sessionManager:{getSessionId:()=>session,getSessionFile:()=>'/tmp/time_'+session+'.jsonl'},
            isIdle:()=>true,hasPendingMessages:()=>false,ui:{notify:()=>{}}});
          setInterval(()=>{},1000);
        })().catch(e=>{console.error(e);process.exit(1)});
        """
        child = subprocess.Popen(['node', '-e', source, str(runtime), session],
                                 env=dict(os.environ, HOME=str(data_home)), cwd=data_home,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        record['native_pid'] = child.pid
        for _ in range(0 if os.environ.get('FAKE_WINDOWS_START_DELAY') else 100):
            if (data_home / '.cache/claude-sidecar/windows' / session / 'owner.json').exists():
                break
            time.sleep(.05)
    with state_path.open('x') as output:
        json.dump(record, output)
elif args[:2] == ['agent', 'wait']:
    while state_path.exists() and json.loads(state_path.read_text())['agent_status'] == 'working':
        time.sleep(0.05)
elif args[:2] == ['agent', 'read']:
    print('earlier line\nreading src/foo.ts')
elif args[:2] == ['agent', 'rename']:
    state_path.unlink()
elif args[:2] == ['agent', 'prompt']:
    prompt = args[3]
    # Codex's SessionStart hook publishes its UUID on the first turn, after TUI readiness.
    if '_codex_session' in state:
        state['agent_session']['value'] = state.pop('_codex_session')
        state_path.write_text(json.dumps(state))
    if state['agent'] == 'codex' and prompt.startswith('[note] Initialize') and os.environ.get('FAKE_CODEX_BOOTSTRAP_DELAY'):
        state['agent_status'] = 'working'
        state_path.write_text(json.dumps(state))
        import subprocess
        subprocess.Popen([sys.executable, '-c', (
            'import json,pathlib,time,sys;time.sleep(float(sys.argv[2]));'
            'p=pathlib.Path(sys.argv[1]);s=json.loads(p.read_text());'
            's["agent_status"]="idle";q=p.with_suffix(".bootstrap");'
            'q.write_text(json.dumps(s));q.replace(p)'),
            str(state_path), os.environ['FAKE_CODEX_BOOTSTRAP_DELAY']],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
        # FAKE_TOUCH: colon-separated paths the "sidecar" writes during its turn.
        for touched in filter(None, os.environ.get('FAKE_TOUCH', '').split(':')):
            pathlib.Path(touched).write_text('changed by the sidecar\n')
        started = time.time()
        time.sleep(float(os.environ.get('HERDR_PROMPT_DELAY_' + name.replace('-', '_'), os.environ.get('HERDR_PROMPT_DELAY', '0'))))
        import re
        kind = re.match(r'\d{8}-\d{6}-([a-z]+)-', request_id).group(1)
        with (home / 'prompts.jsonl').open('a') as log:
            log.write(json.dumps({'kind': kind, 'name': name, 'start': started, 'end': time.time()}) + '\n')
        # FAKE_REPORTS maps "kind:agent" to canned report text, or {"report": ..., "question": ...}.
        canned = json.loads(pathlib.Path(os.environ['FAKE_REPORTS']).read_text()).get(kind + ':' + name) if os.environ.get('FAKE_REPORTS') else None
        if canned is not None:
            if isinstance(canned, str):
                canned = {'report': canned}
            (reports / (request_id + '.md')).write_text(canned['report'])
            if canned.get('question'):
                (reports / (request_id + '.needs-answer')).write_text(canned['question'] + '\n')
            sys.exit(0)
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
        (reports / (request_id + '.md')).write_text('## Verdict\nship\n' + 'report detail\n' * int(os.environ.get('FAKE_REPORT_LINES', '0')))
        if os.environ.get('FAKE_QUESTION'):
            (reports / (request_id + '.needs-answer')).write_text(os.environ['FAKE_QUESTION'] + '\n')
'''


# Runs the command on a "machine" whose home differs from ours, as a real SSH login would.
SSH = r'''#!/usr/bin/env python3
import base64, json, os, pathlib, subprocess, sys, time
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
if os.environ.get('FAKE_REMOTE_WINDOWS') and command.startswith('node -e '):
    encoded = command.split("Buffer.from('", 1)[1].split("'", 1)[0]
    script = base64.b64decode(encoded).decode().replace('os.platform()', '"win32"')
    command = command.replace(encoded, base64.b64encode(script.encode()).decode())
sys.exit(subprocess.run(['sh', '-c', command], env=dict(os.environ, HOME=str(remote_home)), cwd=remote_home).returncode)
'''


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        state = self.home / '.cache/claude-sidecar'
        state.mkdir(parents=True)
        # Most tests exercise commands, not the detached lifecycle worker.
        (state / 'sweep.timestamp').write_text(str(int(time.time())))
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
                        HERDR_ENV='1', HERDR_PANE_ID='PANE:1', HERDR_WORKSPACE_ID='workspace-1',
                        SIDECAR_CLOSE_WHEN_DONE='0')
        for key in ('SIDECAR_AGENT', 'SIDECAR_PI_SESSION', 'SIDECAR_MODEL', 'SIDECAR_CODEX_MODEL',
                    'SIDECAR_THINKING', 'CLAUDE_ENV_FILE',
                    'SIDECAR_MACHINE', 'SIDECAR_REMOTE_HOME', 'GROK_STEER_DIR', 'XDG_STATE_HOME',
                    'SIDECAR_TEST_ANCESTRY_PID'):
            self.env.pop(key, None)

    def run_cli(self, *args, input='', env=None, cwd=None, check=True):
        if args in (('session-start',), ('session-end',)):
            return self.run_hook(args[0], input=input, env=env, cwd=cwd, check=check)
        return subprocess.run([str(self.launcher), *args], input=input, text=True,
                              capture_output=True, env=env or self.env, cwd=cwd, check=check)

    def run_hook(self, command, *, argv0='claude', flags=(), entry=None,
                 input='', env=None, cwd=None, check=True):
        # Keep a real Claude-shaped ancestor alive until the hook returns. Node's
        # npm entry point is argv[1], just as it is in an actual Claude process.
        entry = self.home / (entry or 'claude-code/cli.js')
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.write_text('"$LAUNCHER" "$HOOK_COMMAND"\nstatus=$?\nexit "$status"\n')
        return subprocess.run(
            ['bash', '-c', 'exec -a "$0" bash "$1" "${@:2}"', argv0, str(entry), *flags],
            input=input, text=True, capture_output=True, cwd=cwd, check=check,
            env=dict(env or self.env, LAUNCHER=str(self.launcher), HOOK_COMMAND=command))

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

    def windows_env(self, **extra):
        for name, source in {'uname': '#!/bin/sh\necho MINGW64_NT\n',
                             'cygpath': '#!/bin/sh\nprintf "%s\\n" "$2"\n'}.items():
            file = self.home / 'bin' / name
            file.write_text(source)
            file.chmod(0o755)
        self.addCleanup(self.stop_runtimes)
        return dict(self.env, FAKE_WINDOWS_CONTROL='1', **extra)

    def stop_runtimes(self):
        states = list(self.home.glob('*.json')) + list((self.home / 'remote-state').rglob('*.json'))
        for file in states:
            try:
                pid = json.loads(file.read_text()).get('native_pid')
                if pid:
                    os.kill(pid, signal.SIGTERM)
            except (ValueError, AttributeError, ProcessLookupError):
                pass

    def path_without_agents(self):
        # NixOS does not put its tools under /usr/bin. Link only dependencies, not real agent CLIs.
        tools = self.home / 'system-bin'
        tools.mkdir()
        for name in ('bash', 'cat', 'dirname', 'env', 'flock', 'head', 'jq', 'mkdir', 'mktemp',
                     'mv', 'python3', 'rm', 'sed', 'timeout', 'tr', 'uname'):
            source = shutil.which(name)
            if source:
                (tools / name).symlink_to(source)
        return f'{self.home / "bin"}:{tools}'

    def test_windows_request_does_not_use_herdr_prompt_or_wait_and_returns_its_report(self):
        result = self.run_cli('ask', 'Windows task', env=self.windows_env(HERDR_PROMPT_DELAY='0.5'))
        self.assertIn('Windows ship', result.stdout)
        self.assertFalse(any(c[:2] in (['agent', 'prompt'], ['agent', 'wait']) for c in self.calls()))

    def test_windows_start_waits_for_delayed_receiver_before_reporting_success(self):
        env = self.windows_env(FAKE_WINDOWS_START_DELAY='1.5')
        self.run_cli('start', env=env)
        owner = self.home / '.cache/claude-sidecar/windows/cc-pane-pane-1/owner.json'
        self.assertTrue(owner.exists(), 'start must not succeed before the native receiver is ready')
        result = self.run_cli('ask', 'Task after delayed startup', env=env)
        self.assertIn('Windows ship', result.stdout)
        self.assertEqual(len([c for c in self.calls() if c[:2] == ['agent', 'start']]), 1)
        self.assertFalse(any(c[:2] in (['agent', 'prompt'], ['agent', 'wait']) for c in self.calls()))

    def test_windows_retry_after_receiver_timeout_reuses_the_same_pi(self):
        env = self.windows_env(FAKE_WINDOWS_START_DELAY='5', SIDECAR_STARTUP_TIMEOUT_S='1')
        result = self.run_cli('start', env=env, check=False)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('timed out waiting', result.stderr)
        self.assertNotIn('started in', result.stdout)
        result = self.run_cli('ask', 'Retry the same process', env=dict(env, SIDECAR_STARTUP_TIMEOUT_S='10'))
        self.assertIn('Windows ship', result.stdout)
        self.assertEqual(len([c for c in self.calls() if c[:2] == ['agent', 'start']]), 1)

    def test_windows_request_lock_keeps_busy_steering_on_the_original_request(self):
        env = self.windows_env(HERDR_PROMPT_DELAY='3')
        process = subprocess.Popen([str(self.launcher), 'ask', 'Original'], text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        try:
            directory = self.home / '.cache/claude-sidecar/windows/cc-pane-pane-1'
            deadline = time.monotonic() + 10
            while not list(directory.glob('*.ack')):
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.05)
            duplicate = self.run_cli('ask', 'Original', env=env, check=False)
            self.assertEqual(duplicate.returncode, 4, duplicate.stderr)
            steered = self.run_cli('steer', 'New direction', env=env)
            self.assertNotIn('# Sidecar report', steered.stdout)
            stdout, stderr = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertIn('Windows ship', stdout)
            self.assertEqual(len(list((self.home / '.cache/claude-sidecar/requests').glob('*.md'))), 1)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_windows_cancellation_releases_request_and_note_locks(self):
        env = self.windows_env(HERDR_PROMPT_DELAY='30')
        directory = self.home / '.cache/claude-sidecar/windows/cc-pane-pane-1'
        for command in ('ask', 'note'):
            with self.subTest(command=command):
                previous = len(list(directory.glob('*.ack')))
                process = subprocess.Popen([str(self.launcher), command, 'Long Windows task'], text=True,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
                try:
                    deadline = time.monotonic() + 10
                    while len(list(directory.glob('*.ack'))) <= previous:
                        self.assertIsNone(process.poll(), 'launcher exited before delivery')
                        self.assertLess(time.monotonic(), deadline, 'request was not delivered')
                        time.sleep(.05)
                    process.send_signal(signal.SIGTERM)
                    _, stderr = process.communicate(timeout=5)
                    self.assertEqual(process.returncode, 143, stderr)
                    state = self.home / '.cache/claude-sidecar'
                    self.assertFalse((state / 'sc-pane-1.inflight').exists())
                    self.assertEqual(list(state.glob('windows-control.*')), [])
                    if command == 'ask':
                        request = json.loads((state / 'sc-pane-1.request.json').read_text())
                        self.assertEqual(request['exit_code'], 143)
                        self.assertIn('finished', request)
                    lock = subprocess.run(['flock', '-n', str(state / 'sc-pane-1.lock'), 'true'], env=env)
                    self.assertEqual(lock.returncode, 0, 'client must not retain the slot lock after cancellation')
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.communicate()

    def test_windows_true_settlement_without_report_returns_exit_2(self):
        result = self.run_cli('ask', 'No report', env=self.windows_env(FAKE_NO_REPORT='1'), check=False)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('no report submitted', result.stderr)

    def test_windows_question_and_report_recovery_preserve_exit_3(self):
        env = self.windows_env(FAKE_QUESTION='Which version?')
        result = self.run_cli('ask', 'Question', env=env, check=False)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn('NEEDS_ANSWER: Which version?', result.stdout)
        self.assertIn('Windows ship', self.run_cli('report', env=env).stdout)

    def test_windows_control_unit_tests(self):
        subprocess.run(['node', '--test', str(ROOT / 'tests/test_windows.mjs')], check=True, capture_output=True)

    def test_start_default_and_idempotency(self):
        self.run_cli('start')
        self.run_cli('start')
        starts = [c for c in self.calls() if c[:2] == ['agent', 'start']]
        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0][starts[0].index('--model') + 1], 'openai-codex/gpt-6.1-sol')
        self.assertEqual(starts[0][starts[0].index('--thinking') + 1], 'high')
        self.assertEqual(starts[0][starts[0].index('-e') + 1], str(self.plugin / 'sidecar/sidecar.ts'))

    def start_pane(self):
        start = [c for c in self.calls() if c[:2] == ['agent', 'start']][-1]
        return start[start.index('--pane') + 1]

    def lifecycle_state(self):
        state = self.home / '.cache/claude-sidecar'
        state.mkdir(parents=True, exist_ok=True)
        # Keep setup commands from racing an automatic sweep; tests invoke it explicitly.
        (state / 'sweep.timestamp').write_text(str(int(time.time())))
        self.addCleanup(self.wait_lifecycle_workers)
        return state

    def wait_lifecycle_workers(self):
        import fcntl
        state = self.home / '.cache/claude-sidecar'
        deadline = time.monotonic() + 15
        while True:
            calls = self.calls()
            closed = {c[2] for c in calls if c[:2] == ['pane', 'close']}
            latest = {c[2]: c[c.index('--pane') + 1]
                      for c in calls if c[:2] == ['agent', 'start']}
            pending = any(not (state / (name + '.stopped')).exists()
                          for name, pane in latest.items() if pane in closed)
            # The close is logged before stop_unlocked writes its final state. Wait for both
            # its marker and lock release before TemporaryDirectory removes the worker's home.
            for path in [state / 'sweep.lock', *state.glob('*.startup.lock')]:
                if not path.exists():
                    continue
                with path.open('r') as lock:
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        pending = True
            if not pending:
                return
            self.assertLess(time.monotonic(), deadline, 'lifecycle worker did not finish before cleanup')
            time.sleep(0.05)

    def start_orphan(self, *args):
        # Starts a slot for another Claude pane, then closes that pane.
        panes_path = self.home / 'panes.json'
        panes = json.loads(panes_path.read_text()) if panes_path.exists() else [
            {'pane_id': 'PANE:1', 'tab_id': 't1', 'workspace_id': 'workspace-1', 'agent': 'claude',
             'width': 324, 'height': 97}]
        panes_path.write_text(json.dumps(panes + [dict(panes[0], pane_id='PANE:77', tab_id='t77')]))
        self.run_cli(*args, 'start', env=dict(self.env, HERDR_PANE_ID='PANE:77'))
        self.remove_owner('PANE:77')
        return self.start_pane()

    def remove_owner(self, owner='PANE:1'):
        panes_path = self.home / 'panes.json'
        panes = json.loads(panes_path.read_text())
        panes_path.write_text(json.dumps([p for p in panes if p['pane_id'] != owner]))

    def wait_for_close(self, pane, message='pane was not closed'):
        deadline = time.monotonic() + 10
        while ['pane', 'close', pane] not in self.calls():
            self.assertLess(time.monotonic(), deadline, message)
            time.sleep(0.05)

    def test_delivered_report_closes_pane_and_next_request_resumes_session(self):
        state = self.lifecycle_state()
        env = dict(self.env, SIDECAR_CLOSE_WHEN_DONE='1')
        self.run_cli('ask', 'First request', env=env)
        pane = self.start_pane()
        session = (state / 'sc-pane-1.session').read_text()
        self.wait_for_close(pane, 'delivered report did not close its pane')
        self.wait_lifecycle_workers()
        self.assertEqual((state / 'sc-pane-1.session').read_text(), session)
        self.run_cli('ask', 'Resume closed conversation')
        starts = [c for c in self.calls() if c[:2] == ['agent', 'start']]
        self.assertEqual(len(starts), 2)
        self.assertEqual(starts[0][starts[0].index('--session-id') + 1],
                         starts[1][starts[1].index('--session-id') + 1])
        self.assertNotEqual(self.start_pane(), pane)

    def test_sweep_leaves_slots_of_a_live_owner_open(self):
        self.lifecycle_state()
        self.run_cli('start')
        self.run_cli('--slot', '2', 'ask', 'Finished request')
        old = time.time() - 86400
        for path in (self.home / '.cache/claude-sidecar').glob('*.agent'):
            os.utime(path, (old, old))
        self.run_cli('sweep')
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))
        self.remove_owner()
        self.run_cli('sweep')
        self.assertEqual(sum(c[:2] == ['pane', 'close'] for c in self.calls()), 2)

    def test_sweep_rechecks_live_status_after_process_ownership_check(self):
        self.lifecycle_state()
        self.run_cli('--agent', 'claude', 'start')
        self.remove_owner()
        before = len(self.calls())
        self.run_cli('sweep', env=dict(self.env, FAKE_WORKING_ON_PROCESS_INFO='1'))
        self.assertTrue(any(c[:2] == ['pane', 'process-info'] for c in self.calls()[before:]))
        self.assertEqual(json.loads((self.home / 'agent.json').read_text())['agent_status'], 'working')
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))

    def test_sweep_rechecks_live_focus_after_process_ownership_check(self):
        self.lifecycle_state()
        self.run_cli('--agent', 'claude', 'start')
        self.remove_owner()
        pane = self.start_pane()
        self.run_cli('sweep', env=dict(self.env, FAKE_FOCUS_ON_PROCESS_INFO='1'))
        self.assertIn(['pane', 'get', pane], self.calls())
        panes = json.loads((self.home / 'panes.json').read_text())
        self.assertTrue(next(p for p in panes if p['pane_id'] == pane)['focused'])
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))

    def test_done_close_protects_busy_pending_pinned_and_focused_slots(self):
        state = self.lifecycle_state()
        for slot in range(1, 8):
            self.run_cli('--slot', str(slot), 'ask', 'Finished request')
        for filename, status in [('agent.json', 'working'), ('sc-pane-1-2.agent.json', 'blocked'),
                                 ('sc-pane-1-6.agent.json', 'unknown'), ('sc-pane-1-7.agent.json', '')]:
            path = self.home / filename
            record = json.loads(path.read_text())
            record['agent_status'] = status
            path.write_text(json.dumps(record))
        (state / 'sc-pane-1-3.pending').write_text('unanswered-request')
        self.run_cli('--slot', '4', 'keep')
        panes = json.loads((self.home / 'panes.json').read_text())
        focused = json.loads((self.home / 'sc-pane-1-5.agent.json').read_text())['pane_id']
        next(p for p in panes if p['pane_id'] == focused)['focused'] = True
        (self.home / 'panes.json').write_text(json.dumps(panes))
        for slot in range(1, 8):
            name = 'sc-pane-1' + (f'-{slot}' if slot > 1 else '')
            request = json.loads((state / (name + '.request.json')).read_text())
            subprocess.run([str(self.launcher), 'done-close', name, request['id']], text=True,
                           capture_output=True, check=True, timeout=10,
                           env=dict(self.env, DONE_CLOSE_WAIT_S='1'))
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))

    def test_sweep_skips_a_held_request_lock_without_waiting(self):
        import fcntl
        state = self.lifecycle_state()
        self.run_cli('start')
        self.remove_owner()
        with (state / 'sc-pane-1.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = subprocess.run([str(self.launcher), 'sweep'], env=self.env,
                                    text=True, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))
        self.run_cli('sweep')
        self.assertIn(['pane', 'close', self.start_pane()], self.calls())

    def test_sweep_owner_gone_closes_even_a_recent_pinned_slot(self):
        state = self.lifecycle_state()
        self.run_cli('ask', '--keep', 'Watch this request')
        self.assertTrue((state / 'sc-pane-1.keep').exists())
        self.remove_owner()
        self.run_cli('sweep')
        self.assertIn(['pane', 'close', self.start_pane()], self.calls())

    def test_keep_unkeep_and_fresh_stop_manage_the_slot_pin(self):
        state = self.lifecycle_state()
        self.run_cli('--slot', '2', 'ask', '--keep', 'Watch this request')
        pin = state / 'sc-pane-1-2.keep'
        self.assertTrue(pin.exists())
        self.assertFalse((state / 'sc-pane-1.keep').exists())
        self.run_cli('--slot', '2', 'unkeep')
        self.assertFalse(pin.exists())
        self.run_cli('--slot', '2', 'unkeep')
        self.run_cli('--slot', '2', 'keep')
        self.run_cli('--slot', '2', 'stop')
        self.assertTrue(pin.exists())
        self.run_cli('--slot', '2', 'stop', '--fresh')
        self.assertFalse(pin.exists())

    def test_sweep_refuses_stale_session_and_process_identities(self):
        self.lifecycle_state()
        self.run_cli('start')
        path = self.home / 'agent.json'
        original = json.loads(path.read_text())
        original['agent_session'] = {'value': '/tmp/time_foreign.jsonl'}
        path.write_text(json.dumps(original))
        self.run_cli('--slot', '2', '--agent', 'claude', 'start')
        self.remove_owner()
        claude_path = self.home / 'sc-pane-1-2.agent.json'
        claude = json.loads(claude_path.read_text())
        claude['_argv'] = ['claude', '--resume', 'aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee']
        claude_path.write_text(json.dumps(claude))
        self.run_cli('sweep')
        self.assertTrue(path.exists())
        self.assertTrue(claude_path.exists())
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))

    def test_sweep_closes_ownerless_claude_and_codex_slots(self):
        state = self.lifecycle_state()
        self.run_cli('--agent', 'claude', 'ask', 'Claude request')
        self.run_cli('--slot', '2', '--agent', 'codex', 'ask', 'Codex request')
        files = ['sc-pane-1.session', 'sc-pane-1.claude-started', 'sc-pane-1-2.codex-session']
        sessions = {name: (state / name).read_text() for name in files}
        self.remove_owner()
        codex = self.home / 'sc-pane-1-2.agent.json'
        record = json.loads(codex.read_text())
        record['agent_status'] = 'done'
        codex.write_text(json.dumps(record))
        self.run_cli('sweep')
        self.assertEqual(sum(c[:2] == ['pane', 'close'] for c in self.calls()), 2)
        for name, session in sessions.items():
            self.assertEqual((state / name).read_text(), session)

    def test_sweep_skips_remote_slots_but_stop_all_closes_them(self):
        self.lifecycle_state()
        self.add_machines()
        self.remote_run('--machine', 'm1', 'ask', 'Remote request',
                        env=dict(self.remote_env, SIDECAR_CLOSE_WHEN_DONE='1'))
        (self.home / '.cache/claude-sidecar/sc-pane-1.ended').write_text('gone\n')
        self.run_cli('sweep')
        self.assertFalse(any('close' in c for c in self.calls()))
        self.remote_run('stop', '--all')
        self.assertTrue(any(c[:2] == ['pane', 'close'] for c in self.remote_calls()))

    def test_sweep_visits_other_owners_and_slots(self):
        self.lifecycle_state()
        self.run_cli('start')
        pane = self.start_orphan('--slot', '2')
        self.run_cli('sweep')
        self.assertIn(['pane', 'close', pane], self.calls())
        self.assertEqual(sum(c[:2] == ['pane', 'close'] for c in self.calls()), 1)

    def test_command_sweep_is_async_and_rate_limited(self):
        state = self.lifecycle_state()
        pane = self.start_orphan()
        timestamp = state / 'sweep.timestamp'
        now = int(time.time())
        timestamp.write_text(str(now))
        self.run_cli('status')
        self.assertEqual(int(timestamp.read_text().strip()), now)
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))
        timestamp.write_text(str(now - 120))
        started = time.monotonic()
        self.run_cli('status', env=dict(self.env, HERDR_GET_DELAY='0.5'))
        self.assertLess(time.monotonic() - started, 3, 'launcher waited for the entire sweep')
        deadline = time.monotonic() + 12
        while ['pane', 'close', pane] not in self.calls():
            self.assertLess(time.monotonic(), deadline, 'detached sweep did not close the ownerless pane')
            time.sleep(0.05)
        self.assertGreater(int(timestamp.read_text().strip()), now - 120)
        self.assertTrue((state / 'sweep.log').exists())
        # A second command within the interval must not update the timestamp.
        recent = timestamp.read_text()
        self.run_cli('status')
        self.assertEqual(timestamp.read_text(), recent)

    def test_session_start_triggers_detached_sweep(self):
        state = self.lifecycle_state()
        pane = self.start_orphan()
        (state / 'sweep.timestamp').write_text(str(int(time.time()) - 120))
        result = self.run_cli('session-start', input=json.dumps({'session_id': 'owner-session'}))
        self.assertEqual(json.loads(result.stdout)['hookSpecificOutput']['hookEventName'], 'SessionStart')
        deadline = time.monotonic() + 10
        while ['pane', 'close', pane] not in self.calls():
            self.assertLess(time.monotonic(), deadline, 'SessionStart did not trigger a sweep')
            time.sleep(0.05)

    def test_push_gate_triggers_sweep_and_respects_rate_limit_lock(self):
        import fcntl
        state = self.lifecycle_state()
        pane = self.start_orphan()
        timestamp = state / 'sweep.timestamp'
        old = str(int(time.time()) - 120)
        timestamp.write_text(old)
        hook = self.plugin / 'scripts/push-gate'
        payload = json.dumps({'tool_input': {'command': 'echo harmless'}})
        with (state / 'sweep.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            subprocess.run([str(hook)], input=payload, env=self.env, text=True,
                           capture_output=True, check=True, timeout=5)
            self.assertEqual(timestamp.read_text(), old)
            self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))
        subprocess.run([str(hook)], input=payload, env=self.env, text=True,
                       capture_output=True, check=True, timeout=5)
        deadline = time.monotonic() + 10
        while ['pane', 'close', pane] not in self.calls():
            self.assertLess(time.monotonic(), deadline, 'Bash hook did not trigger a sweep')
            time.sleep(0.05)
        recent = timestamp.read_text()
        subprocess.run([str(hook)], input=payload, env=self.env, text=True,
                       capture_output=True, check=True, timeout=5)
        self.assertEqual(timestamp.read_text(), recent)

    def test_sweep_owner_alias_is_resolved_before_declaring_owner_gone(self):
        self.lifecycle_state()
        self.run_cli('ask', '--keep', 'Keep watching')
        panes_path = self.home / 'panes.json'
        panes = json.loads(panes_path.read_text())
        owner = next(p for p in panes if p['pane_id'] == 'PANE:1')
        owner.update(pane_id='PANE:99', aliases=['PANE:1'])
        panes_path.write_text(json.dumps(panes))
        self.run_cli('sweep')
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))
        self.assertIn(['pane', 'get', 'PANE:1'], self.calls())

    def test_sweep_unknown_owner_lookup_closes_nothing(self):
        self.lifecycle_state()
        self.run_cli('start')
        self.run_cli('keep')
        self.run_cli('--slot', '2', 'start')
        panes_path = self.home / 'panes.json'
        panes = json.loads(panes_path.read_text())
        next(p for p in panes if p['pane_id'] == 'PANE:1').update(
            pane_id='PANE:99', aliases=['PANE:1'])
        panes_path.write_text(json.dumps(panes))
        # Only the owner's lookup fails; sidecar identity and focus checks still work.
        failures = {
            'transport': {'stderr': 'transport: pane_not_found while waiting for response'},
            'malformed': {'stdout': '{not JSON: pane_not_found', 'returncode': 0},
            'other-code': {'stdout': json.dumps({'error': {
                'code': 'transport_timeout', 'message': 'pane_not_found'}})},
            'missing-code': {'stdout': json.dumps({'error': {'message': 'pane_not_found'}})},
            'empty-result': {'stdout': json.dumps({'result': {}}), 'returncode': 0},
            'timeout': {'delay': 30},
        }
        for label, error in failures.items():
            with self.subTest(failure=label):
                (self.home / 'pane-errors.json').write_text(json.dumps({'PANE:1': error}))
                before = len(self.calls())
                started = time.monotonic()
                self.run_cli('sweep')
                # Each of the two slots may make a separately bounded 10-second lookup.
                self.assertLess(time.monotonic() - started, 25, 'owner lookup must be bounded')
                self.assertIn(['pane', 'get', 'PANE:1'], self.calls()[before:])
                self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))

    def test_session_end_rejects_unregistered_or_mismatched_session(self):
        self.lifecycle_state()
        self.run_cli('start')
        self.run_cli('session-end', input=json.dumps({'session_id': 'stranger', 'reason': 'logout'}))
        self.run_cli('session-start', input=json.dumps({'session_id': 'owner-session'}))
        for payload in ({'session_id': 'stranger', 'reason': 'logout'}, {'reason': 'logout'}, {}):
            self.run_cli('session-end', input=json.dumps(payload))
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))

    def test_session_end_defers_protected_slots_until_a_later_sweep(self):
        import fcntl
        state = self.lifecycle_state()
        self.run_cli('session-start', input=json.dumps({'session_id': 'owner-session'}))
        for slot in range(1, 9):
            self.run_cli('--slot', str(slot), 'start')
            name = 'sc-pane-1' + (f'-{slot}' if slot > 1 else '')
            # Ended owners override pins, but never the live activity protections.
            (state / (name + '.keep')).write_text('')
        for filename, status in [('agent.json', 'working'), ('sc-pane-1-2.agent.json', 'blocked'),
                                 ('sc-pane-1-3.agent.json', 'unknown'), ('sc-pane-1-4.agent.json', '')]:
            path = self.home / filename
            record = json.loads(path.read_text())
            record['agent_status'] = status
            path.write_text(json.dumps(record))
        (state / 'sc-pane-1-5.pending').write_text('unanswered-question')
        panes_path = self.home / 'panes.json'
        panes = json.loads(panes_path.read_text())
        focused = json.loads((self.home / 'sc-pane-1-6.agent.json').read_text())['pane_id']
        next(p for p in panes if p['pane_id'] == focused)['focused'] = True
        panes_path.write_text(json.dumps(panes))
        idle_pane = self.start_pane()
        with (state / 'sc-pane-1-7.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            started = time.monotonic()
            self.run_cli('session-end', input=json.dumps({
                'session_id': 'owner-session', 'reason': 'logout'}))
            self.assertLess(time.monotonic() - started, 10, 'SessionEnd waited for a request lock')
            self.assertEqual((state / 'sc-pane-1.ended').read_text().strip(), 'owner-session')
            self.assertEqual([c for c in self.calls() if c[:2] == ['pane', 'close']],
                             [['pane', 'close', idle_pane]])
        for filename in ('agent.json', 'sc-pane-1-2.agent.json',
                         'sc-pane-1-3.agent.json', 'sc-pane-1-4.agent.json'):
            path = self.home / filename
            record = json.loads(path.read_text())
            record['agent_status'] = 'idle'
            path.write_text(json.dumps(record))
        (state / 'sc-pane-1-5.pending').unlink()
        panes = json.loads(panes_path.read_text())
        next(p for p in panes if p['pane_id'] == focused)['focused'] = False
        panes_path.write_text(json.dumps(panes))
        self.run_cli('sweep')
        self.assertEqual(sum(c[:2] == ['pane', 'close'] for c in self.calls()), 8)

    def test_sweep_legacy_numbered_slot_locks_parent_before_using_ended_marker(self):
        import fcntl
        state = self.lifecycle_state()
        self.run_cli('session-start', input=json.dumps({'session_id': 'old-owner'}))
        self.run_cli('--slot', '2', 'start')
        self.run_cli('--slot', '2', 'keep')
        (state / 'sc-pane-1-2.owner').unlink()
        (state / 'sc-pane-1.ended').write_text('old-owner\n')
        with (state / 'sc-pane-1.identity.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = subprocess.run([str(self.launcher), 'sweep'], env=self.env,
                                    text=True, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))
        self.run_cli('session-start', input=json.dumps({'session_id': 'revived-owner'}))
        self.assertFalse((state / 'sc-pane-1.ended').exists())
        self.assertEqual((state / 'sc-pane-1.claude-owner-session').read_text().strip(), 'revived-owner')
        self.run_cli('sweep')
        self.assertTrue((state / 'sc-pane-1-2.keep').exists())
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))

    def test_session_end_sweep_is_scoped_to_its_owner(self):
        self.lifecycle_state()
        self.run_cli('session-start', input=json.dumps({'session_id': 'owner-session'}))
        self.run_cli('start')
        owned = self.start_pane()
        other = dict(self.env, HERDR_PANE_ID=owned)
        self.run_cli('start', env=other)
        self.run_cli('session-end', input=json.dumps({'session_id': 'owner-session', 'reason': 'logout'}))
        self.assertEqual([c for c in self.calls() if c[:2] == ['pane', 'close']],
                         [['pane', 'close', owned]])

    def test_explicit_stop_all_still_closes_busy_pending_focused_pinned_slots(self):
        state = self.lifecycle_state()
        self.run_cli('start')
        self.run_cli('keep')
        record = json.loads((self.home / 'agent.json').read_text())
        record['agent_status'] = 'working'
        (self.home / 'agent.json').write_text(json.dumps(record))
        (state / 'sc-pane-1.pending').write_text('unanswered-question')
        panes_path = self.home / 'panes.json'
        panes = json.loads(panes_path.read_text())
        next(p for p in panes if p['pane_id'] == self.start_pane())['focused'] = True
        panes_path.write_text(json.dumps(panes))
        self.run_cli('stop', '--all')
        self.assertIn(['pane', 'close', self.start_pane()], self.calls())

    def test_unidentified_hooks_publish_identity_without_claiming_or_ending_ownership(self):
        state = self.lifecycle_state()
        env_file = self.home / 'claude.env'
        env = dict(self.env, SIDECAR_TEST_ANCESTRY_PID='1', CLAUDE_ENV_FILE=str(env_file))
        payload = json.dumps({'session_id': 'stranger', 'reason': 'logout'})
        # Even under an interactive Claude-shaped parent, the bounded walk is unidentified.
        result = self.run_hook('session-start', input=payload, env=env)
        self.assertEqual(json.loads(result.stdout)['hookSpecificOutput']['hookEventName'], 'SessionStart')
        self.assertIn('SIDECAR_AGENT=sc-pane-1', env_file.read_text())
        self.assertIn('SIDECAR_PI_SESSION=cc-stranger', env_file.read_text())
        self.assertEqual((state / 'sc-pane-1.session').read_text().strip(), 'cc-stranger')
        self.assertFalse((state / 'sc-pane-1.claude-owner-session').exists())
        self.run_cli('session-start', input=json.dumps({'session_id': 'owner-session'}))
        self.run_cli('start')
        for command, sid in (('session-start', 'stranger'), ('session-end', 'owner-session')):
            self.run_hook(command, input=json.dumps({'session_id': sid, 'reason': 'logout'}), env=env)
        self.assertFalse((state / 'sc-pane-1.claude-owner-session').exists())
        self.assertFalse((state / 'sc-pane-1.ended').exists())
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))

    def test_unidentified_start_clears_ended_owner_for_existing_and_fresh_slots(self):
        state = self.lifecycle_state()
        self.run_cli('session-start', input=json.dumps({'session_id': 'old-owner'}))
        self.run_cli('ask', '--keep', 'Keep the existing conversation')
        agent = self.home / 'agent.json'
        record = json.loads(agent.read_text())
        record['agent_status'] = 'working'
        agent.write_text(json.dumps(record))
        self.run_cli('session-end', input=json.dumps({'session_id': 'old-owner', 'reason': 'logout'}))
        self.assertTrue((state / 'sc-pane-1.ended').exists())
        record['agent_status'] = 'idle'
        agent.write_text(json.dumps(record))
        env = dict(self.env, SIDECAR_TEST_ANCESTRY_PID='1')
        # Expire the trigger too: startup must clear termination evidence before scheduling cleanup.
        (state / 'sweep.timestamp').write_text('0')
        result = self.run_hook('session-start', env=env,
                               input=json.dumps({'session_id': 'new-live-owner'}))
        self.assertEqual(json.loads(result.stdout)['hookSpecificOutput']['hookEventName'], 'SessionStart')
        self.assertFalse((state / 'sc-pane-1.ended').exists())
        self.assertFalse((state / 'sc-pane-1.claude-owner-session').exists())
        self.run_cli('ask', '--keep', 'Continue under the new session')
        self.run_cli('--slot', '2', 'ask', 'A fresh numbered slot')
        self.run_cli('sweep')
        # Neither an unidentified ending nor the old identified owner's ending may reclaim the slots.
        self.run_hook('session-end', env=env,
                      input=json.dumps({'session_id': 'new-live-owner', 'reason': 'logout'}))
        self.run_cli('session-end', input=json.dumps({'session_id': 'old-owner', 'reason': 'logout'}))
        self.assertTrue((state / 'sc-pane-1.keep').exists())
        self.assertTrue((state / 'sc-pane-1-2.agent').exists())
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))

    def test_excluded_hooks_do_not_publish_identity(self):
        state = self.lifecycle_state()
        env_file = self.home / 'claude.env'
        env = dict(self.env, CLAUDE_ENV_FILE=str(env_file))
        for flags in (('-p',), ('-n', 'claude-sidecar')):
            with self.subTest(flags=flags):
                result = self.run_hook('session-start', flags=flags, env=env,
                                       input=json.dumps({'session_id': 'excluded'}))
                self.assertEqual(result.stdout, '')
                self.assertFalse(env_file.exists())
                self.assertFalse((state / 'sc-pane-1.session').exists())
                self.assertFalse((state / 'sc-pane-1.claude-owner-session').exists())

    def test_windows_shaped_interactive_claude_ancestors_own_hooks(self):
        state = self.lifecycle_state()
        shapes = [('claude.exe', None), ('C:\\Users\\USER\\CLAUDE.EXE', None),
                  ('node.exe', None), ('C:\\Program Files\\NODE.EXE',
                   'C:\\Users\\USER\\@Anthropic-AI\\Claude-Code\\CLI.JS')]
        for index, (argv0, entry) in enumerate(shapes):
            with self.subTest(argv0=argv0, entry=entry):
                sid = f'interactive-{index}'
                result = self.run_hook('session-start', argv0=argv0, entry=entry,
                                       input=json.dumps({'session_id': sid}))
                self.assertEqual(json.loads(result.stdout)['hookSpecificOutput']['hookEventName'], 'SessionStart')
                self.assertEqual((state / 'sc-pane-1.claude-owner-session').read_text().strip(), sid)
                self.run_cli('start')
                pane = self.start_pane()
                self.run_hook('session-end', argv0=argv0, entry=entry,
                              input=json.dumps({'session_id': sid, 'reason': 'logout'}))
                self.assertIn(['pane', 'close', pane], self.calls())
                self.assertEqual((state / 'sc-pane-1.ended').read_text().strip(), sid)

    def test_windows_shaped_headless_and_named_claude_cannot_replace_owner(self):
        state = self.lifecycle_state()
        self.run_cli('session-start', input=json.dumps({'session_id': 'owner-session'}))
        self.run_cli('start')
        shapes = [('claude.exe', None), ('C:\\Users\\USER\\CLAUDE.EXE', None),
                  ('node.exe', None), ('C:\\Program Files\\NODE.EXE',
                   'C:\\Users\\USER\\@Anthropic-AI\\Claude-Code\\CLI.JS')]
        for argv0, entry in shapes:
            for flags in (('-p',), ('--print',), ('-n', 'claude-sidecar')):
                with self.subTest(argv0=argv0, flags=flags):
                    result = self.run_hook('session-start', argv0=argv0, entry=entry, flags=flags,
                                           input=json.dumps({'session_id': 'headless-child'}))
                    self.assertEqual(result.stdout, '')
                    self.assertEqual((state / 'sc-pane-1.claude-owner-session').read_text().strip(), 'owner-session')
                    # Matching the registered owner's ID must not bypass ancestry checks.
                    self.run_hook('session-end', argv0=argv0, entry=entry, flags=flags,
                                  input=json.dumps({'session_id': 'owner-session', 'reason': 'logout'}))
                    self.assertFalse((state / 'sc-pane-1.ended').exists())
                    self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))

    def test_nested_claude_session_end_cannot_close_parent_panes(self):
        self.lifecycle_state()
        self.run_cli('session-start', input=json.dumps({'session_id': 'owner-session'}))
        self.run_cli('start')
        entry = self.home / 'nested-claude'
        entry.write_text('"$LAUNCHER" session-end <<<\'{"session_id":"owner-session","reason":"logout"}\'\n')
        for flags in (['-p'], ['-n', 'claude-sidecar']):
            subprocess.run(['bash', '-c', 'exec -a claude bash "$1" "${@:2}"', 'x', str(entry), *flags],
                           env=dict(self.env, LAUNCHER=str(self.launcher)),
                           capture_output=True, text=True, check=True)
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))

    def test_unfinished_requests_keep_their_panes(self):
        state = self.lifecycle_state()
        env = dict(self.env, SIDECAR_CLOSE_WHEN_DONE='1')
        self.run_cli('ask', '--keep', 'Pinned request', env=env)
        self.run_cli('--slot', '2', 'ask', 'Question', env=dict(env, FAKE_QUESTION='Which one?'), check=False)
        self.run_cli('--slot', '3', 'ask', 'No report', env=dict(env, FAKE_NO_REPORT='1'), check=False)
        self.assertEqual(json.loads((state / 'sc-pane-1-2.request.json').read_text())['exit_code'], 3)
        self.assertEqual(json.loads((state / 'sc-pane-1-3.request.json').read_text())['exit_code'], 2)
        time.sleep(3)
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))

    def test_unkeep_after_a_delivered_report_closes_the_pane(self):
        self.lifecycle_state()
        env = dict(self.env, SIDECAR_CLOSE_WHEN_DONE='1')
        self.run_cli('ask', '--keep', 'Watch this request', env=env)
        pane = self.start_pane()
        time.sleep(1)
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))
        self.run_cli('unkeep', env=env)
        self.wait_for_close(pane, 'unkeep did not close the finished pane')

    def test_done_close_skips_a_newer_request_and_other_slots(self):
        state = self.lifecycle_state()
        self.run_cli('--slot', '2', 'start')
        self.run_cli('ask', 'First request')
        pane = self.start_pane()
        first = json.loads((state / 'sc-pane-1.request.json').read_text())['id']
        self.run_cli('ask', 'Newer request')
        subprocess.run([str(self.launcher), 'done-close', 'sc-pane-1', first], text=True,
                       capture_output=True, check=True, timeout=10, env=self.env)
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))
        newer = json.loads((state / 'sc-pane-1.request.json').read_text())['id']
        subprocess.run([str(self.launcher), 'done-close', 'sc-pane-1', newer], text=True,
                       capture_output=True, check=True, timeout=10, env=self.env)
        self.assertEqual([c for c in self.calls() if c[:2] == ['pane', 'close']],
                         [['pane', 'close', pane]])

    def test_sweep_reports_unreachable_herdr(self):
        self.lifecycle_state()
        herdr = self.home / 'bin/herdr'
        herdr.write_text('#!/bin/sh\nexit 1\n')
        result = self.run_cli('sweep', check=False)
        self.assertNotEqual(result.returncode, 0)

    def test_session_end_clear_keeps_panes_and_other_reasons_sweep_all_owned_slots(self):
        state = self.lifecycle_state()
        self.run_cli('session-start', input=json.dumps({'session_id': 'owner-session'}))
        self.run_cli('start')
        self.run_cli('--slot', '2', 'start')
        self.run_cli('session-end', input=json.dumps({'session_id': 'owner-session', 'reason': 'clear'}))
        self.assertFalse((state / 'sc-pane-1.ended').exists())
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))
        self.run_cli('session-end', input=json.dumps({'session_id': 'owner-session', 'reason': 'prompt_input_exit'}))
        self.assertEqual((state / 'sc-pane-1.ended').read_text().strip(), 'owner-session')
        self.assertEqual(sum(c[:2] == ['pane', 'close'] for c in self.calls()), 2)

    def test_stop_closes_the_pane_and_the_next_request_resumes_the_session(self):
        self.run_cli('start')
        pane = self.start_pane()
        result = self.run_cli('stop')
        self.assertIn('stopped', result.stdout)
        self.assertIn(['pane', 'close', pane], self.calls())
        self.assertIn(': stopped (', self.run_cli('status').stdout)
        self.run_cli('stop')  # Idempotent: nothing left to close.
        self.assertEqual(sum(c[:2] == ['pane', 'close'] for c in self.calls()), 1)
        self.run_cli('ask', 'Resume after stop')
        starts = [c for c in self.calls() if c[:2] == ['agent', 'start']]
        self.assertEqual(len(starts), 2)
        self.assertEqual(starts[1][starts[1].index('--session-id') + 1], starts[0][starts[0].index('--session-id') + 1])
        self.assertNotEqual(self.start_pane(), pane)
        self.assertNotIn(': stopped (', self.run_cli('status').stdout)

    def test_stop_refuses_during_a_request_unless_forced(self):
        self.run_cli('start')
        lock = self.home / '.cache/claude-sidecar/sc-pane-1.lock'
        holder = subprocess.Popen(['flock', str(lock), 'sleep', '30'])
        self.addCleanup(holder.kill)
        deadline = time.time() + 5
        while subprocess.run(['flock', '-n', str(lock), 'true']).returncode == 0 and time.time() < deadline:
            time.sleep(0.05)
        refused = self.run_cli('stop', check=False)
        self.assertEqual(refused.returncode, 7)
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))
        forced = self.run_cli('stop', '--force')
        self.assertIn('--force', forced.stderr)
        self.assertTrue(any(c[:2] == ['pane', 'close'] for c in self.calls()))

    def test_stop_leaves_a_foreign_agent_in_the_pane(self):
        self.run_cli('start')
        agent = self.home / 'agent.json'
        state = json.loads(agent.read_text())
        state['agent_session'] = {'value': '/tmp/time_someone-else.jsonl'}
        agent.write_text(json.dumps(state))
        result = self.run_cli('stop')
        self.assertIn('left it running', result.stderr)
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))

    def test_stop_fresh_starts_a_new_pi_session(self):
        self.run_cli('start')
        self.run_cli('stop', '--fresh')
        self.run_cli('start')
        starts = [c for c in self.calls() if c[:2] == ['agent', 'start']]
        first, second = (s[s.index('--session-id') + 1] for s in starts)
        self.assertNotEqual(first, second)
        self.assertTrue(second.startswith(first + '-f'))
        self.run_cli('stop')
        self.run_cli('start')
        third = [c for c in self.calls() if c[:2] == ['agent', 'start']][-1]
        self.assertEqual(third[third.index('--session-id') + 1], second)

    def test_stop_fresh_survives_the_session_start_hook_reexport(self):
        env = dict(self.env, SIDECAR_PI_SESSION='cc-first')
        self.run_cli('start', env=env)
        self.run_cli('stop', '--fresh', env=env)
        self.run_cli('start', env=env)
        fresh = (self.home / '.cache/claude-sidecar/sc-pane-1.session').read_text().strip()
        self.assertTrue(fresh.startswith('cc-first-f'))
        # The hook exports the effective id; it must map to the same session, not a doubly suffixed one.
        hooked = dict(self.env, SIDECAR_PI_SESSION=fresh)
        self.assertEqual(self.run_cli('status', env=hooked).returncode, 0)
        self.run_cli('start', env=hooked)
        starts = [c for c in self.calls() if c[:2] == ['agent', 'start']]
        self.assertEqual(len(starts), 2)

    def test_stop_fresh_claude_session_survives_the_hook_reexport(self):
        env = dict(self.env, SIDECAR_PI_SESSION='cc-first')
        self.run_cli('--agent', 'claude', 'start', env=env)
        self.run_cli('stop', '--fresh', env=env)
        self.run_cli('start', env=env)
        created = [c for c in self.calls() if c[:2] == ['agent', 'start']][-1]
        uuid = created[created.index('--session-id') + 1]
        fresh = (self.home / '.cache/claude-sidecar/sc-pane-1.session').read_text().strip()
        hooked = dict(self.env, SIDECAR_PI_SESSION=fresh)
        self.run_cli('stop', env=hooked)
        self.run_cli('start', env=hooked)
        resumed = [c for c in self.calls() if c[:2] == ['agent', 'start']][-1]
        self.assertEqual(resumed[resumed.index('--resume') + 1], uuid)

    def test_stop_leaves_a_foreign_claude_conversation_running(self):
        self.run_cli('--agent', 'claude', 'start')
        agent = self.home / 'agent.json'
        state = json.loads(agent.read_text())
        state['_argv'] = ['claude', '--resume', 'aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee']
        agent.write_text(json.dumps(state))
        result = self.run_cli('stop')
        self.assertIn('left it running', result.stderr)
        self.assertFalse(any(c[:2] == ['pane', 'close'] for c in self.calls()))
        self.assertTrue(agent.exists())

    def test_stop_fresh_drops_the_codex_session(self):
        self.run_cli('--agent', 'codex', 'start')
        session_file = self.home / '.cache/claude-sidecar/sc-pane-1.codex-session'
        old = session_file.read_text().strip()
        self.run_cli('stop', '--fresh')
        self.assertFalse(session_file.exists())
        self.run_cli('start')
        last = [c for c in self.calls() if c[:2] == ['agent', 'start']][-1]
        self.assertNotIn('resume', last)
        self.assertNotEqual(session_file.read_text().strip(), old)

    def test_stop_all_stops_every_slot(self):
        self.run_cli('start')
        self.run_cli('--slot', '3', '--agent', 'codex', 'start')
        result = self.run_cli('stop', '--all')
        self.assertEqual(sum(c[:2] == ['pane', 'close'] for c in self.calls()), 2)
        self.assertIn('sc-pane-1 stopped', result.stdout)
        self.assertIn('sc-pane-1-3 stopped', result.stdout)

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

    @staticmethod
    def codex_config(start):
        return dict(start[index + 1].split('=', 1)
                    for index, arg in enumerate(start[:-1]) if arg in ('-c', '--config'))

    def test_codex_starts_with_ultra_and_remembers_its_session(self):
        self.run_cli('--agent', 'codex', 'start')
        start = next(c for c in self.calls() if c[:2] == ['agent', 'start'])
        self.assertEqual(start[start.index('--kind') + 1], 'codex')
        self.assertEqual(start[start.index('--model') + 1], 'gpt-6.1-sol')
        config = self.codex_config(start)
        self.assertEqual(json.loads(config['model_reasoning_effort']), 'ultra')
        prompt = Path(json.loads(config['model_instructions_file']))
        self.assertTrue(prompt.is_absolute())
        self.assertIn('codex-prompt', prompt.name)
        self.assertIn('Codex', prompt.read_text())
        self.assertIn('.needs-answer', prompt.read_text())
        self.assertNotIn('with the Write tool', prompt.read_text())
        self.assertEqual(start[start.index('--add-dir') + 1], str(self.home / '.cache/claude-sidecar'))
        self.assertNotIn('--session-id', start)
        self.assertNotIn('resume', start)
        self.assertIn('--yolo', start)
        session = (self.home / '.cache/claude-sidecar/sc-pane-1.codex-session').read_text().strip()
        self.assertRegex(session, r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
        self.assertEqual(json.loads((self.home / 'agent.json').read_text())['agent_session']['value'], session)
        self.run_cli('start')
        self.assertEqual(len([c for c in self.calls() if c[:2] == ['agent', 'start']]), 1)
        self.assertEqual((self.home / '.cache/claude-sidecar/sc-pane-1.agent').read_text().strip(), 'codex')

    def test_codex_implementer_also_defaults_to_ultra(self):
        self.run_cli('--slot', '2', '--agent', 'codex', '--role', 'implementer', 'start')
        start = next(c for c in self.calls() if c[:2] == ['agent', 'start'])
        self.assertEqual(json.loads(self.codex_config(start)['model_reasoning_effort']), 'ultra')
        self.run_cli('--slot', '2', 'ask', 'Continue implementing')
        self.assertEqual(len([c for c in self.calls() if c[:2] == ['agent', 'start']]), 1)

    def test_codex_windows_converts_agent_paths_and_keeps_local_report_paths(self):
        env = self.windows_env(FAKE_QUESTION='Which target?')
        (self.home / 'bin/cygpath').write_text('#!/bin/sh\nprintf "C:%s\\n" "$2"\n')
        result = self.run_cli('--agent', 'codex', 'ask', 'Windows Codex task', env=env, check=False)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn('NEEDS_ANSWER: Which target?', result.stdout)
        state = self.home / '.cache/claude-sidecar'
        report = self.report_path(result.stdout)
        self.assertEqual(report.parent, state / 'reports')
        self.assertIn('ship', report.read_text())
        self.assertEqual((state / 'sc-pane-1.report').read_text().strip(), str(report))
        request = next((state / 'requests').glob('*.md'))
        start = next(c for c in self.calls() if c[:2] == ['agent', 'start'])
        config = self.codex_config(start)
        self.assertEqual(json.loads(config['model_instructions_file']),
                         f'C:{state / "sc-pane-1.codex-prompt.md"}')
        self.assertEqual(start[start.index('--add-dir') + 1], f'C:{state}')
        prompts = [c[3] for c in self.calls() if c[:2] == ['agent', 'prompt']]
        self.assertEqual(len(prompts), 2)
        self.assertTrue(prompts[0].startswith('[note] Initialize this sidecar'))
        self.assertIn(f'Read C:{request} and', prompts[1])
        self.assertIn(f'report to C:{report};', prompts[1])
        self.assertIn(f'to C:{report.with_suffix(".needs-answer")},', prompts[1])
        session = (state / 'sc-pane-1.codex-session').read_text().strip()
        self.assertEqual(json.loads((self.home / 'agent.json').read_text())['agent_session']['value'], session)
        self.run_cli('start', env=env)
        self.assertEqual(len([c for c in self.calls() if c[:2] == ['agent', 'start']]), 1)
        self.assertFalse(any(c[:2] == ['pane', 'process-info'] for c in self.calls()))
        self.assertFalse((state / 'windows').exists())

    def test_codex_model_and_reasoning_overrides(self):
        self.run_cli('--agent', 'codex', '--role', 'implementer', 'start',
                     env=dict(self.env, SIDECAR_CODEX_MODEL='custom-codex', SIDECAR_THINKING='high'))
        start = next(c for c in self.calls() if c[:2] == ['agent', 'start'])
        self.assertEqual(start[start.index('--model') + 1], 'custom-codex')
        self.assertEqual(json.loads(self.codex_config(start)['model_reasoning_effort']), 'high')

    def test_codex_closed_pane_resumes_the_saved_session(self):
        self.run_cli('--agent', 'codex', 'start')
        session_file = self.home / '.cache/claude-sidecar/sc-pane-1.codex-session'
        session = session_file.read_text().strip()
        start = next(c for c in self.calls() if c[:2] == ['agent', 'start'])
        pane = start[start.index('--pane') + 1]
        (self.home / 'agent.json').unlink()
        panes_file = self.home / 'panes.json'
        panes = json.loads(panes_file.read_text())
        panes_file.write_text(json.dumps([p for p in panes if p['pane_id'] != pane]))
        self.run_cli('ask', 'Continue after closing the pane')
        starts = [c for c in self.calls() if c[:2] == ['agent', 'start']]
        self.assertEqual(len(starts), 2)
        self.assertEqual(starts[-1][starts[-1].index('resume') + 1], session)
        self.assertNotIn('--last', starts[-1])
        self.assertEqual(session_file.read_text().strip(), session)
        self.assertEqual(json.loads((self.home / 'agent.json').read_text())['agent_session']['value'], session)

    def test_codex_replaces_foreign_kind_or_session_without_losing_its_session(self):
        self.run_cli('--agent', 'codex', 'start')
        session_file = self.home / '.cache/claude-sidecar/sc-pane-1.codex-session'
        session = session_file.read_text().strip()
        for kind, value in (('pi', session), ('codex', 'ffffffff-ffff-4fff-afff-ffffffffffff')):
            with self.subTest(kind=kind):
                state_file = self.home / 'agent.json'
                state = json.loads(state_file.read_text())
                state.update(agent=kind, agent_session={'value': value})
                state_file.write_text(json.dumps(state))
                result = self.run_cli('start')
                self.assertNotIn('already running', result.stdout)
                start = [c for c in self.calls() if c[:2] == ['agent', 'start']][-1]
                self.assertEqual(start[start.index('resume') + 1], session)
                self.assertEqual(session_file.read_text().strip(), session)
        self.assertEqual(sum(c[:2] == ['agent', 'rename'] for c in self.calls()), 2)

    def test_codex_waits_for_a_delayed_session_identity(self):
        result = self.run_cli('--agent', 'codex', 'ask', 'Task',
                              env=dict(self.env, FAKE_DELAYED_SESSION='1'))
        self.assertIn('ship', result.stdout)
        self.assertEqual(len([c for c in self.calls() if c[:2] == ['agent', 'start']]), 1)
        self.assertFalse(any(c[:2] == ['agent', 'rename'] for c in self.calls()))

    def test_codex_foreign_session_waits_for_restart_bootstrap_before_the_request(self):
        self.run_cli('--agent', 'codex', 'start')
        state_file = self.home / 'agent.json'
        state = json.loads(state_file.read_text())
        state['agent_session']['value'] = 'ffffffff-ffff-4fff-afff-ffffffffffff'
        state_file.write_text(json.dumps(state))
        previous = len(self.calls())
        result = self.run_cli('ask', 'Continue after restore',
                              env=dict(self.env, FAKE_CODEX_BOOTSTRAP_DELAY='0.5'))
        self.assertIn('ship', result.stdout)
        calls = self.calls()[previous:]
        renamed = next(index for index, call in enumerate(calls) if call[:2] == ['agent', 'rename'])
        waited = next(index for index, call in enumerate(calls) if call[:2] == ['agent', 'wait'])
        requested = next(index for index, call in enumerate(calls)
                         if call[:2] == ['agent', 'prompt'] and call[3].startswith('[request '))
        self.assertLess(renamed, waited)
        self.assertLess(waited, requested)

    def test_codex_request_writes_a_report_and_answers_a_question(self):
        result = self.run_cli('--agent', 'codex', 'ask', 'Look at x',
                              env=dict(self.env, FAKE_QUESTION='Which option?'), check=False)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn('NEEDS_ANSWER: Which option?', result.stdout)
        report = self.report_path(result.stdout)
        self.assertIn('ship', report.read_text())
        prompts = [c[3] for c in self.calls() if c[:2] == ['agent', 'prompt']]
        self.assertEqual(len(prompts), 2)
        self.assertTrue(prompts[0].startswith('[note] Initialize this sidecar'))
        self.assertTrue(prompts[1].startswith('[request '))
        prompt = prompts[1]
        self.assertIn(str(report), prompt)
        self.assertIn(str(report.with_suffix('.needs-answer')), prompt)
        self.assertNotIn('submit_review', prompt)
        self.assertNotIn('Write tool', prompt)
        answered = self.run_cli('answer', 'Use option A')
        self.assertIn('ship', answered.stdout)
        answer = next((self.home / '.cache/claude-sidecar/requests').glob('*-answer-*.md')).read_text()
        self.assertIn('Use option A', answer)
        self.assertEqual(len([c for c in self.calls() if c[:2] == ['agent', 'start']]), 1)
        self.assertEqual(sum(c[:2] == ['agent', 'prompt'] and c[3].startswith('[note]')
                             for c in self.calls()), 1)
        self.assertFalse((self.home / '.cache/claude-sidecar/sc-pane-1.pending').exists())

    def test_codex_settled_without_report_exits_two(self):
        result = self.run_cli('--agent', 'codex', 'ask', 'Task',
                              env=dict(self.env, FAKE_NO_REPORT='1', SIDECAR_SETTLE_GRACE_S='0'), check=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn('no report submitted', result.stderr)

    def test_codex_slot_rejects_backend_switch_and_reload(self):
        self.run_cli('--agent', 'codex', 'start')
        prompts = [c for c in self.calls() if c[:2] == ['agent', 'prompt']]
        switched = self.run_cli('--agent', 'pi', 'start', check=False)
        self.assertEqual(switched.returncode, 1)
        self.assertIn('use a new slot', switched.stderr)
        reloaded = self.run_cli('reload', check=False)
        self.assertEqual(reloaded.returncode, 1)
        self.assertIn('pi sidecars only', reloaded.stderr)
        self.assertEqual([c for c in self.calls() if c[:2] == ['agent', 'prompt']], prompts)

    def test_codex_idle_steer_reports_and_busy_steer_refuses(self):
        self.run_cli('--agent', 'codex', 'start')
        idle = self.run_cli('steer', 'Review x')
        self.assertIn('ship', idle.stdout)
        prompts = [c for c in self.calls() if c[:2] == ['agent', 'prompt']]
        busy = self.run_cli('steer', 'Change direction', env=dict(self.env, FAKE_AGENT_WORKING='1'), check=False)
        self.assertEqual(busy.returncode, 1)
        self.assertIn('busy codex sidecar cannot be steered', busy.stderr)
        self.assertEqual([c for c in self.calls() if c[:2] == ['agent', 'prompt']], prompts)
        self.assertFalse((self.home / '.local/state/grok-style-pi/steer').exists())

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
        state_dir.mkdir(parents=True, exist_ok=True)
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
        # Do not fall through to a real pi installed beside Node on the developer's PATH.
        env = dict(self.env, PATH=self.path_without_agents())
        result = self.run_cli('session-start', input='{}', env=env)
        self.assertIn('pi, claude or codex', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_hook_accepts_codex_without_pi(self):
        (self.home / 'bin/pi').unlink()
        codex = self.home / 'bin/codex'
        codex.write_text('#!/bin/sh\nexit 0\n')
        codex.chmod(0o755)
        env = dict(self.env, PATH=self.path_without_agents())
        result = self.run_cli('session-start', input='{"session_id":"codex-only"}', env=env)
        self.assertIn('claude-sidecar:sidecar-review', json.loads(result.stdout)['hookSpecificOutput']['additionalContext'])
        self.assertEqual(result.stderr, '')

    def test_hook_reuses_live_session(self):
        self.run_cli('start')
        env_file = self.home / 'claude.env'
        result = self.run_cli('session-start', input='{"session_id":"new-session"}',
                              env=dict(self.env, CLAUDE_ENV_FILE=str(env_file)))
        output = json.loads(result.stdout)
        self.assertIn('claude-sidecar:sidecar-review', output['hookSpecificOutput']['additionalContext'])
        self.assertIn('SIDECAR_PI_SESSION=cc-pane-pane-1', env_file.read_text())
        self.assertEqual(sum(c[:2] == ['agent', 'start'] for c in self.calls()), 1)

    def report_path(self, output):
        first = output.splitlines()[0]
        self.assertTrue(first.startswith('# Sidecar report ('), first)
        return Path(first[len('# Sidecar report ('):-1])

    def test_report_path_prints_before_the_request_completes(self):
        self.run_cli('start')
        process = subprocess.Popen([str(self.launcher), 'ask', 'Long task'], text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=dict(self.env, HERDR_PROMPT_DELAY='2'))
        try:
            import select
            self.assertTrue(select.select([process.stdout], [], [], 5)[0])
            path = self.report_path(process.stdout.readline())
            self.assertIsNone(process.poll())
            self.assertFalse(path.exists())
            stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertIn('ship', stdout)
            self.assertEqual(path.read_text(), '## Verdict\nship\n')
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_report_recovers_full_output_after_head_closes_the_pipe(self):
        process = subprocess.Popen([str(self.launcher), '--slot', '2', 'ask', 'Long report'], text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=dict(self.env, FAKE_REPORT_LINES='20000'))
        try:
            path = self.report_path(process.stdout.readline())
            # Like piping through `head -n 1`: no reader remains for the full report.
            process.stdout.close()
            process.wait(timeout=10)
            self.assertNotEqual(process.returncode, 0)
            self.assertIn('last report unprinted:', self.run_cli('--slot', '2', 'status').stdout)
            result = self.run_cli('--slot', '2', 'report')
            self.assertEqual(result.stdout.split('\n', 1)[1], path.read_text())
            self.assertEqual(path.read_text().count('report detail'), 20000)
            self.assertIn('last report printed:', self.run_cli('--slot', '2', 'status').stdout)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stderr.close()

    def test_report_recovers_legacy_reports_without_metadata_and_keeps_slot_isolation(self):
        reports = self.home / '.cache/claude-sidecar/reports'
        reports.mkdir(parents=True)
        first = reports / '20260101-010000-ask-sc-pane-1.old.md'
        latest = reports / '20260101-020000-diff-sc-pane-1.new.md'
        other = reports / '20260101-030000-ask-sc-pane-1-2.other.md'
        for timestamp, path in enumerate((first, latest, other), start=1):
            path.write_text(path.stem + '\n')
            os.utime(path, (timestamp, timestamp))
        self.assertIn('last report unprinted: ' + str(latest), self.run_cli('status').stdout)
        self.assertEqual(self.report_path(self.run_cli('report').stdout), latest)
        self.assertEqual(self.report_path(self.run_cli('--slot', '2', 'report').stdout), other)
        self.assertIn('last report printed:', self.run_cli('status').stdout)

    def test_report_and_wait_without_a_request_are_actionable(self):
        for command in ('report', 'wait'):
            result = self.run_cli(command, check=False)
            self.assertEqual(result.returncode, 1)
            self.assertIn('slot 1', result.stderr)

    def test_wait_blocks_until_report_is_saved_and_does_not_print_it(self):
        self.run_cli('start')
        with ThreadPoolExecutor(2) as pool:
            request = pool.submit(self.run_cli, 'ask', 'Long task',
                                  env=dict(self.env, HERDR_PROMPT_DELAY='2'))
            deadline = time.monotonic() + 5
            while not any(c[:2] == ['agent', 'prompt'] for c in self.calls()):
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.01)
            waiting = pool.submit(self.run_cli, 'wait')
            time.sleep(0.2)
            self.assertFalse(waiting.done())
            result = waiting.result(timeout=10)
            path = self.report_path(result.stdout)
            self.assertTrue(path.is_file())
            self.assertNotIn('## Verdict', result.stdout)
            self.assertEqual(path, self.report_path(request.result().stdout))

    def test_wait_preserves_question_exit_and_report_replays_question(self):
        self.run_cli('ask', 'Task', env=dict(self.env, FAKE_QUESTION='Which?'), check=False)
        result = self.run_cli('wait', check=False)
        self.assertEqual(result.returncode, 3)
        self.assertTrue(self.report_path(result.stdout).is_file())
        self.assertIn('NEEDS_ANSWER: Which?', self.run_cli('report').stdout)

    def test_wait_does_not_mistake_an_older_report_for_failed_request(self):
        previous = self.report_path(self.run_cli('ask', 'First task').stdout)
        failed = self.run_cli('ask', 'Failed task', check=False,
                              env=dict(self.env, FAKE_NO_REPORT='1', SIDECAR_SETTLE_GRACE_S='0'))
        self.assertEqual(failed.returncode, 2)
        self.assertEqual(self.run_cli('wait', check=False).returncode, 1)
        self.assertEqual(self.report_path(self.run_cli('report').stdout), previous)
        self.assertIn('exit 2', self.run_cli('status').stdout)

    def test_status_reports_request_age_and_printed_state_per_slot(self):
        result = self.run_cli('ask', 'Task')
        path = self.report_path(result.stdout)
        state_path = self.home / '.cache/claude-sidecar/sc-pane-1.request.json'
        state = json.loads(state_path.read_text())
        state.update(started=int(time.time()) - 6 * 3600, finished=int(time.time()) - 5 * 3600)
        state_path.write_text(json.dumps(state))
        status = self.run_cli('status').stdout
        self.assertIn('done 5h ago', status)
        self.assertIn('started 6h ago', status)
        self.assertIn('last report printed: ' + str(path), status)
        self.assertNotIn('last report', self.run_cli('--slot', '2', 'status').stdout)

    def test_status_shows_start_age_while_request_runs(self):
        self.run_cli('start')
        with ThreadPoolExecutor(1) as pool:
            request = pool.submit(self.run_cli, 'ask', 'Task', env=dict(self.env, HERDR_PROMPT_DELAY='2'))
            deadline = time.monotonic() + 5
            while not any(c[:2] == ['agent', 'prompt'] for c in self.calls()):
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.01)
            self.assertIn('request: started', self.run_cli('status').stdout)
            request.result()

    def test_requests_use_unique_reports(self):
        for _ in range(2):
            self.assertIn('ship', self.run_cli('ask', 'Review the design').stdout)
        reports = list((self.home / '.cache/claude-sidecar/reports').glob('*.md'))
        self.assertEqual(len(reports), 2)

    def test_question_exit_code_and_answer_resume(self):
        env = dict(self.env, FAKE_QUESTION='May I add X?')
        result = self.run_cli('ask', 'Do the work', env=env, check=False)
        self.assertEqual(result.returncode, 3)
        self.assertIn('NEEDS_ANSWER: May I add X?', result.stdout.splitlines()[1])
        answered = self.run_cli('answer', 'Yes, with constraint Y')
        self.assertIn('ship', answered.stdout)
        request_files = sorted((self.home / '.cache/claude-sidecar/requests').glob('*-answer-*.md'))
        self.assertIn('Yes, with constraint Y', request_files[0].read_text())
        self.assertFalse(self.run_cli('answer', 'again', check=False).returncode == 0)

    def test_answer_without_pending_question(self):
        result = self.run_cli('answer', 'hello', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no pending question', result.stderr)
        self.assertIn('sidecar --slot 1 ask TEXT', result.stderr)

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

    def test_untracked_diff_keeps_renames_literal_names_and_survives_bad_entries(self):
        repo, git = self.repo_with_change()
        git('mv', 'a.txt', 'moved.txt')
        git('reset', '-q', '--', 'moved.txt')
        (repo / ':(exclude)nothing').write_text('magic name\n')
        self.run_cli('diff', cwd=repo)
        diff = sorted((self.home / '.cache/claude-sidecar/requests').glob('*.diff'))[-1].read_text()
        self.assertIn('+two', diff.split('# Untracked files')[1], 'a moved file stays an addition')
        self.assertIn('+magic name', diff)
        nested = repo / 'nested'
        nested.mkdir()
        subprocess.run(['git', 'init', '-q', str(nested)], check=True)
        (repo / 'ordinary.txt').write_text('ordinary content\n')
        for old in (self.home / '.cache/claude-sidecar/requests').glob('*.diff'):
            old.unlink()
        self.run_cli('diff', cwd=repo, check=False)
        diff = next((self.home / '.cache/claude-sidecar/requests').glob('*.diff')).read_text()
        self.assertIn('+ordinary content', diff)

    def test_diff_rejects_ranges_with_single_base_guidance(self):
        repo, _ = self.repo_with_change()
        for base in ('HEAD..HEAD', 'HEAD...HEAD'):
            result = self.run_cli('diff', base, cwd=repo, check=False)
            self.assertEqual(result.returncode, 1)
            self.assertIn('single base ref, not a range', result.stderr)
            self.assertIn('diff HEAD CONTEXT', result.stderr)
        self.assertFalse(any(c[:2] == ['agent', 'prompt'] for c in self.calls()))

    def test_diff_prints_a_recoverable_report_path_first(self):
        repo, _ = self.repo_with_change()
        result = self.run_cli('diff', cwd=repo)
        path = self.report_path(result.stdout)
        self.assertEqual(path.read_text(), '## Verdict\nship\n')
        self.assertEqual(self.run_cli('report').stdout, result.stdout)

    def test_diff_request_requires_reproduced_findings(self):
        repo, _ = self.repo_with_change()
        self.run_cli('diff', cwd=repo)
        request = next((self.home / '.cache/claude-sidecar/requests').glob('*-diff-*.md')).read_text()
        self.assertIn('Reproduce each finding before you report it', request)
        self.assertIn('unverified', request)

    def request_text(self, kind):
        return sorted((self.home / '.cache/claude-sidecar/requests').glob(f'*-{kind}-*.md'))[-1].read_text()

    def fake_reports(self, mapping):
        path = self.home / 'fake-reports.json'
        path.write_text(json.dumps(mapping))
        return dict(self.env, FAKE_REPORTS=str(path))

    def test_diff_against_a_moved_base_reviews_since_the_merge_base(self):
        repo, git = self.repo_with_change()
        git('commit', '-am', 'Work')
        git('branch', 'work')
        git('checkout', '-q', 'HEAD~1')
        (repo / 'upstream.txt').write_text('new upstream code\n')
        git('add', '.')
        git('commit', '-m', 'Upstream moved')
        git('branch', 'upstream')
        git('checkout', '-q', 'work')
        result = self.run_cli('diff', 'upstream', cwd=repo)
        self.assertIn('not an ancestor of HEAD', result.stderr)
        diff = next((self.home / '.cache/claude-sidecar/requests').glob('*.diff')).read_text()
        self.assertNotIn('upstream code', diff)
        self.assertIn('+two', diff)
        self.assertIn('upstream (merge-base', self.request_text('diff'))

    def test_diff_and_plan_requests_ask_for_origin_and_measurements(self):
        repo, _ = self.repo_with_change()
        self.run_cli('diff', cwd=repo)
        request = self.request_text('diff')
        self.assertIn('`pre-existing`', request)
        self.assertIn('git show', request)
        plan = repo / 'plan.md'
        plan.write_text('# Plan\n')
        self.run_cli('plan', str(plan), cwd=repo)
        self.assertIn('cites no measurement', self.request_text('plan'))

    def test_implementer_ask_carries_the_contract_and_launcher_checks(self):
        repo, git = self.repo_with_change()
        (repo / 'src').mkdir()
        env = dict(self.env, FAKE_TOUCH='src/in.txt:outside.txt')
        result = self.run_cli('--slot', '2', '--role', 'implementer', 'ask', '--accept', 'echo accepted-output; exit 3',
                              '--accept', 'true', '--scope', 'src/*', 'Implement it', cwd=repo, env=env)
        request = self.request_text('ask')
        self.assertIn('Completion contract', request)
        self.assertIn('the launcher runs `echo accepted-output; exit 3` itself', request)
        self.assertIn('`src/*`', request)
        self.assertIn('**Outside the stated scope:** outside.txt', result.stdout)
        self.assertNotIn('a.txt', result.stdout.split('## Verdict')[0], 'files dirty before the task are not flagged')
        self.assertIn('FAIL, exit 3', result.stdout)
        self.assertIn('accepted-output', result.stdout)
        self.assertIn('`true`: **PASS**', result.stdout)
        saved = self.report_path(result.stdout).read_text()
        self.assertTrue(saved.startswith('## Launcher checks'))
        self.assertIn('## Verdict', saved)
        # Checks persist for follow-ups until cleared.
        again = self.run_cli('--slot', '2', 'ask', 'Fix the failure', cwd=repo, env=env)
        self.assertIn('Launcher checks', again.stdout)
        cleared = self.run_cli('--slot', '2', 'ask', '--no-checks', 'Something else', cwd=repo, env=env)
        self.assertNotIn('Launcher checks', cleared.stdout)

    def test_scope_sees_reverted_dirty_files_and_real_names(self):
        repo, git = self.repo_with_change()
        (repo / 'my dir').mkdir()
        # a.txt is dirty before the task; the "sidecar" overwrites it and writes a file in scope with a space in its path.
        env = dict(self.env, FAKE_TOUCH='a.txt:my dir/new.txt')
        result = self.run_cli('--slot', '2', '--role', 'implementer', 'ask', '--scope', 'my dir/*', 'Task', cwd=repo, env=env)
        self.assertIn('**Outside the stated scope:** a.txt', result.stdout)
        self.assertNotIn('new.txt', result.stdout.split('## Verdict')[0])

    def test_multiline_acceptance_runs_as_one_command(self):
        repo, _ = self.repo_with_change()
        (repo / 'sub').mkdir()
        (repo / 'sub/expected').write_text('x')
        result = self.run_cli('--slot', '2', '--role', 'implementer', 'ask', '--accept', 'cd sub\ntest -f expected', 'Task', cwd=repo)
        self.assertEqual(result.stdout.count('Acceptance `'), 1, result.stdout)
        self.assertIn('**PASS**', result.stdout)

    def test_a_queued_ask_does_not_replace_the_running_asks_checks(self):
        repo, _ = self.repo_with_change()
        self.run_cli('--slot', '2', '--role', 'implementer', 'start', cwd=repo)
        first = subprocess.Popen([str(self.launcher), '--slot', '2', 'ask', '--accept', 'echo FIRST_CHECK', 'First'], cwd=repo, text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=dict(self.env, HERDR_PROMPT_DELAY='1'))
        deadline = time.monotonic() + 5
        while not any(c[:2] == ['agent', 'prompt'] for c in self.calls()):
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.02)
        second = self.run_cli('--slot', '2', 'ask', '--no-checks', 'Second', cwd=repo)
        stdout, _ = first.communicate(timeout=20)
        self.assertIn('FIRST_CHECK', stdout)
        self.assertNotIn('Launcher checks', second.stdout)

    def test_quoted_verdicts_do_not_withdraw_a_standing_finding(self):
        env = self.fake_reports({'reject:sc-pane-1': 'R1: stands\nThe requested `R1: withdrawn` is unjustified.\n```\nR1: withdrawn\n```\n'})
        self.run_cli('reject', '#1: reason', env=env)
        ledger = json.loads((self.home / '.cache/claude-sidecar/sc-pane-1.rejections.jsonl').read_text())
        self.assertEqual(ledger['status'], 'stands')

    def test_acceptance_children_do_not_hold_the_slot(self):
        repo, _ = self.repo_with_change()
        pid = self.home / 'child.pid'
        self.run_cli('--slot', '2', '--role', 'implementer', 'ask', '--accept', f'sleep 30 >/dev/null 2>&1 & echo $! >"{pid}"', 'Task', cwd=repo)
        result = self.run_cli('--slot', '2', 'ask', 'Next', cwd=repo, env=dict(self.env, SIDECAR_NO_QUEUE='1'), check=False)
        os.kill(int(pid.read_text()), signal.SIGTERM)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_identical_checked_asks_are_not_queued_twice(self):
        repo, _ = self.repo_with_change()
        self.run_cli('--slot', '2', '--role', 'implementer', 'start', cwd=repo)
        args = [str(self.launcher), '--slot', '2', 'ask', '--accept', 'true', 'Task']
        first = subprocess.Popen(args, cwd=repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env=dict(self.env, HERDR_PROMPT_DELAY='1'))
        deadline = time.monotonic() + 5
        while not any(c[:2] == ['agent', 'prompt'] for c in self.calls()):
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.02)
        duplicate = subprocess.run(args, cwd=repo, text=True, capture_output=True, env=self.env)
        first.communicate(timeout=20)
        self.assertEqual(duplicate.returncode, 4, duplicate.stderr)

    def test_concurrent_rejections_get_distinct_ids(self):
        with ThreadPoolExecutor(6) as pool:
            list(pool.map(lambda n: self.run_cli('reject', f'#{n}: reason'), range(6)))
        ledger = [json.loads(line) for line in (self.home / '.cache/claude-sidecar/sc-pane-1.rejections.jsonl').read_text().splitlines()]
        self.assertEqual(sorted(r['id'] for r in ledger), sorted(f'R{n}' for n in range(1, 7)))

    def test_reviewer_ask_has_no_implementer_contract(self):
        self.run_cli('ask', 'Look at this')
        self.assertNotIn('Completion contract', self.request_text('ask'))

    def test_rejections_are_held_rechecked_and_overruled(self):
        repo, _ = self.repo_with_change()
        env = self.fake_reports({'reject:sc-pane-1': 'R1: stands\nRepro: `./x` crashes\n'})
        result = self.run_cli('reject', 'Finding 2 (null deref): the pointer is never null here', cwd=repo, env=env)
        self.assertIn('reviewer holds R1', result.stderr)
        self.assertIn('Concede only to evidence', self.request_text('reject'))
        self.run_cli('diff', cwd=repo)
        self.assertIn('R1 (stands): Finding 2 (null deref)', self.request_text('diff'))
        self.run_cli('reject', '--overrule', 'R1', 'User decided', cwd=repo)
        time.sleep(1.1)
        self.run_cli('diff', cwd=repo)
        self.assertNotIn('Findings Claude rejected earlier', self.request_text('diff'))
        env = self.fake_reports({'reject:sc-pane-1': 'R2: withdrawn, the guard on line 4 covers it\n'})
        self.run_cli('reject', 'Finding 3: guarded', cwd=repo, env=env)
        ledger = [json.loads(line) for line in (self.home / '.cache/claude-sidecar/sc-pane-1.rejections.jsonl').read_text().splitlines()]
        self.assertEqual([(r['id'], r['status']) for r in ledger], [('R1', 'overruled'), ('R2', 'withdrawn')])

    def gate(self, command, cwd):
        payload = json.dumps({'tool_name': 'Bash', 'tool_input': {'command': command}, 'cwd': str(cwd)})
        return self.run_cli('push-gate', input=payload)

    def test_push_gate_wrapper_starts_the_launcher_only_for_possible_publishes(self):
        repo, _ = self.repo_with_change()
        self.run_cli('diff', cwd=repo)
        (repo / 'late.txt').write_text('unreviewed\n')
        wrapper = self.plugin / 'scripts/push-gate'
        def hook(command, env=None):
            payload = json.dumps({'tool_name': 'Bash', 'tool_input': {'command': command}, 'cwd': str(repo)})
            return subprocess.run([str(wrapper)], input=payload, text=True, capture_output=True, env=env or self.env, check=True)
        self.assertIn('"deny"', hook('git -C "$PWD" push').stdout)
        self.assertEqual(hook('ls && pushd x').stdout, '')
        outside = dict(self.env)
        outside.pop('HERDR_ENV')
        self.assertEqual(hook('git push', outside).stdout, '')

    def test_push_gate_denies_pushes_with_unreviewed_changes(self):
        repo, git = self.repo_with_change()
        self.assertEqual(self.gate('git push origin HEAD', repo).stdout, '', 'no review recorded: no gate')
        self.run_cli('--slot', '3', 'diff', cwd=repo)
        self.assertEqual(self.gate('git push', repo).stdout, '')
        (repo / 'late.txt').write_text('unreviewed\n')
        for command in ('git push', f'git -C {repo} push -u origin b', f'cd "{repo}" && git push', 'git -c push.autoSetupRemote=true push',
                        'git --no-pager push', 'gh pr create --fill', 'glab mr create', 'SIDECAR_REVIEW_SKIP=x git status; git push',
                        f'(cd "{self.home}" && pwd); git push', 'cd -- . && git push', 'cd "$PWD" && git push', 'git \\\n push',
                        'cd /nonexistent; git push'):
            denied = json.loads(self.gate(command, repo.parent if repo.name in command else repo).stdout)['hookSpecificOutput']
            self.assertEqual(denied['permissionDecision'], 'deny', command)
            self.assertIn('late.txt', denied['permissionDecisionReason'])
        for command in ('git status', 'git log --grep push', 'SIDECAR_REVIEW_SKIP=tickets git push', 'echo "Use git push after review"',
                        f'git -C {self.home} push', f'(cd "{self.home}" && git push)'):
            self.assertEqual(self.gate(command, repo).stdout, '', command)
        outside = dict(self.env)
        outside.pop('HERDR_ENV')
        payload = json.dumps({'tool_input': {'command': 'git push'}, 'cwd': str(repo)})
        self.assertEqual(self.run_cli('push-gate', input=payload, env=outside).stdout, '')

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
        for machine in machines:
            runtime = self.remote_home(machine['target']) / self.plugin.relative_to(self.home) / 'sidecar'
            shutil.copytree(self.plugin / 'sidecar', runtime, dirs_exist_ok=True)

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

    def test_remote_report_is_cached_and_recoverable_when_ssh_is_down(self):
        self.add_machines()
        for slot, transport in (('2', 'sh'), ('3', 'node')):
            with self.subTest(transport=transport):
                config = self.home / 'sidecar-machines.json'
                config.write_text(json.dumps({'laptop': {'transport': transport}}))
                env = dict(self.remote_env, SIDECAR_MACHINES_FILE=str(config), FAKE_QUESTION='Remote choice?')
                result = self.remote_run('--slot', slot, '--machine', 'laptop', 'ask', 'Task', env=env, check=False)
                self.assertEqual(result.returncode, 3, result.stderr)
                path = self.report_path(result.stdout)
                self.assertEqual(path.parent, self.home / '.cache/claude-sidecar/reports')
                self.assertEqual(path.read_text(), '## Verdict\nship\n')
                offline = dict(env, FAKE_SSH_DOWN='1')
                replay = self.remote_run('--slot', slot, 'report', env=offline)
                self.assertIn('NEEDS_ANSWER: Remote choice?', replay.stdout)
                self.assertIn('ship', replay.stdout)
                self.assertEqual(self.remote_run('--slot', slot, 'wait', env=offline, check=False).returncode, 3)

    def test_remote_report_and_question_survive_a_closed_stdout_pipe(self):
        self.add_machines()
        env = dict(self.remote_env, FAKE_QUESTION='Remote choice?', FAKE_REPORT_LINES='20000')
        process = subprocess.Popen([str(self.launcher), '--machine', 'laptop', 'ask', 'Task'], text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=self.work)
        try:
            path = self.report_path(process.stdout.readline())
            process.stdout.close()
            process.wait(timeout=15)
            self.assertNotEqual(process.returncode, 0)
            self.assertEqual(path.read_text().count('report detail'), 20000)
            offline = dict(env, FAKE_SSH_DOWN='1')
            replay = self.remote_run('report', env=offline)
            self.assertIn('NEEDS_ANSWER: Remote choice?', replay.stdout)
            self.assertEqual(replay.stdout.count('report detail'), 20000)
            self.assertTrue((self.home / '.cache/claude-sidecar/sc-pane-1.pending').is_file())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stderr.close()

    def test_bound_remote_cwd_error_explains_using_a_free_slot(self):
        self.add_machines()
        self.remote_run('--slot', '2', '--machine', 'laptop', 'start')
        result = self.remote_run('--slot', '2', '--remote-cwd', '/another/checkout', 'ask', 'Task', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('slots cannot be rebound', result.stderr)
        self.assertIn('Pick a free slot: sidecar --slot N --machine laptop', result.stderr)

    def test_node_transport_deploys_and_maps_checkout(self):
        self.add_machines()
        checkout = self.home / "remote checkout 'quoted'"
        checkout.mkdir()
        config = self.home / 'sidecar-machines.json'
        config.write_text(json.dumps({'laptop': {'transport': 'node', 'paths': {str(self.work): str(checkout)}}}))
        env = dict(self.remote_env, SIDECAR_MACHINES_FILE=str(config))
        runtime = self.remote_home() / self.plugin.relative_to(self.home) / 'sidecar'
        shutil.rmtree(runtime)
        result = self.remote_run('--machine', 'laptop', 'ask', 'Task', env=env)
        self.assertIn('ship', result.stdout)
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

    def test_remote_codex_reads_its_prompt_and_writes_its_report_on_the_machine(self):
        self.add_machines()
        for slot, transport in (('2', 'sh'), ('3', 'node')):
            with self.subTest(transport=transport):
                config = self.home / 'sidecar-machines.json'
                config.write_text(json.dumps({'laptop': {'transport': transport}}))
                env = dict(self.remote_env, SIDECAR_MACHINES_FILE=str(config))
                result = self.remote_run('--slot', slot, '--agent', 'codex', '--role', 'implementer',
                                         '--machine', 'laptop', 'ask', 'Task', env=env)
                self.assertIn('ship', result.stdout)
                self.assertIn('# Sidecar report (laptop:' + str(self.remote_home()), result.stdout)
                self.assertEqual(self.local_calls(), [])
                name = 'sc-tt01-pane-1-' + slot
                calls = [c for c in self.remote_calls() if c[0] == 'agent' and c[2] == name]
                start = next(c for c in calls if c[:2] == ['agent', 'start'])
                self.assertEqual(start[start.index('--kind') + 1], 'codex')
                self.assertEqual(start[start.index('--add-dir') + 1],
                                 str(self.remote_home() / '.cache/claude-sidecar'))
                prompt = Path(json.loads(self.codex_config(start)['model_instructions_file']))
                self.assertTrue(prompt.is_relative_to(self.remote_home()))
                self.assertIn('Codex', prompt.read_text())
                request = next(c for c in calls if c[:2] == ['agent', 'prompt'] and c[3].startswith('[request '))[3]
                self.assertIn(str(self.remote_home() / '.cache/claude-sidecar/reports'), request)
                self.assertNotIn('submit_review', request)
                self.assertNotIn('Write tool', request)
                self.assertIn('ship', self.report_path(result.stdout).read_text())
                saved = self.home / ('.cache/claude-sidecar/sc-pane-1-' + slot + '.codex-session')
                remote = self.home / ('remote-state/m1/' + name + '.agent.json')
                self.assertEqual(saved.read_text().strip(), json.loads(remote.read_text())['agent_session']['value'])

    def test_remote_codex_prompt_copy_failure_starts_nothing(self):
        self.add_machines()
        ssh = self.home / 'bin/ssh'
        original = ssh.read_text()
        ssh.write_text(original.replace("if os.environ.get('FAKE_SSH_DOWN'):",
                                        "if os.environ.get('FAKE_SSH_DOWN') or 'codex-prompt' in command:", 1))
        result = self.remote_run('--agent', 'codex', '--machine', 'laptop', 'start', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('could not copy the Codex prompt to laptop', result.stderr)
        self.assertFalse([c for c in self.remote_calls() if c[:2] == ['agent', 'start']])
        self.assertFalse(list((self.home / '.cache/claude-sidecar').glob('*.codex-session')))

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
        runtime = self.remote_home() / self.plugin.relative_to(self.home) / 'sidecar'
        self.assertEqual(start[start.index('-e') + 1], str(runtime / 'sidecar.ts'))
        self.assertEqual(start[start.index('--append-system-prompt') + 1], str(runtime / 'reviewer.md'))
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

    def test_windows_plugin_default_is_rooted_at_c_drive(self):
        self.add_machines()
        config = self.home / 'sidecar-machines.json'
        config.write_text(json.dumps({'laptop': {'transport': 'node'}}))
        self.addCleanup(self.stop_runtimes)
        self.remote_run('--machine', 'laptop', 'start', env=dict(
            self.remote_env, SIDECAR_MACHINES_FILE=str(config), FAKE_REMOTE_WINDOWS='1',
            FAKE_WINDOWS_CONTROL='1', SIDECAR_STARTUP_TIMEOUT_S='10'))
        runtime = 'C:/' + str(self.plugin.relative_to(self.home)) + '/sidecar'
        start = self.all_starts()[0]
        self.assertEqual(start[start.index('-e') + 1], runtime + '/sidecar.ts')
        self.assertEqual(start[start.index('--append-system-prompt') + 1], runtime + '/reviewer.md')
        self.assertTrue((self.remote_home() / runtime / 'sidecar.ts').is_file())

    def test_remote_plugin_default_uses_remote_home(self):
        self.add_machines()
        runtime = self.remote_home() / self.plugin.relative_to(self.home) / 'sidecar'
        self.remote_run('--machine', 'laptop', 'start')
        start = self.all_starts()[0]
        self.assertEqual(start[start.index('-e') + 1], str(runtime / 'sidecar.ts'))
        self.assertEqual(start[start.index('--append-system-prompt') + 1], str(runtime / 'reviewer.md'))

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
        self.assertIn('bound to cwd %s on that machine' % checkout, result.stderr)
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
        date.write_text('#!/bin/sh\ncase "$1" in +%Y%m%d-%H%M%S) echo 20260101-000000;; *) exec '
                        + shlex.quote(shutil.which('date')) + ' "$@";; esac\n')
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
        self.assertIn('NEEDS_ANSWER: May I?', result.stdout)
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


    PI, CL = 'sc-pane-1-98', 'sc-pane-1-99'

    def coop(self, *args, reports=None, env=None, check=True):
        repo, _ = self.repo_with_change()
        extra = dict(env or {})
        if reports is not None:
            (self.home / 'fake-reports.json').write_text(json.dumps(reports))
            extra['FAKE_REPORTS'] = str(self.home / 'fake-reports.json')
        return self.run_cli('coop-review', *args, cwd=repo, env=dict(self.env, **extra), check=check)

    def coop_report(self, reports, **kwargs):
        reports = {'diff:' + self.PI: '## Findings\nNone.\n', 'diff:' + self.CL: '## Findings\nNone.\n',
                   'ask:' + self.PI: 'Nothing.\n', 'ask:' + self.CL: 'Nothing.\n', **reports}
        result = self.coop(reports=reports, **kwargs)
        return self.report_path(result.stdout).read_text()

    def prompts(self):
        return [json.loads(line) for line in (self.home / 'prompts.jsonl').read_text().splitlines()]

    def requests(self, kind, name):
        # Creation order: requests in the same second share a timestamp, and their random suffixes do not sort.
        return sorted((self.home / '.cache/claude-sidecar/requests').glob(f'*-{kind}-{name}.*.md'), key=lambda path: path.stat().st_mtime_ns)

    @staticmethod
    def section(report, title):
        return re.search(rf'^## {title} \(\d+\)\n(.*?)(?=^## |\Z)', report, re.M | re.S).group(1)

    def test_coop_review_rejects_bad_arguments(self):
        for args, message in (
                (['--pi-slot', 'x'], '--pi-slot requires an integer'),
                (['--claude-slot', '0'], '--claude-slot requires an integer'),
                (['--bogus', '1'], 'unknown coop-review option'),
                (['--pi-slot', '2', '--claude-slot', '2'], 'must differ'),
                (['HEAD', 'ctx', 'extra'], 'usage: sidecar coop-review')):
            result = self.run_cli('coop-review', *args, check=False)
            self.assertEqual(result.returncode, 1, args)
            self.assertIn(message, result.stderr)
        for option in (['--slot', '3'], ['--agent', 'pi'], ['--role', 'implementer']):
            result = self.run_cli(*option, 'coop-review', check=False)
            self.assertEqual(result.returncode, 1, option)
            self.assertIn('chooses its own slots', result.stderr)
        self.assertEqual([c for c in self.calls() if c[:2] == ['agent', 'start']], [])

    def test_coop_review_uses_dedicated_slots_for_a_pi_and_a_claude_reviewer(self):
        result = self.coop('HEAD', 'Intent')
        self.assertTrue(self.report_path(result.stdout).name.endswith('.md'))
        starts = [c[c.index('--kind') + 1] for c in self.calls() if c[:2] == ['agent', 'start']]
        self.assertEqual(sorted(starts), ['claude', 'pi'])
        state = self.home / '.cache/claude-sidecar'
        self.assertEqual((state / f'{self.PI}.agent').read_text().strip(), 'pi')
        self.assertEqual((state / f'{self.CL}.agent').read_text().strip(), 'claude')
        self.assertEqual((state / f'{self.CL}.role').read_text().strip(), 'reviewer')
        self.assertFalse((state / 'sc-pane-1.agent').exists())

    def test_coop_review_slot_flags_choose_the_slots_and_rounds_reuse_them(self):
        first = self.coop('--pi-slot', '3', '--claude-slot', '4', 'HEAD', 'Round 1')
        state = self.home / '.cache/claude-sidecar'
        self.assertEqual((state / 'sc-pane-1-3.agent').read_text().strip(), 'pi')
        self.assertEqual((state / 'sc-pane-1-4.agent').read_text().strip(), 'claude')
        second = self.run_cli('coop-review', '--pi-slot', '3', '--claude-slot', '4', 'HEAD', 'Round 2',
                              cwd=self.home / 'repo')
        self.assertNotEqual(self.report_path(first.stdout), self.report_path(second.stdout))
        self.assertEqual(len([c for c in self.calls() if c[:2] == ['agent', 'start']]), 2)
        self.assertEqual(len(self.requests('diff', 'sc-pane-1-3')), 2)
        self.assertIn('Round 2', self.requests('diff', 'sc-pane-1-4')[1].read_text())

    def test_coop_review_slot_bound_to_the_other_agent_fails(self):
        self.run_cli('--slot', '98', '--agent', 'claude', 'start')
        result = self.coop(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('slot already runs claude', result.stderr)

    def test_coop_review_fails_fast_when_a_slot_is_busy(self):
        import fcntl
        state = self.home / '.cache/claude-sidecar'
        state.mkdir(parents=True, exist_ok=True)
        with (state / f'{self.CL}.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            started = time.monotonic()
            result = self.coop(check=False)
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(result.returncode, 1)
        self.assertIn('slot 99 is busy with another request', result.stderr)
        self.assertIn('--claude-slot', result.stderr)
        self.assertEqual([c for c in self.calls() if c[:2] == ['agent', 'prompt']], [])

    def test_coop_review_runs_both_reviewers_in_parallel(self):
        self.coop(env={'HERDR_PROMPT_DELAY': '1'})
        prompts = self.prompts()
        diffs = [p for p in prompts if p['kind'] == 'diff']
        asks = [p for p in prompts if p['kind'] == 'ask']
        self.assertEqual((len(diffs), len(asks)), (2, 2))
        # Each phase overlaps in time, and cross-verification starts only after both reports exist.
        self.assertLess(max(p['start'] for p in diffs), min(p['end'] for p in diffs))
        self.assertLess(max(p['start'] for p in asks), min(p['end'] for p in asks))
        self.assertLess(max(p['end'] for p in diffs), min(p['start'] for p in asks))

    def test_coop_review_sends_the_same_numbered_format_diff_request_to_both(self):
        self.coop('HEAD', 'Intent of the change')
        pi, claude = (re.sub(r'`[^`]*\.diff`', 'DIFF', self.requests('diff', name)[0].read_text())
                      for name in (self.PI, self.CL))
        self.assertEqual(pi, claude)
        self.assertIn('Intent of the change', pi)
        self.assertIn('Reproduce each finding', pi)
        self.assertIn('`### N. Title` heading', pi)

    def test_coop_review_cross_verification_carries_the_other_report_and_ids(self):
        self.coop(reports={'diff:' + self.PI: '## Findings\n### 1. Parser overflow\nPI detail\n### 2. Leak\nPI leak detail\n',
                           'diff:' + self.CL: '## Findings\n### 1. Init race\nCLAUDE detail\n'})
        to_pi = self.requests('ask', self.PI)[0].read_text()
        to_claude = self.requests('ask', self.CL)[0].read_text()
        self.assertIn('CLAUDE detail', to_pi)
        self.assertNotIn('PI detail', to_pi)
        self.assertIn('PI detail', to_claude)
        self.assertNotIn('CLAUDE detail', to_claude)
        self.assertIn('- C1: Init race', to_pi)
        self.assertIn('- P1: Parser overflow\n- P2: Leak', to_claude)
        self.assertIn('Your own findings\n\n- P1: Parser overflow', to_pi)
        for body, peer in ((to_pi, 'Claude Code (slot 99)'), (to_claude, 'pi (slot 98)')):
            self.assertIn(f"check {peer}'s findings", body)
            self.assertIn('Do not re-review the change from scratch', body)
            self.assertIn('### [CONFIRMED] <ID>', body)
            self.assertIn('### [REJECTED] <ID>', body)
            self.assertIn('[WITHDRAWN]', body)

    def test_ask_reads_its_text_from_stdin(self):
        self.run_cli('ask', '-', input='Long text from stdin\n')
        self.assertIn('Long text from stdin', self.requests('ask', 'sc-pane-1')[0].read_text())

    def test_coop_review_combines_verdicts_into_one_report(self):
        result_reports = {
            'diff:' + self.PI: '## Findings\n### 1. Parser overflow\nOverflow at a.c:1\n### 2. Wrong sign\nSign at c.c:5\n'
                               '### 3. Stale cache\nCache at d.c:3\n### 4. Race in init\nRace at e.c:9\n',
            'diff:' + self.CL: '## Findings\n### 1. Lifecycle leak\nLeak at b.c:10\n',
            'ask:' + self.CL: '### [CONFIRMED] P1 Parser overflow\nEvidence: a.c:1\n'
                              '### [REJECTED] P2 Wrong sign\nReason: covered by test_sign\n'
                              '### [REJECTED] P3 Stale cache\nReason: invalidated at d.c:3\n'
                              '### [UNVERIFIED] P4 Race in init\nReason: no way to trigger it\n',
            'ask:' + self.PI: '### [CONFIRMED] C1 Lifecycle leak\nEvidence: ran t, saw leak\n'
                              '### [WITHDRAWN] P3 Stale cache\nOn reflection the cache is invalidated.\n'}
        result = self.coop(reports=result_reports)
        path = self.report_path(result.stdout)
        report = path.read_text()
        self.assertEqual(result.stdout, f'# Sidecar report ({path})\n' + report)
        both = self.section(report, 'Confirmed by both')
        disputed = self.section(report, 'Disputed')
        rejected = self.section(report, 'Rejected by both')
        self.assertIn('Findings: 4 from pi (slot 98), 1 from Claude Code (slot 99). Confirmed by both 2, disputed 2, rejected by both 1.', report)
        self.assertIn('### P1: Parser overflow\nOrigin: pi (slot 98). Confirmed by Claude Code (slot 99).', both)
        self.assertIn('Overflow at a.c:1', both)
        self.assertIn('### C1: Lifecycle leak\nOrigin: Claude Code (slot 99). Confirmed by pi (slot 98).', both)
        self.assertIn('### P2: Wrong sign\nOrigin: pi (slot 98). Claude Code (slot 99) rejected it.', disputed)
        self.assertIn("**pi (slot 98)'s finding:**\n\nSign at c.c:5", disputed)
        self.assertIn('covered by test_sign', disputed)
        self.assertIn('### P4: Race in init', disputed)
        self.assertIn('could not decide; unverified', disputed)
        self.assertIn('### P3: Stale cache\nOrigin: pi (slot 98). Rejected by Claude Code (slot 99) and withdrawn by pi (slot 98).', rejected)
        self.assertIn('On reflection the cache is invalidated.', rejected)
        self.assertNotIn('## Warnings', report)
        self.assertEqual(len(re.findall(r'^- .*: .*/reports/.*\.md$', report, re.M)), 4)

    def test_coop_review_accounts_for_findings_the_peer_never_checked(self):
        report = self.coop_report({
            'diff:' + self.PI: '## Findings\n### 1. Parser overflow\nOverflow at parser.c:10\n### 2. Lifecycle leak\nLeak at lifecycle.c:20\n',
            'diff:' + self.CL: '## Findings\n### 1. Init race\nRace at init.c:30\n',
            'ask:' + self.PI: '### [CONFIRMED] C1 Init race\nEvidence: test_race failed\n',
            'ask:' + self.CL: '### [CONFIRMED] P1 Parser overflow\nEvidence: test_overflow failed\n'})
        self.assertIn('Findings: 2 from pi (slot 98), 1 from Claude Code (slot 99). Confirmed by both 2, disputed 1, rejected by both 0.', report)
        disputed = self.section(report, 'Disputed')
        self.assertIn('### P2: Lifecycle leak', disputed)
        self.assertIn('Claude Code (slot 99) did not check it; unverified', disputed)
        self.assertIn('Leak at lifecycle.c:20', disputed)

    def test_coop_review_flags_unknown_and_duplicate_entries_instead_of_trusting_them(self):
        report = self.coop_report({
            'diff:' + self.PI: '## Findings\n### 1. Parser overflow\nOverflow\n',
            'ask:' + self.CL: '### [CONFIRMED] P1 Parser overflow\nEvidence: one\n'
                              '### [REJECTED] P1 Parser overflow\nReason: two\n'
                              '### [CONFIRMED] P9 Invented finding\nEvidence: made up\n'})
        self.assertNotIn('Confirmed by both (1)', report)
        self.assertIn('Findings: 1 from pi (slot 98), 0 from Claude Code (slot 99). Confirmed by both 0, disputed 1, rejected by both 0.', report)
        disputed = self.section(report, 'Disputed')
        self.assertIn('gave 2 conflicting or repeated entries (flagged); unverified', disputed)
        self.assertIn('Evidence: one', disputed)
        self.assertIn('Reason: two', disputed)
        warnings = report[report.index('## Warnings'):report.index('## Confirmed by both')]
        self.assertIn('`[CONFIRMED] P9 Invented finding` matches no finding', warnings)
        self.assertNotIn('Invented finding', self.section(report, 'Confirmed by both'))
        self.assertNotIn('Invented finding', disputed)

    def test_coop_review_does_not_merge_titles_that_differ_only_by_punctuation(self):
        report = self.coop_report({
            'diff:' + self.PI: '## Findings\n### Accept +n\nPositive rejected\n### Accept -n\nNegative rejected\n',
            'ask:' + self.CL: '### [REJECTED] Accept +n\nReason: positive works\n### [CONFIRMED] Accept -n\nEvidence: cli -1 fails\n'})
        self.assertIn('### P1: Accept +n\nOrigin: pi (slot 98). Claude Code (slot 99) rejected it.', self.section(report, 'Disputed'))
        self.assertIn('### P2: Accept -n\nOrigin: pi (slot 98). Confirmed by Claude Code (slot 99).', self.section(report, 'Confirmed by both'))

    def test_coop_review_ambiguous_titles_without_an_id_are_flagged_not_applied(self):
        report = self.coop_report({
            'diff:' + self.PI: '## Findings\n### Same title\nFirst\n### Same title\nSecond\n',
            'ask:' + self.CL: '### [CONFIRMED] Same title\nEvidence: which one?\n'})
        self.assertEqual(self.section(report, 'Confirmed by both').strip(), 'None.')
        self.assertEqual(report.count('did not check it; unverified'), 2)
        self.assertIn('matches several of pi (slot 98)\'s findings and it cites no ID', report)

    def test_coop_review_a_lone_withdrawal_is_disputed_not_rejected_by_both(self):
        report = self.coop_report({
            'diff:' + self.PI: '## Findings\n### 1. Bad timeout\nToo short\n### 2. Bad retry\nToo many\n',
            'ask:' + self.PI: '### [WITHDRAWN] P1 Bad timeout\nI withdraw this.\n### [WITHDRAWN] P2 Bad retry\nWithdrawn too.\n',
            'ask:' + self.CL: '### [REJECTED] P2 Bad retry\nReason: retries are capped.\n'})
        self.assertEqual(self.section(report, 'Rejected by both').count('###'), 1)
        self.assertIn('### P2: Bad retry\nOrigin: pi (slot 98). Rejected by', self.section(report, 'Rejected by both'))
        disputed = self.section(report, 'Disputed')
        self.assertIn('### P1: Bad timeout', disputed)
        self.assertIn('did not check it; unverified; pi (slot 98) withdrew it', disputed)
        self.assertIn('I withdraw this.', disputed)

    def test_coop_review_warns_when_nothing_could_be_extracted_or_checked(self):
        report = self.coop_report({'diff:' + self.PI: '## Findings\nA free-form paragraph without headings.\n',
                                   'diff:' + self.CL: '## Findings\n### 1. Leak\nDetail\n'})
        self.assertIn('No findings were extracted from pi (slot 98)\'s review', report)
        self.assertIn('Claude Code (slot 99)', report)
        self.assertIn('pi (slot 98) returned no parseable verdicts; every finding of Claude Code (slot 99) is listed as unchecked.', report)
        self.assertIn('### C1: Leak', self.section(report, 'Disputed'))

    def test_coop_review_question_exits_3_with_the_slot_to_answer(self):
        result = self.coop(reports={'diff:' + self.CL: {'report': '## Blocked\n', 'question': 'Which API?'}}, check=False)
        self.assertEqual(result.returncode, 3)
        self.assertIn('asked a question: Which API?', result.stdout)
        self.assertIn('sidecar --slot 99 answer TEXT', result.stdout)
        self.assertIn('pi (slot 98): done', result.stdout)
        self.assertEqual(self.requests('ask', self.PI), [])
        self.assertEqual(self.run_cli('--slot', '99', 'answer', 'The new one').returncode, 0)

    def test_coop_review_remote_question_is_read_from_the_marker_not_a_fixed_line(self):
        self.add_machines()
        repo, _ = self.make_repo()
        checkout = self.home / 'laptop-checkout'
        checkout.mkdir()
        result = self.run_cli('--machine', 'laptop', '--remote-cwd', str(checkout), 'coop-review',
                              env=dict(self.remote_env, FAKE_QUESTION='Which API?'), cwd=repo, check=False)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn('asked a question: Which API?', result.stdout)
        self.assertNotIn('asked a question: \n', result.stdout)

    def test_coop_review_failure_propagates_the_reviewers_exit_code(self):
        result = self.coop(env={'FAKE_NO_REPORT': '1', 'SIDECAR_SETTLE_GRACE_S': '0'}, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn('failed with exit 2', result.stdout)
        self.assertIn('stopped during review', result.stderr)
        self.assertEqual(self.requests('ask', self.PI), [])

    def test_coop_review_unknown_base_fails_without_a_report(self):
        result = self.coop('nosuchref', check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('unknown base: nosuchref', result.stderr)

    def test_coop_review_second_phase_fails_fast_when_another_request_takes_a_slot(self):
        import fcntl
        repo, _ = self.repo_with_change()
        state = self.home / '.cache/claude-sidecar'
        env = dict(self.env, HERDR_PROMPT_DELAY_sc_pane_1_99='2')
        process = subprocess.Popen([str(self.launcher), 'coop-review'], cwd=repo, env=env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 10
            while not (self.home / 'prompts.jsonl').exists() or not any(p['name'] == self.PI for p in self.prompts()):
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.02)
            # Another request grabs the pi slot as soon as the pi review releases it.
            with (state / f'{self.PI}.lock').open('w') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                stdout, stderr = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 1)
            self.assertIn('slot 98 is busy with another request', stderr)
            self.assertNotIn('waiting for it', stderr)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=10)

    def test_coop_review_cancellation_signals_nothing_and_releases_the_reservations(self):
        import fcntl
        repo, _ = self.repo_with_change()
        stranger = subprocess.Popen(['sleep', '60'])
        process = subprocess.Popen([str(self.launcher), 'coop-review'], cwd=repo, env=dict(self.env, HERDR_PROMPT_DELAY='4'),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 10
            while subprocess.run(['pgrep', '-fc', re.escape(f'{self.home}/bin/herdr') + ' agent prompt sc-pane-1-9'], capture_output=True, text=True).stdout.strip() != '2':
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.05)
            launchers = [int(pid) for pid in subprocess.run(['pgrep', '-P', str(process.pid)], capture_output=True, text=True).stdout.split()
                         if '--slot 9' in Path('/proc', pid, 'cmdline').read_bytes().replace(b'\0', b' ').decode()]
            self.assertEqual(len(launchers), 2)
            started = time.monotonic()
            process.terminate()
            stdout, stderr = process.communicate(timeout=3)
            self.assertLess(time.monotonic() - started, 3)
            self.assertEqual(process.returncode, 143)
            self.assertIn('# Cooperative review interrupted (during review)', stdout)
            # Nothing was signalled: the launchers (and an unrelated process) are still running.
            for pid in launchers:
                self.assertTrue(Path('/proc', str(pid)).exists())
                self.assertNotIn('Z', Path('/proc', str(pid), 'stat').read_text().rsplit(') ', 1)[1][:1])
            self.assertIsNone(stranger.poll())
            for slot in (self.PI, self.CL):
                with (self.home / '.cache/claude-sidecar' / f'{slot}.coop.lock').open('w') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # While the detached launchers hold their slots, a new run fails fast.
            busy = self.run_cli('coop-review', cwd=repo, check=False)
            self.assertEqual(busy.returncode, 1)
            self.assertIn('is busy with another request', busy.stderr)
            # Once they finish, the slots are usable again.
            deadline = time.monotonic() + 15
            while any(Path('/proc', str(pid)).exists() and
                      Path('/proc', str(pid), 'stat').read_text().rsplit(') ', 1)[1][:1] != 'Z' for pid in launchers):
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.1)
            self.assertEqual(self.run_cli('coop-review', cwd=repo).returncode, 0)
        finally:
            stranger.kill()
            stranger.wait()
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=10)

    def test_coop_review_launcher_crash_does_not_keep_the_callers_pipes_open(self):
        repo, _ = self.repo_with_change()
        # The pi review's prompt client outlives its killed launcher for 8 s; the Claude review ends at once.
        env = dict(self.env, HERDR_PROMPT_DELAY_sc_pane_1_98='8', HERDR_PROMPT_DELAY_sc_pane_1_99='0')
        process = subprocess.Popen([str(self.launcher), 'coop-review'], cwd=repo, env=env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 10
            victim = None
            while victim is None:
                self.assertLess(time.monotonic(), deadline)
                for pid in subprocess.run(['pgrep', '-P', str(process.pid)], capture_output=True, text=True).stdout.split():
                    try:
                        command = Path('/proc', pid, 'cmdline').read_bytes().replace(b'\0', b' ').decode()
                    except FileNotFoundError:
                        continue
                    if '--slot 98 ' in command:
                        victim = int(pid)
                time.sleep(.05)
            while subprocess.run(['pgrep', '-f', re.escape(f'{self.home}/bin/herdr') + ' agent prompt sc-pane-1-98'], capture_output=True).returncode != 0:
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.05)
            os.kill(victim, signal.SIGKILL)
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 137)
            self.assertIn('failed with exit 137', stdout)
            # The orphaned prompt client is still sleeping, yet the caller's pipes are closed.
            self.assertEqual(subprocess.run(['pgrep', '-f', re.escape(f'{self.home}/bin/herdr') + ' agent prompt sc-pane-1-98'], capture_output=True).returncode, 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=10)

    def test_coop_review_launcher_stderr_is_relayed_with_the_reviewer_label(self):
        result = self.coop(env={'HERDR_PROMPT_DELAY': '1', 'SIDECAR_PROGRESS_S': '1'})
        self.assertRegex(result.stderr, r'\[pi slot 98\] sidecar: \S+ still working')
        self.assertRegex(result.stderr, r'\[claude slot 99\] sidecar: \S+ still working')

    def test_concurrent_coop_reviews_cannot_both_be_admitted_to_the_same_slots(self):
        repo, _ = self.repo_with_change()
        # Delay the reviewers' start so both runs would pass an idle probe before either takes a slot lock.
        real = shutil.which('setsid')
        wrapper = self.home / 'bin/setsid'
        wrapper.write_text(f'#!/bin/sh\nsleep .5\nexec {real} "$@"\n')
        wrapper.chmod(0o755)
        jobs = [subprocess.Popen([str(self.launcher), 'coop-review', 'HEAD', f'Round {i}'], cwd=repo, env=self.env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for i in (1, 2)]
        results = [job.communicate(timeout=30) + (job.returncode,) for job in jobs]
        codes = sorted(r[2] for r in results)
        self.assertEqual(codes, [0, 1], results)
        loser = next(r for r in results if r[2] == 1)
        self.assertIn('is in use by another coop-review', loser[1])
        self.assertEqual(len([p for p in self.prompts() if p['kind'] == 'diff']), 2)

    def test_coop_review_fenced_code_does_not_cut_a_finding_short(self):
        report = self.coop_report({
            'diff:' + self.PI: ('## Findings\n### 1. Parser bug\nAt parser.c:10, wrong output.\n'
                                'Reproduce:\n```sh\n# Create the failing input\ncli --input bad\n```\n'
                                '~~~~\n## still code\n~~~\nObserved output: segmentation fault\nSuggested fix: validate the input.\n'
                                '~~~~\n### 2. Second\nSecond detail\n')})
        text = report[report.index('Findings:'):]
        self.assertIn('Findings: 2 from pi', text)
        for needle in ('# Create the failing input', 'cli --input bad', 'segmentation fault', 'Suggested fix: validate the input.'):
            self.assertIn(needle, text)

    def test_coop_review_fenced_verdict_examples_are_not_verdicts(self):
        report = self.coop_report({
            'diff:' + self.PI: '## Findings\n### 1. Parser bug\nAt parser.c:10.\n### 2. Lifecycle leak\nAt lifecycle.c:20.\n',
            'ask:' + self.CL: ('### [CONFIRMED] P1 Parser bug\nEvidence: this input crashes the parser:\n'
                               '```markdown\n### [CONFIRMED] P2 Lifecycle leak\nEvidence: example text, not a verdict.\n```\n'
                               '````\n```\n### [CONFIRMED] P2 Lifecycle leak\n````\n'
                               'I have not yet checked the lifecycle issue.\n')})
        self.assertIn('### P1: Parser bug\nOrigin: pi (slot 98). Confirmed by Claude Code (slot 99).', self.section(report, 'Confirmed by both'))
        self.assertIn('example text, not a verdict.', self.section(report, 'Confirmed by both'))
        disputed = self.section(report, 'Disputed')
        self.assertIn('### P2: Lifecycle leak\nOrigin: pi (slot 98). Claude Code (slot 99) did not check it; unverified.', disputed)
        self.assertNotIn('matches no finding', report)

    def test_coop_review_contradictory_id_and_title_is_flagged_not_applied(self):
        report = self.coop_report({
            'diff:' + self.PI: '## Findings\n### 1. Parser bug\nAt parser.c:10.\n### 2. Lifecycle leak\nAt lifecycle.c:20.\n',
            'ask:' + self.CL: ('### [CONFIRMED] P1 Lifecycle leak\nEvidence: lifecycle_test fails.\n'
                               '### [REJECTED] P2 Parser bug\nReason: parser_test passes.\n')})
        self.assertEqual(self.section(report, 'Confirmed by both').strip(), 'None.')
        self.assertEqual(self.section(report, 'Rejected by both').strip(), 'None.')
        self.assertEqual(report.count('did not check it; unverified'), 2)
        self.assertIn('`[CONFIRMED] P1 Lifecycle leak` matches no finding (it cites P1 but its title matches another finding)', report)
        self.assertIn('`[REJECTED] P2 Parser bug` matches no finding (it cites P2 but its title matches another finding)', report)

    def test_coop_review_a_paraphrased_title_with_a_valid_id_is_accepted(self):
        report = self.coop_report({
            'diff:' + self.PI: '## Findings\n### 1. Parser bug\nAt parser.c:10.\n',
            'ask:' + self.CL: '### [CONFIRMED] P1 Parser crashes on bad input\nEvidence: test.\n'})
        self.assertIn('### P1: Parser bug', self.section(report, 'Confirmed by both'))


    def test_coop_review_reads_crlf_reports(self):
        original = ('## Findings\n### 1. Parser bug\nAt parser.c:10.\n```sh\n# comment\ncli --input bad\n```\n'
                    '### 2. Lifecycle leak\nAt lifecycle.c:20, confirmed by test_leak.\n')
        report = self.coop_report({
            'diff:' + self.PI: original.replace('\n', '\r\n'),
            'ask:' + self.CL: ('### [CONFIRMED] P1 Parser bug\nEvidence: parser test fails.\n```\nexample\n```\n'
                               '### [CONFIRMED] P2 Lifecycle leak\nEvidence: lifecycle test fails.\n').replace('\n', '\r\n')})
        self.assertIn('Findings: 2 from pi (slot 98), 0 from Claude Code (slot 99). Confirmed by both 2, disputed 0', report)
        both = self.section(report, 'Confirmed by both')
        self.assertIn('### P2: Lifecycle leak', both)
        self.assertIn('cli --input bad', both)
        self.assertIn('lifecycle test fails.', both)
        self.assertNotIn('\r', report)

    def test_coop_review_sigkill_during_final_output_releases_the_slot_reservations(self):
        import fcntl
        repo, _ = self.repo_with_change()
        canned = self.home / 'large-report.json'
        canned.write_text(json.dumps({
            'diff:' + self.PI: '## Findings\n### 1. Large finding\n' + 'Detailed argument.\n' * 50000,
            'ask:' + self.CL: '### [CONFIRMED] P1 Large finding\nEvidence: test fails.\n'}))
        process = subprocess.Popen([str(self.launcher), 'coop-review'], cwd=repo, env=dict(self.env, FAKE_REPORTS=str(canned)),
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        orphan = None
        try:
            # Nothing reads stdout, so the final report print blocks once the pipe fills.
            deadline = time.monotonic() + 20
            while orphan is None:
                self.assertLess(time.monotonic(), deadline)
                for pid in subprocess.run(['pgrep', '-P', str(process.pid)], capture_output=True, text=True).stdout.split():
                    try:
                        command = Path('/proc', pid, 'cmdline').read_bytes().replace(b'\0', b' ').decode()
                    except FileNotFoundError:
                        continue
                    if command.startswith('cat -- ') and '-coop-review.' in command:
                        orphan = int(pid)
                time.sleep(.02)
            process.kill()
            process.wait(timeout=5)
            time.sleep(.2)
            self.assertTrue(Path('/proc', str(orphan)).exists())
            for slot in (self.PI, self.CL):
                with (self.home / '.cache/claude-sidecar' / f'{slot}.coop.lock').open('w') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            if orphan:
                try:
                    os.kill(orphan, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=10)


if __name__ == '__main__':
    unittest.main()
