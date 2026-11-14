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
  expect(started.result).toMatch(/^Started job 20261112090000-2-ask-[0-9a-f]{8}; its result arrives as a message/)
  const run = s.runs.at(-1)!
  expect(run[1]).toMatch(/scripts\/sidecar-job$/)
  expect(run.slice(2)).toEqual([DIR, expect.stringMatching(/-2-ask-/), '--slot', '2', 'ask', 'Fix it'])
  const id = s.finish(3, 'NEEDS_ANSWER: Keep the old API?\n')
  expect(s.submitted).toEqual([])
  await s.clock.advance(3000)
  expect(s.submitted.length).toBe(1)
  expect(s.submitted[0]).toMatch(`Sidecar job ${id} exited 3: the sidecar asks a question`)
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
  expect(main.context?.[0]).toMatch(/exited 0: report delivered[\s\S]*report body/)
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
  expect(s.submitted[0]).toMatch(/exited 2: no report submitted/)
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
  expect(s.submitted[0]).toMatch(/-3-ask-abcdef12 exited 0[\s\S]*late report/)
})

test('a job whose worker stopped beating is reported lost with its partial output', async ($, on) => {
  const s = setup(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, args: ['ask', 'x'] })
  const id = Object.keys(s.files).find(path => path.endsWith('.json'))!.slice(DIR.length + 1, -'.json'.length)
  s.files[`${DIR}/${id}.out`] = 'partial output\n'
  await s.clock.advance(90000)
  expect(s.submitted).toEqual([])
  await s.clock.advance(6000)
  expect(s.submitted.length).toBe(1)
  expect(s.submitted[0]).toMatch(/exited -1: the job runner died[\s\S]*partial output/)
})

test('a job from a worker without heartbeats is waited for, not reported lost', async ($, on) => {
  const s = setup(on)
  s.files[`${DIR}/20261112085900-3-ask-abcdef12.json`] = '{"argv":["--slot","3","ask","x"],"started":1}'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await s.clock.advance(300000)
  expect(s.submitted).toEqual([])
  s.files[`${DIR}/20261112085900-3-ask-abcdef12.done`] = '{"code":0,"finished":2}'
  await s.clock.advance(3000)
  expect(s.submitted[0]).toMatch(/exited 0: report delivered/)
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

test('invalid plan stdin calls are refused before announcing or creating a job', async ($, on) => {
  const s = setup(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const [args, input] of [
    [['--slot', '2', '--role', 'reviewer', 'plan', '-'], 'Review the plan at p.md. Check its assumptions.'],
    [['plan', '-'], undefined],
    [['plan'], undefined],
    [['plan', ''], undefined],
    [['plan', 'p.md'], 'Check assumptions'],
    [['plan', 'p.md'], ''],
  ] as const) {
    const reply = await $.tool.call({ tool: TOOL, args: [...args], ...(input === undefined ? {} : { input }) })
    expect(reply.deny).toMatch(/plan FILE \[CONTEXT\]/)
    expect(reply.deny).toMatch(/put the review context in args, not input/)
    expect(reply.deny).not.toMatch(/ask/)
    expect(reply.result).toBe(undefined)
  }
  expect(s.runs).toEqual([])
  expect(Object.keys(s.files)).toEqual([])
})

test('plan file and context arguments and ask stdin still start jobs', async ($, on) => {
  const s = setup(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const plan = await $.tool.call({ tool: TOOL, args: ['--slot', '2', '--role', 'reviewer', 'plan', 'p.md', 'Check assumptions'] })
  expect(plan.result).toMatch(/^Started job/)
  expect(s.runs.at(-1)!.slice(-3)).toEqual(['plan', 'p.md', 'Check assumptions'])
  const ask = await $.tool.call({ tool: TOOL, args: ['ask', '-'], input: 'Review p.md and check assumptions' })
  expect(ask.result).toMatch(/^Started job/)
  expect(Object.values(s.files)).toContain('Review p.md and check assumptions')
})

test('Bash launches of job commands are refused; other launcher and unrelated commands run', async ($, on) => {
  setup(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const command of [
    '"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot 2 ask "Fix it" &',
    'cd ../wt && ~/p/scripts/sidecar --slot 4 --role implementer ask --accept x y',
    'sidecar answer yes',
    'sidecar --slot 2 \\\n ask x',
    "bash -c 'sidecar --slot 3 diff main'",
    'if true; then sidecar ask x; fi',
    'for s in 2 3; do sidecar --slot $s ask x; done',
    'echo "$(sidecar ask x)"',
    'x=`sidecar plan p.md`',
    '>out 2>&1 sidecar ask x',
    'timeout 600 env A=1 sidecar ask x',
    'cat <<EOF\n$(sidecar ask x)\nEOF',
    'cat <<EOF\n$(\nsidecar ask x\n)\nEOF',
    "printf '%s\\n' 'example <<EOF'\nsidecar ask x",
    'echo "$(echo "nested" && sidecar ask x)"',
    'echo "$(echo foo # don\'t (\n)"; sidecar ask x',
    'echo `echo "\\$(sidecar ask x)"`',
    '0<<EOF sidecar ask x\ninput\nEOF',
  ]) expect((await $.tool.call({ tool: 'Bash', command })).deny).toMatch(/mcp__claude-sidecar__sidecar/)
  for (const command of [
    '"${CLAUDE_PLUGIN_ROOT}/scripts/sidecar" --slot 2 status',
    'git commit -m "sidecar ask now a tool"',
    'ls sidecar; echo sidecar ask # sidecar ask',
    'ls 2>&1 | grep sidecar',
    "python3 - <<'EOF'\nrun(\"bash -c 'sidecar ask x'\")\nsidecar ask x\nEOF\necho done",
    'cat <<-EOF\n\tsidecar ask x\n\tEOF',
    "printf '%s\\n' '$(sidecar ask x)'",
    '# $(sidecar ask x)\nprintf ok',
  ])
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBe(undefined)
})

test('outside Herdr there is no tool and Bash is untouched', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ran' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.tool.call({ tool: 'Bash', command: 'sidecar ask x' })).deny).toBe(undefined)
})
