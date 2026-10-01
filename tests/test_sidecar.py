"""Launcher integration tests with isolated HOME and a fake Herdr executable."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]

HERDR = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, time
args = sys.argv[1:]
home = pathlib.Path(os.environ['HOME'])
state_path = home / 'agent.json'
state = json.loads(state_path.read_text()) if state_path.exists() else None
with (home / 'calls.jsonl').open('a') as log:
    log.write(json.dumps(args) + '\n')
if args[:2] == ['pane', 'layout']:
    print(json.dumps({'result': {'layout': {'panes': [{'pane_id': 'PANE:1', 'rect': {'width': 200, 'height': 40}}]}}}))
elif args[:2] == ['pane', 'split']:
    print(json.dumps({'result': {'pane': {'pane_id': 'review-pane'}}}))
elif args[:2] == ['agent', 'get']:
    time.sleep(float(os.environ.get('HERDR_GET_DELAY', '0')))
    if state is None:
        sys.exit(1)
    print(json.dumps({'result': {'agent': state}}))
elif args[:2] == ['agent', 'start']:
    time.sleep(float(os.environ.get('HERDR_START_DELAY', '0')))
    session = args[args.index('--session-id') + 1]
    with state_path.open('x') as output:
        json.dump({'agent_status': 'idle', 'agent_session': {'value': '/tmp/time_' + session + '.jsonl'}}, output)
elif args[:2] == ['agent', 'wait']:
    while state_path.exists() and json.loads(state_path.read_text())['agent_status'] == 'working':
        time.sleep(0.05)
elif args[:2] == ['agent', 'rename']:
    state_path.unlink()
elif args[:2] == ['agent', 'prompt']:
    prompt = args[3]
    if prompt.startswith('[request '):
        request_id = prompt.split(']', 1)[0].split()[1]
        reports = home / '.cache/claude-sidecar/reports'
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
        self.env = dict(os.environ, HOME=str(self.home), PATH=f'{bin_dir}:/usr/bin:/bin',
                        HERDR_ENV='1', HERDR_PANE_ID='PANE:1')
        for key in ('SIDECAR_AGENT', 'SIDECAR_PI_SESSION', 'SIDECAR_MODEL', 'SIDECAR_THINKING', 'CLAUDE_ENV_FILE'):
            self.env.pop(key, None)

    def run_cli(self, *args, input='', env=None, cwd=None, check=True):
        return subprocess.run([str(self.launcher), *args], input=input, text=True,
                              capture_output=True, env=env or self.env, cwd=cwd, check=check)

    def calls(self):
        path = self.home / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_start_default_and_idempotency(self):
        self.run_cli('start')
        self.run_cli('start')
        starts = [c for c in self.calls() if c[:2] == ['agent', 'start']]
        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0][starts[0].index('--model') + 1], 'openai-codex/gpt-6.1-sol')
        self.assertEqual(starts[0][starts[0].index('--thinking') + 1], 'high')
        self.assertEqual(starts[0][starts[0].index('-e') + 1], str(self.plugin / 'sidecar/sidecar.ts'))

    def test_concurrent_start_splits_once(self):
        env = dict(self.env, HERDR_GET_DELAY='0.1')
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.run_cli, 'start', env=env) for _ in range(2)]
            for future in futures:
                future.result()
        self.assertEqual(sum(c[:2] == ['pane', 'split'] for c in self.calls()), 1)
        self.assertEqual(sum(c[:2] == ['agent', 'start'] for c in self.calls()), 1)

    def test_clear_during_pending_hook_startup(self):
        env_file = self.home / 'claude.env'
        env = dict(self.env, HERDR_START_DELAY='0.2', CLAUDE_ENV_FILE=str(env_file))
        self.run_cli('session-start', input='{"session_id":"first"}', env=env)
        self.run_cli('session-start', input='{"session_id":"after-clear"}', env=env)
        log = self.home / '.cache/claude-sidecar/sc-pane-1.log'
        for _ in range(150):
            if log.exists() and 'already running' in log.read_text():
                break
            time.sleep(0.02)
        else:
            self.fail('Detached startups did not finish')
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
        # Wait for the detached startup before temporary files disappear.
        log = self.home / '.cache/claude-sidecar/sc-pane-1.log'
        for _ in range(100):
            if log.exists() and 'already running' in log.read_text():
                break
            time.sleep(0.02)
        else:
            self.fail('Detached startup did not finish')

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


if __name__ == '__main__':
    unittest.main()
