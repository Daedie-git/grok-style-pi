"""Remote sync tests use real local Git origins and the launcher's isolated SSH harness."""
import json
import os
from pathlib import Path
import subprocess
import unittest
import test_sidecar as fixtures


class SyncMachineTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.LauncherTests('test_start_default_and_idempotency')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.add_machines()
        self.home = self.fixture.home
        self.remote = self.fixture.remote_home()
        self.remote.mkdir(parents=True, exist_ok=True)
        self.repos = {}
        for name in ('grok-style-pi', 'claude-sidecar'):
            origin = self.home / 'origins' / (name + '.git')
            origin.parent.mkdir(exist_ok=True)
            self.git(self.home, 'init', '--bare', '--initial-branch=main', str(origin))
            seed = self.home / ('seed-' + name)
            seed.mkdir()
            self.git(seed, 'init', '--initial-branch=main')
            (seed / 'README.md').write_text('initial\n')
            (seed / 'package.json').write_text(json.dumps({'name': name}))
            self.commit(seed, 'Initial')
            self.git(seed, 'remote', 'add', 'origin', str(origin))
            self.git(seed, 'push', '-u', 'origin', 'main')
            checkout = self.remote / 'git' / name
            checkout.parent.mkdir(exist_ok=True)
            self.git(self.remote, 'clone', str(origin), str(checkout))
            self.repos[name] = {'origin': origin, 'seed': seed, 'checkout': checkout, 'old': self.head(checkout)}

    def git(self, cwd, *args):
        return subprocess.run(['git', '-C', str(cwd), *args], text=True, capture_output=True,
                              env=dict(self.fixture.env, GIT_CONFIG_NOSYSTEM='1'), check=True).stdout.strip()

    def commit(self, root, message):
        self.git(root, 'add', '.')
        self.git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', message)

    def head(self, root):
        return self.git(root, 'rev-parse', 'HEAD')

    def advance(self, name):
        repo = self.repos[name]
        (repo['seed'] / 'new.txt').write_text('new upstream content\n')
        self.commit(repo['seed'], 'Advance origin')
        self.git(repo['seed'], 'push', 'origin', 'main')
        return self.head(repo['seed'])

    def sync(self, **kwargs):
        return self.fixture.run_cli('sync-machine', 'laptop', **kwargs)

    def settings(self, config):
        path = self.home / '.config/claude-sidecar/machines.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'laptop': config}))

    def test_fast_forward_both_and_report_commits_without_binding_the_slot(self):
        # A local slot binding must not prevent independent machine maintenance.
        self.fixture.run_cli('start')
        expected = {name: self.advance(name) for name in self.repos}
        result = self.sync()
        for name, repo in self.repos.items():
            self.assertEqual(self.head(repo['checkout']), expected[name])
            self.assertIn(repo['old'] + ' -> ' + expected[name], result.stdout)
        binding = self.home / '.cache/claude-sidecar/sc-pane-1.machine'
        self.assertEqual(binding.read_text(), 'local\n')
        self.assertFalse(self.fixture.remote_calls())

    def test_clean_up_to_date_checkouts_are_reported(self):
        result = self.sync()
        for repo in self.repos.values():
            self.assertIn(repo['old'] + ' -> ' + repo['old'], result.stdout)

    def test_dirty_second_checkout_refuses_before_updating_either(self):
        for name in self.repos:
            self.advance(name)
        (self.repos['claude-sidecar']['checkout'] / 'untracked.txt').write_text('local work')
        result = self.sync(check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('has local changes', result.stderr)
        for repo in self.repos.values():
            self.assertEqual(self.head(repo['checkout']), repo['old'])

    def test_untracked_files_are_refused_even_when_git_config_hides_them(self):
        for name in self.repos:
            self.advance(name)
        root = self.repos['claude-sidecar']['checkout']
        self.git(root, 'config', 'status.showUntrackedFiles', 'no')
        (root / 'untracked.txt').write_text('local work')
        self.assertEqual(self.git(root, 'status', '--porcelain=v1'), '')
        result = self.sync(check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('has local changes', result.stderr)
        for repo in self.repos.values():
            self.assertEqual(self.head(repo['checkout']), repo['old'])

    def test_divergence_refuses_before_updating_either(self):
        for name in self.repos:
            self.advance(name)
        root = self.repos['claude-sidecar']['checkout']
        (root / 'local.txt').write_text('local commit')
        self.commit(root, 'Local divergence')
        local = self.head(root)
        result = self.sync(check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('has diverged from origin/main', result.stderr)
        self.assertEqual(self.head(root), local)
        self.assertEqual(self.head(self.repos['grok-style-pi']['checkout']), self.repos['grok-style-pi']['old'])

    def test_local_unpublished_commits_are_preserved_and_refused(self):
        root = self.repos['grok-style-pi']['checkout']
        (root / 'local.txt').write_text('not published')
        self.commit(root, 'Local only')
        local = self.head(root)
        result = self.sync(check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('has local commits not on origin/main', result.stderr)
        self.assertEqual(self.head(root), local)

    def test_detached_checkout_is_refused(self):
        root = self.repos['grok-style-pi']['checkout']
        self.git(root, 'checkout', '--detach')
        result = self.sync(check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('detached HEAD', result.stderr)

    def test_discover_active_checkout_from_pi_settings(self):
        name = 'grok-style-pi'
        repo = self.repos[name]
        custom = self.remote / 'custom active grok'
        repo['checkout'].rename(custom)
        repo['checkout'] = custom
        settings = self.remote / '.pi/agent/settings.json'
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({'packages': [{'source': str(custom)}]}))
        new = self.advance(name)
        result = self.sync()
        self.assertEqual(self.head(custom), new)
        self.assertIn(str(custom), result.stdout)

    def test_glob_resources_select_active_custom_checkout_not_stale_known_copy(self):
        repo = self.repos['grok-style-pi']
        extensions = repo['seed'] / 'extensions'
        extensions.mkdir()
        (extensions / 'active.ts').write_text('export default function () {}\n')
        self.commit(repo['seed'], 'Add extension')
        self.git(repo['seed'], 'push', 'origin', 'main')
        custom = self.remote / 'custom' / 'grok-style-pi'
        custom.parent.mkdir()
        self.git(self.remote, 'clone', str(repo['origin']), str(custom))
        active_old = self.head(custom)
        settings = self.remote / '.pi/agent/settings.json'
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({'extensions': [str(custom / 'extensions' / '*.ts')]}))
        new = self.advance('grok-style-pi')
        result = self.sync()
        self.assertEqual(self.head(custom), new)
        self.assertIn(active_old + ' -> ' + new, result.stdout)
        self.assertIn(str(custom), result.stdout)
        self.assertEqual(self.head(repo['checkout']), repo['old'])

    def test_unresolved_active_glob_refuses_instead_of_updating_known_copy(self):
        custom = self.remote / 'custom active tooling'
        custom.mkdir()
        (custom / 'extensions').mkdir()
        (custom / 'extensions' / 'active.ts').write_text('export default function () {}\n')
        settings = self.remote / '.pi/agent/settings.json'
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({'extensions': [str(custom / 'extensions' / '*.ts')]}))
        for name in self.repos:
            self.advance(name)
        result = self.sync(check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Cannot resolve configured Pi resources', result.stderr)
        self.assertIn(str(custom), result.stderr)
        for repo in self.repos.values():
            self.assertEqual(self.head(repo['checkout']), repo['old'])

    def test_missing_configured_tooling_path_refuses_known_location_fallback(self):
        settings = self.remote / '.pi/agent/settings.json'
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({'extensions': [str(self.remote / 'custom' / 'grok-style-pi' / 'extensions' / 'active.ts')]}))
        self.advance('grok-style-pi')
        result = self.sync(check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Cannot resolve configured grok-style-pi paths', result.stderr)
        repo = self.repos['grok-style-pi']
        self.assertEqual(self.head(repo['checkout']), repo['old'])

    def test_explicit_paths_with_quotes_metacharacters_and_unicode_are_not_shell_code(self):
        paths = {}
        for name, repo in self.repos.items():
            custom = self.remote / (name + ' é \' $HOME ; echo injected')
            repo['checkout'].rename(custom)
            repo['checkout'] = custom
            paths[name] = str(custom)
            self.advance(name)
        self.settings({'transport': 'node', 'tooling': paths})
        result = self.sync()
        self.assertEqual(result.returncode, 0)
        self.assertFalse((self.remote / 'injected').exists())
        ssh = [json.loads(line) for line in (self.home / 'ssh-calls.jsonl').read_text().splitlines()]
        self.assertLess(len(ssh[-1]['command']), 8191)

    def test_missing_checkout_is_clear_and_does_not_update_the_other(self):
        self.advance('grok-style-pi')
        self.settings({'tooling': {'claude-sidecar': str(self.remote / 'missing')}})
        result = self.sync(check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('is not a Git checkout', result.stderr)
        repo = self.repos['grok-style-pi']
        self.assertEqual(self.head(repo['checkout']), repo['old'])

    def test_ambiguous_pi_paths_are_refused_instead_of_guessing(self):
        repo = self.repos['grok-style-pi']
        other = self.remote / 'another grok'
        self.git(self.remote, 'clone', str(repo['origin']), str(other))
        settings = self.remote / '.pi/agent/settings.json'
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({'packages': [str(repo['checkout']), str(other)]}))
        result = self.sync(check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Ambiguous grok-style-pi checkouts in Pi settings', result.stderr)
        self.assertEqual(self.head(repo['checkout']), repo['old'])

    def test_invalid_explicit_paths_do_not_fall_back_to_known_locations(self):
        for value in ('', None, [], 'relative/checkout'):
            with self.subTest(path=value):
                self.settings({'tooling': {'grok-style-pi': value}})
                result = self.sync(check=False)
                self.assertEqual(result.returncode, 1)
                self.assertIn('must be an absolute path', result.stderr)

    def test_disabled_settings_paths_do_not_shadow_the_active_checkout(self):
        repo = self.repos['grok-style-pi']
        other = self.remote / 'disabled grok'
        self.git(self.remote, 'clone', str(repo['origin']), str(other))
        settings = self.remote / '.pi/agent/settings.json'
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({'packages': [str(repo['checkout']), '-' + str(other)]}))
        new = self.advance('grok-style-pi')
        self.sync()
        self.assertEqual(self.head(repo['checkout']), new)
        self.assertEqual(self.head(other), repo['old'])

    def test_unreachable_machine_and_invalid_timeout_fail_clearly(self):
        result = self.sync(env=dict(self.fixture.env, FAKE_SSH_DOWN='1'), check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('cannot reach laptop', result.stderr)
        result = self.sync(env=dict(self.fixture.env, SIDECAR_SYNC_TIMEOUT_S='invalid'), check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('must be a positive integer', result.stderr)


if __name__ == '__main__':
    unittest.main()
