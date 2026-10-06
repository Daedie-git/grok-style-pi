// Runs on the saved machine via a fixed-size Node command; the program travels on stdin.
// Git gets argument arrays, never shell-interpolated paths (including Windows cmd.exe hosts).
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const options = JSON.parse(typeof args === 'undefined' ? process.argv[2] || '{}' : args[0]);
const names = ['grok-style-pi', 'claude-sidecar'];
const home = os.homedir();
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=10' };
const timeout = options.timeoutMs || 60000;
function git(root, ...argv) {
  try { return execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8', env: gitEnv, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }).trim(); }
  catch (error) { throw Error(`${root}: git ${argv[0]} failed: ${String(error.stderr || error.message).trim()}`); }
}
function isAncestor(root, a, b) {
  try { execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', a, b], { env: gitEnv, timeout, windowsHide: true }); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}
function expand(value, base = home) {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.resolve(home, value.slice(2));
  return path.resolve(base, value);
}
// Pi resource globs need not exist literally. Their existing literal ancestor
// still identifies the checkout without choosing one of several wildcard matches.
function resourceAncestor(candidate) {
  if (fs.existsSync(candidate)) return candidate;
  const parts = candidate.split(path.sep);
  const wildcard = parts.findIndex(part => /[*?\[\]{}]/.test(part));
  if (wildcard < 0) return undefined;
  let ancestor = parts.slice(0, wildcard).join(path.sep) || path.parse(candidate).root;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return undefined;
    ancestor = parent;
  }
  return ancestor;
}
function checkout(candidate) {
  let dir = candidate;
  if (!fs.existsSync(dir)) return undefined;
  if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return fs.realpathSync(git(dir, 'rev-parse', '--show-toplevel'));
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
function identifies(root, name) {
  if (path.basename(root).toLowerCase() === name) return true;
  try { if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name === name) return true; } catch (_) {}
  return name === 'claude-sidecar' && fs.existsSync(path.join(root, 'scripts', 'sidecar')) && fs.existsSync(path.join(root, 'sidecar', 'sidecar.ts'));
}
function settingsCandidates() {
  const agent = expand(process.env.PI_CODING_AGENT_DIR || '~/.pi/agent');
  const locations = [path.join(agent, 'settings.json')];
  if (options.workDir) locations.push(path.join(options.workDir, '.pi', 'settings.json'));
  const result = [];
  for (const file of locations) {
    if (!fs.existsSync(file)) continue;
    let settings;
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { throw Error(`Cannot read Pi settings ${file}: ${error.message}`); }
    for (const item of [...(settings.packages || []), ...(settings.extensions || []), ...(settings.skills || []), ...(settings.themes || [])]) {
      let source = typeof item === 'string' ? item : item?.source;
      if (typeof source !== 'string' || source.startsWith('!') || source.startsWith('-')) continue;
      source = source.replace(/^\+/, '');
      if (/^(npm:|git:|https?:|builtin:)/.test(source)) continue;
      result.push(expand(source, path.dirname(file)));
    }
  }
  if (options.runtimeHome) result.push(expand(options.runtimeHome));
  return result;
}
function discover(name, configured) {
  if (configured !== undefined) {
    if (typeof configured !== 'string' || (!path.isAbsolute(configured) && !configured.startsWith('~'))) throw Error(`tooling.${name} must be an absolute path`);
    const root = checkout(expand(configured));
    if (!root) throw Error(`tooling.${name} is not a Git checkout: ${configured}`);
    return root;
  }
  const resources = settingsCandidates().map(candidate => {
    const ancestor = resourceAncestor(candidate);
    return { candidate, ancestor, root: ancestor && checkout(ancestor) };
  });
  const unresolved = resources.filter(resource => !resource.root && resource.ancestor);
  const namedMissing = resources.filter(resource => !resource.root && resource.candidate.split(path.sep).some(part => part.toLowerCase() === name));
  if (namedMissing.length) throw Error(`Cannot resolve configured ${name} paths: ${namedMissing.map(resource => resource.candidate).join(', ')}; set tooling.${name}`);
  const fromSettings = [...new Set(resources.map(resource => resource.root).filter(root => root && identifies(root, name)))];
  if (fromSettings.length > 1) throw Error(`Ambiguous ${name} checkouts in Pi settings: ${fromSettings.join(', ')}; set tooling.${name}`);
  if (fromSettings.length === 1) return fromSettings[0];
  // An unresolved active resource may belong to this tool. Refuse rather than
  // silently updating an unrelated known-location copy; explicit tooling wins.
  if (unresolved.length) throw Error(`Cannot resolve configured Pi resources while discovering ${name}: ${unresolved.map(resource => resource.candidate).join(', ')}; set tooling.${name}`);
  const candidates = [path.join(home, 'git', name), path.join(home, 'git', 'codex', name), path.join(home, 'src', name)];
  if (process.platform === 'win32') {
    const drive = `${process.env.SystemDrive || 'C:'}/`;
    candidates.push(path.join(drive, 'git', name), path.join(drive, 'git', 'codex', name));
  }
  const found = [...new Set(candidates.map(checkout).filter(root => root && identifies(root, name)))];
  if (found.length === 1) return found[0];
  if (found.length > 1) throw Error(`Ambiguous ${name} checkouts: ${found.join(', ')}; set tooling.${name}`);
  throw Error(`Cannot find ${name}; configure tooling.${name} in the machine settings`);
}
function preflight(name, root) {
  if (git(root, 'status', '--porcelain=v1', '--untracked-files=all')) throw Error(`${name} has local changes (including untracked files): ${root}; nothing was updated`);
  let branch;
  try { branch = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD'); }
  catch (_) { throw Error(`${name} has detached HEAD: ${root}; check out the intended branch first`); }
  git(root, 'remote', 'get-url', 'origin');
  return { name, root, branch, old: git(root, 'rev-parse', 'HEAD') };
}
try {
  if (options.tooling != null && (typeof options.tooling !== 'object' || Array.isArray(options.tooling))) throw Error('tooling must be an object of checkout paths');
  const repos = names.map(name => preflight(name, discover(name, options.tooling?.[name])));
  if (repos[0].root === repos[1].root) throw Error('The two tooling paths resolve to the same checkout');
  // Fetch and validate both destinations before advancing either checkout. Never reset, rebase, stash or switch branches.
  for (const repo of repos) {
    git(repo.root, 'fetch', '--no-tags', 'origin', `+refs/heads/${repo.branch}:refs/remotes/origin/${repo.branch}`);
    repo.target = git(repo.root, 'rev-parse', `refs/remotes/origin/${repo.branch}`);
    if (!isAncestor(repo.root, repo.old, repo.target)) {
      const reason = isAncestor(repo.root, repo.target, repo.old) ? 'has local commits not on origin' : 'has diverged from origin';
      throw Error(`${repo.name} ${reason}/${repo.branch}: ${repo.root}; nothing was updated`);
    }
  }
  for (const repo of repos) {
    const fresh = preflight(repo.name, repo.root);
    if (fresh.old !== repo.old || fresh.branch !== repo.branch) throw Error(`${repo.name} changed while fetching; nothing was updated`);
  }
  for (const repo of repos) {
    git(repo.root, 'merge', '--ff-only', '--no-edit', `refs/remotes/origin/${repo.branch}`);
    console.log(`${repo.name}: ${repo.old} -> ${git(repo.root, 'rev-parse', 'HEAD')} (${repo.root}; ${repo.branch})`);
  }
} catch (error) { console.error(`sync-machine: ${error.message}`); process.exitCode = 1; }
