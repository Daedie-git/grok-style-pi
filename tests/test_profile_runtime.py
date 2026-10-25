"""Optional installed-Pi checks: inspect launch resources without any model request."""
import json
import os
import selectors
import subprocess
import sys
import time
import unittest

import test_sidecar

# The ordinary harness remains fake-only. Opt in with an actual CLI, bypassing personal wrappers.
PI = os.environ.get('SIDECAR_TEST_PI')


@unittest.skipUnless(PI and sys.platform == 'linux', 'set SIDECAR_TEST_PI to an installed Linux Pi CLI')
class ProfileRuntimeTests(unittest.TestCase):
    def inspect(self, *, mcp=False, allow=None):
        fixture = test_sidecar.LauncherTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        home = fixture.home
        work = home / 'isolated checkout'
        work.mkdir()
        agent = home / '.pi/agent'
        agent.mkdir(parents=True)
        marker = home / 'mcp-started'
        server = home / 'fixture_mcp.py'
        server.write_text('''import json, pathlib, sys
pathlib.Path(sys.argv[1]).write_text('started')
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method = request['method']
    if method == 'initialize':
        result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'fixture', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': [{'name': 'fixture_read', 'description': 'Fixture only', 'inputSchema': {'type': 'object', 'properties': {}}}]}
    else:
        result = {}
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
''')
        (agent / 'mcp.json').write_text(json.dumps({'mcpServers': {'fixture': {
            'command': sys.executable, 'args': [str(server), str(marker)], 'exposure': 'direct'}}}))
        skill = home / 'selected skill/SKILL.md'
        skill.parent.mkdir()
        skill.write_text('---\nname: selected-profile-skill\ndescription: Selected fixture skill\n---\nFixture instructions.\n')
        # Prove ambient extensions cannot replace MCP or add tools to the worker.
        ambient = agent / 'extensions/ambient.mjs'
        ambient.parent.mkdir()
        ambient.write_text("export default pi => { throw new Error('ambient extension must not load'); };\n")
        profile, _ = fixture.write_profile(mcp=mcp, allow=allow, skills=[str(skill)])
        fixture.run_cli('--profile-file', str(profile), 'start', cwd=work)
        start = [c for c in fixture.calls() if c[:2] == ['agent', 'start']][-1]
        flags = start[start.index('--') + 1:]
        # Session ID and model choice are irrelevant to resource inspection. No prompt is sent to a model.
        for option in ('--session-id', '--model', '--thinking', '-n'):
            i = flags.index(option)
            del flags[i:i + 2]
        inspection = home / 'inspect.mjs'
        result_file = home / 'inspection.json'
        inspection.write_text('''import fs from 'node:fs';
export default pi => pi.registerCommand('inspect-role-profile', {
  handler: async () => {
    const end = Date.now() + 5000;
    if (process.env.EXPECT_MCP === '1') {
      while (!pi.getAllTools().some(t => t.name === 'mcp__fixture__fixture_read') && Date.now() < end)
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    fs.writeFileSync(process.env.INSPECTION_FILE, JSON.stringify({
      active: pi.getActiveTools(), all: pi.getAllTools().map(t => t.name), commands: pi.getCommands().map(c => c.name)
    }));
  }
});
''')
        env = dict(os.environ, HOME=str(home), PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE='1',
                   PI_SKIP_VERSION_CHECK='1', PI_TELEMETRY='0', INSPECTION_FILE=str(result_file),
                   EXPECT_MCP='1' if mcp else '0', XDG_CONFIG_HOME=str(home / 'config'),
                   XDG_CACHE_HOME=str(home / 'cache'), XDG_STATE_HOME=str(home / 'state'))
        for key in ('HERDR_ENV', 'HERDR_PANE_ID', 'PI_CODING_AGENT_SESSION_DIR'):
            env.pop(key, None)
        process = subprocess.Popen([PI, '--mode', 'rpc', '--no-session', '--offline', '--no-approve',
                                    '--no-context-files', '--no-themes', *flags, '-e', str(inspection)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   cwd=work, env=env)
        try:
            process.stdin.write(b'{"id":"inspect","type":"prompt","message":"/inspect-role-profile"}\n')
            process.stdin.flush()
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + 20
                while True:
                    remaining = deadline - time.monotonic()
                    self.assertGreater(remaining, 0, 'Pi inspection timed out without a model request')
                    self.assertTrue(selector.select(remaining), 'Pi inspection timed out')
                    line = process.stdout.readline()
                    if not line:
                        self.fail('Pi exited during inspection: ' + process.stderr.read().decode())
                    response = json.loads(line)
                    self.assertNotEqual(response.get('type'), 'agent_start', 'inspection must not start a model run')
                    if response.get('id') == 'inspect':
                        self.assertTrue(response.get('success'), response)
                        self.assertEqual(response.get('data', {}).get('disposition'), 'handled', response)
                        break
            process.stdin.close()
            process.wait(timeout=10)
            self.assertEqual(process.returncode, 0, process.stderr.read().decode())
            self.assertTrue(result_file.exists(), 'inspection extension never ran')
            result = json.loads(result_file.read_text())
            self.assertTrue({'read', 'submit_review'}.issubset(result['active']), result)
            self.assertIn('skill:selected-profile-skill', result['commands'])
            self.assertIn('sidecar-reload', result['commands'])
            self.assertEqual(marker.exists(), mcp, 'MCP connection gate did not match the profile')
            return result
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

    def test_empty_allow_has_real_assignment_and_reporting_tools_without_mcp(self):
        result = self.inspect(allow=[])
        self.assertCountEqual(result['active'], ['read', 'submit_review'])
        self.assertNotIn('mcp__fixture__fixture_read', result['all'])

    def test_null_allow_keeps_real_editing_defaults(self):
        result = self.inspect(allow=None)
        self.assertTrue({'bash', 'edit', 'write'}.issubset(result['active']), result)

    def test_mcp_opt_in_loads_real_builtin_server_and_selected_skill(self):
        result = self.inspect(mcp=True, allow=None)
        self.assertIn('mcp__fixture__fixture_read', result['active'])
        self.assertIn('codemode', result['all'])
        self.assertIn('tool_search', result['all'])
