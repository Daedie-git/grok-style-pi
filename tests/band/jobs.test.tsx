import { expect, test, mock } from 'claude-code/testing'

const TOOL = 'mcp__claude-sidecar__sidecar'
const DIR = '/fake-home/.cache/claude-sidecar/jobs/sc-pane-1'

// An in-memory state directory; scripts/sidecar-job is a recorded process.run.
function setup(on) {
  const files: Record<string, string> = {}
  const runs: string[][] = []
  const submitted: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/fake-home' : e.name === 'HERDR_PANE_ID' ? 'PANE:1' : undefined }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__claude-sidecar__${e.name}` } }))
  on('fs.list', (_, e) => ({
    value: Object.keys(files)
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_, e) => (e.path in files ? { value: files[e.path] } : { deny: 'missing' }))
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'status: idle\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ran' }))
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 12, 9, 0, 0) })
  const job = () => Object.keys(files).find(path => /\.json$/.test(path))!.slice(DIR.length + 1, -'.json'.length)
  const finish = (code: number, out: string) => {
    const id = job()
    files[`${DIR}/${id}.out`] = out
    files[`${DIR}/${id}.err`] = 'sidecar: x still working (1m0s)\nsidecar: blocked on a question\n'
    files[`${DIR}/${id}.done`] = `{"code":${code},"finished":1}`
    return id
  }
  return { files, runs, submitted, clock, finish }
}

test('a request starts a detached job whose result arrives as a prompt once idle', async ($, on) => {
  const s = setup(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const started = await $.tool.call({ tool: TOOL, args: ['--slot', '2', 'ask', 'Fix it'], cwd: '/repo' })
  expect(started.result).toMatch(/^Started job 20261112090000-2-ask-[0-9a-f]{8}: sidecar --slot 2 ask 'Fix it'/)
  const run = s.runs.at(-1)!
  expect(run[1]).toMatch(/scripts\/sidecar-job$/)
  expect(run.slice(2)).toEqual([DIR, expect.stringMatching(/-2-ask-/), '--slot', '2', 'ask', 'Fix it'])
  const id = s.finish(3, 'NEEDS_ANSWER: Keep the old API?\n')
  expect(s.submitted).toEqual([])
  await s.clock.advance(3000)
  expect(s.submitted.length).toBe(1)
  expect(s.submitted[0]).toMatch(`Sidecar job ${id} finished`)
  expect(s.submitted[0]).toMatch(/in \/repo/)
  expect(s.submitted[0]).toMatch(/Exit 3: the sidecar asks a question/)
  expect(s.submitted[0]).toMatch(/NEEDS_ANSWER: Keep the old API\?/)
  expect(s.submitted[0]).toMatch(/blocked on a question/)
  expect(s.submitted[0]).not.toMatch(/still working/)
  expect(`${DIR}/${id}.delivered` in s.files).toBe(true)
  await s.clock.advance(30000)
  expect(s.submitted.length).toBe(1)
})

test('a job that finishes mid-turn rides on the next main-thread tool result', async ($, on) => {
  const s = setup(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: TOOL, args: ['diff', 'main'] })
  s.finish(0, 'report body\n')
  await s.clock.advance(3000)
  expect(s.submitted).toEqual([])
  const subagent = await $.tool.call({ tool: 'Read', file_path: 'a', agentId: 'a1' })
  expect(subagent.context).toBe(undefined)
  const main = await $.tool.call({ tool: 'Read', file_path: 'a' })
  expect(main.context?.[0]).toMatch(/Exit 0: report delivered[\s\S]*report body/)
  const next = await $.tool.call({ tool: 'Read', file_path: 'b' })
  expect(next.context).toBe(undefined)
  expect(s.submitted).toEqual([])
})

test('a job held at turn end is submitted then', async ($, on) => {
  const s = setup(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: TOOL, args: ['plan', 'p.md'] })
  s.finish(2, '')
  await s.clock.advance(3000)
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1, isAborted: false, reason: 'completed' })
  expect(s.submitted.length).toBe(1)
  expect(s.submitted[0]).toMatch(/Exit 2: no report submitted/)
})

test('a finished job left by an earlier plugin copy is delivered at session start', async ($, on) => {
  const s = setup(on)
  s.files[`${DIR}/20261112085900-3-ask-abcdef12.json`] = '{"argv":["--slot","3","ask","x"],"started":1}'
  s.files[`${DIR}/20261112085900-3-ask-abcdef12.out`] = 'late report\n'
  s.files[`${DIR}/20261112085900-3-ask-abcdef12.done`] = '{"code":0,"finished":2}'
  s.files[`${DIR}/20261112085800-4-ask-abcdef13.json`] = '{"argv":["--slot","4","ask","y"],"started":1}'
  s.files[`${DIR}/20261112085800-4-ask-abcdef13.done`] = '{"code":0,"finished":2}'
  s.files[`${DIR}/20261112085800-4-ask-abcdef13.delivered`] = '1'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(s.submitted.length).toBe(1)
  expect(s.submitted[0]).toMatch(/sidecar --slot 3 ask x[\s\S]*late report/)
})

test('quick commands answer inline; hook entries are refused', async ($, on) => {
  const s = setup(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const status = await $.tool.call({ tool: TOOL, args: ['--slot', '2', 'status'] })
  expect(status.result).toMatch(/status: idle\nexit 0/)
  expect(s.runs.at(-1)!.slice(1)).toEqual([expect.stringMatching(/scripts\/sidecar$/), '--slot', '2', 'status'])
  const internal = await $.tool.call({ tool: TOOL, args: ['push-gate'] })
  expect(internal.deny).toMatch(/hook entry/)
})

test('Bash launches of job commands are refused; other launcher and unrelated commands run', async ($, on) => {
  setup(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const command of [
    '"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot 2 ask "Fix it" &',
    'cd ../wt && ~/p/scripts/sidecar --slot 4 --role implementer ask --accept x y',
    'sidecar answer yes',
  ]) expect((await $.tool.call({ tool: 'Bash', command })).deny).toMatch(/mcp__claude-sidecar__sidecar/)
  for (const command of ['"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot 2 status', 'git commit -m "sidecar ask now a tool"', 'ls sidecar'])
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBe(undefined)
})

test('outside Herdr there is no tool and Bash is untouched', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ran' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.tool.call({ tool: 'Bash', command: 'sidecar ask x' })).deny).toBe(undefined)
})
