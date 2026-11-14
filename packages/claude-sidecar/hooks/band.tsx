import { atom, read, update } from 'claude-code'
import type { Register, ToolCallResult } from 'claude-code'

import type { SlotRow } from '../types'
import { bashDenial, DESCRIPTION, INPUT_SCHEMA, JOB_RECORD, jobId, jobMessage, LOST_CODE, LOST_MS, parseRequest, POLL_MS, TOOL_NAME } from './jobs'
import type { Done, Job, Request } from './jobs'
import { identity } from './owner'

const rows = atom({ plugin: 'claude-sidecar', key: 'rows' } as const, [] as SlotRow[])
const now = atom({ plugin: 'claude-sidecar', key: 'now' } as const, 0)

// Fast while a row shows or right after this session runs the launcher; slow otherwise.
const FAST_MS = 3000
const SLOW_MS = 30000
const LAUNCH_WINDOW_MS = 15000

// Claude Code's subagent red for reviewers, blue for implementers, green for researchers, yellow for explorers.
const ROLE_COLORS: Record<string, string> = { implementer: '#2563eb', researcher: '#16a34a', explorer: '#ca8a04' }
// Plain labels for the launcher's request kinds (the third field of a request id).
const KIND_LABELS: Record<string, string> = {
  ask: 'task',
  diff: 'code review',
  plan: 'plan review',
  answer: 'resumed with answer',
  reject: 're-checking rejection',
}

const roleColor = (role: string) => ROLE_COLORS[role] ?? '#dc2626'

function elapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`
}

export const register: Register = on => {
  let timer: { cancel(): void } | undefined
  let fastUntil = 0
  let refresh: (() => void) | undefined
  let ticker: { cancel(): void } | undefined
  // The sidecar tool (hooks/jobs.ts), set up at session start in a Herdr pane or Herdr app terminal.
  let serve: ((request: Request) => Promise<ToolCallResult>) | undefined
  let deliverHeld: (() => Promise<void>) | undefined
  let takeHeld: (() => Promise<string[]>) | undefined
  let turnRunning = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const who = identity({
      HOME: await $.env.get('HOME'),
      USERPROFILE: await $.env.get('USERPROFILE'),
      SIDECAR_MUX: await $.env.get('SIDECAR_MUX'),
      HERDR_PANE_ID: await $.env.get('HERDR_PANE_ID'),
      HC_TERMINAL_ID: await $.env.get('HC_TERMINAL_ID'),
      SIDECAR_AGENT: await $.env.get('SIDECAR_AGENT'),
    })
    if (!who) return result
    const { dir, owner } = who

    // Jobs: DIR/ID.json, then .out, .err and .done from scripts/sidecar-job, then .delivered once handed to the model.
    const jobDir = `${dir}/jobs/${owner}`
    // On Windows, plain `bash` may be WSL's: use the Git Bash Claude names, else Git's default install.
    const gitBash = 'C:/Program Files/Git/bin/bash.exe'
    const bash =
      (await $.env.get('CLAUDE_CODE_GIT_BASH_PATH')) ||
      ((await $.env.get('USERPROFILE')) && (await $.fs.exists(gitBash).catch(() => false)) ? gitBash : 'bash')
    const raw = (path: string) => $.fs.read(path).then(t => (typeof t === 'string' ? t : ''), () => '')
    // Finished jobs waiting for the main thread's next tool result or the end of its turn.
    const held = new Map<string, string>()
    // Jobs being handed on; scans skip them until their marker is written.
    const claimed = new Set<string>()
    // Running jobs whose heartbeat looked stale, with when that was first seen.
    const stale = new Map<string, number>()
    let jobTimer: { cancel(): void } | undefined
    let scanning = false
    // A launch or scan request during a scan: poll again afterwards.
    let rescan = false
    const marker = (id: string) => `${jobDir}/${id}.delivered`
    // Delivered here: a scan whose directory listing predates the marker still skips them.
    const delivered = new Set<string>()
    const mark = async (id: string) => {
      await $.fs.write(marker(id), `${await $.clock.now()}\n`)
      delivered.add(id)
    }
    // Takes every held result at once, so concurrent tool results never share one.
    const claim = () => {
      const taken = [...held]
      held.clear()
      for (const [id] of taken) claimed.add(id)
      return taken
    }
    const release = (id: string, text?: string) => {
      claimed.delete(id)
      if (text !== undefined) held.set(id, text)
    }
    // Marked before it is handed on, so a reload never delivers it twice. A refused submission is unmarked and held for
    // the next tool result or turn end. Not awaited: a submission resolves only once its turn starts, which a
    // turn.complete hook would hold up.
    const submit = async (id: string, text: string) => {
      claimed.add(id)
      try {
        await mark(id)
      } catch {
        return release(id, text)
      }
      const refused = async () => {
        await $.process.run([bash, '-c', 'rm -f -- "$1"', 'rm', marker(id)]).catch(() => undefined)
        delivered.delete(id)
        release(id, text)
      }
      void $.prompt.submit({ text }).then(r => (r.drop === undefined ? release(id) : refused()), refused)
    }
    const scanJobs = async () => {
      if (scanning) {
        rescan = true
        return
      }
      scanning = true
      rescan = false
      let running = false
      try {
        const entries = await $.fs.list(jobDir).catch(() => [])
        const byName = new Map(entries.map(entry => [entry.name, entry]))
        let now: number | undefined
        for (const entry of entries) {
          const id = JOB_RECORD.exec(entry.name)?.[1]
          if (!id || byName.has(`${id}.delivered`) || delivered.has(id) || held.has(id) || claimed.has(id)) continue
          if (!byName.has(`${id}.done`)) {
            running = true
            // A worker that died without .done: record it lost; the next scan delivers it. Workers from before
            // heartbeats are waited for.
            let beat = byName.get(`${id}.alive`)
            if (!beat) {
              let beats = false
              try {
                beats = Boolean((JSON.parse(await raw(`${jobDir}/${entry.name}`)) as Job).beats)
              } catch {}
              if (!beats) continue
              beat = entry
            }
            now ??= await $.clock.now()
            if (now - beat.mtimeMs <= LOST_MS) {
              stale.delete(id)
              continue
            }
            const since = stale.get(id) ?? now
            stale.set(id, since)
            if (now - since < LOST_MS) continue
            stale.delete(id)
            const lost: Done = { code: LOST_CODE, finished: Math.floor(now / 1000) }
            await $.fs.write(`${jobDir}/${id}.done`, JSON.stringify(lost))
            continue
          }
          let job: Job, done: Done
          try {
            job = JSON.parse(await raw(`${jobDir}/${entry.name}`))
            done = JSON.parse(await raw(`${jobDir}/${id}.done`))
          } catch {
            continue
          }
          const text = jobMessage(jobDir, id, job, done, await raw(`${jobDir}/${id}.out`), await raw(`${jobDir}/${id}.err`))
          if (delivered.has(id) || held.has(id) || claimed.has(id)) continue
          if (turnRunning) held.set(id, text)
          else await submit(id, text)
        }
      } finally {
        scanning = false
        jobTimer?.cancel()
        jobTimer = running || rescan ? $.clock.after(POLL_MS, () => void scanJobs()) : undefined
      }
    }
    deliverHeld = async () => {
      for (const [id, text] of claim()) await submit(id, text)
    }
    takeHeld = async () => {
      const texts: string[] = []
      for (const [id, text] of claim()) {
        try {
          await mark(id)
          release(id)
          texts.push(text)
        } catch {
          release(id, text)
        }
      }
      return texts
    }
    serve = async request => {
      if (request.inline) {
        const run = await $.process.run([bash, `${$.plugin.root}/scripts/sidecar`, ...request.args], {
          cwd: request.cwd,
          stdin: request.input,
          timeoutMs: 600000,
        })
        return { result: [run.stdout.trimEnd(), run.stderr.trimEnd(), `exit ${run.exitCode}`].filter(Boolean).join('\n') }
      }
      const ms = await $.clock.now()
      const id = jobId(ms, request, crypto.randomUUID())
      if (request.input !== undefined) await $.fs.write(`${jobDir}/${id}.in`, request.input)
      const job: Job = { argv: request.args, cwd: request.cwd, started: Math.floor(ms / 1000), beats: true }
      await $.fs.write(`${jobDir}/${id}.json`, JSON.stringify(job))
      const run = await $.process
        .run([bash, `${$.plugin.root}/scripts/sidecar-job`, jobDir, id, ...request.args], { cwd: request.cwd })
        .catch((error: unknown) => ({ exitCode: -1, stderr: String(error) }))
      if (run.exitCode !== 0) {
        await mark(id)
        return { deny: `could not start the job: ${run.stderr.trim() || `exit ${run.exitCode}`}` }
      }
      // A scan in progress may have decided nothing runs; it polls again.
      if (scanning) rescan = true
      else {
        jobTimer?.cancel()
        jobTimer = $.clock.after(POLL_MS, () => void scanJobs())
      }
      return {
        result: `Started job ${id}; its result arrives as a message. Continue other work or end your turn.`,
      }
    }
    // The band works without the tool.
    await $.tool.register({ name: TOOL_NAME, description: DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false }).catch(() => undefined)
    // Jobs that finished while the plugin was reloading or Claude was away.
    await scanJobs()

    const pattern = new RegExp(`^${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-(\\d+))?\\.request\\.json$`)
    const text = (name: string, fallback: string) =>
      $.fs.read(`${dir}/${name}`).then(t => (typeof t === 'string' ? t.trim() : fallback) || fallback, () => fallback)

    // A failed look still schedules the next one.
    // Empty for a local slot. A remote binding's first line is the machine id; the launcher records its label.
    const machineOf = async (name: string, label?: string) => {
      const binding = (await text(`${name}.machine`, 'local')).split('\n')[0] || 'local'
      return binding === 'local' ? '' : label || binding
    }
    // {id, generation, answered?}; older launchers wrote the bare request id, never answered.
    const answered = async (name: string) => {
      try { return Boolean(JSON.parse(await text(`${name}.pending`, '')).answered) } catch { return false }
    }
    const poll = () => scan().catch(() => undefined).finally(() => void schedule())
    const schedule = async () => {
      const fast = (await read($, rows)).length > 0 || (await $.clock.now()) < fastUntil
      timer?.cancel()
      timer = $.clock.after(fast ? FAST_MS : SLOW_MS, () => void poll())
    }
    const scan = async () => {
      const entries = await $.fs.list(dir).catch(() => [])
      const names = new Set(entries.map(entry => entry.name))
      const found: SlotRow[] = []
      for (const entry of entries) {
        const match = pattern.exec(entry.name)
        if (!match) continue
        const slot = match[1] ?? '1'
        const name = slot === '1' ? owner : `${owner}-${slot}`
        let request: { id?: string; started?: number; finished?: number; machine?: string }
        try {
          request = JSON.parse(await text(entry.name, '{}'))
        } catch {
          continue
        }
        const busy = request.finished === undefined
        // A stopped slot keeps its question for a later answer, but nobody is waiting on it. Neither is anyone waiting
        // on a question whose answer reached the sidecar: the launcher marks it, keeping the file for a retry.
        const waiting = !busy && names.has(`${name}.pending`) && !names.has(`${name}.stopped`) && !(await answered(name))
        if (!busy && !waiting) continue
        found.push({
          slot,
          role: await text(`${name}.role`, 'reviewer'),
          agent: await text(`${name}.agent`, 'pi'),
          machine: await machineOf(name, request.machine),
          kind: KIND_LABELS[request.id?.split('-')[2] ?? ''] ?? 'request',
          started: request.started ?? 0,
          waiting,
        })
      }
      found.sort((a, b) => Number(a.slot) - Number(b.slot))
      const before = await read($, rows)
      if (JSON.stringify(before) !== JSON.stringify(found)) await update($, rows, () => found)
      await tick()
    }
    // Elapsed times redraw every second, only while a running row is shown.
    const tick = async () => {
      if (!(await read($, rows)).some(row => !row.waiting)) return
      const ms = await $.clock.now()
      await update($, now, () => ms)
    }

    refresh = () => void poll()
    ticker?.cancel()
    ticker = $.clock.every(1000, () => void tick())
    await poll()
    return result
  })

  on('tool.call', { tool: 'mcp__claude-sidecar__sidecar' }, async ($, e) => {
    if (!serve) return { deny: 'sidecars need a Herdr pane or Herdr app terminal' }
    const request = parseRequest(e as unknown as Record<string, unknown>)
    if ('deny' in request) return request
    // A request starts or answers a sidecar: look now and keep looking until it shows.
    if (refresh) {
      fastUntil = (await $.clock.now()) + LAUNCH_WINDOW_MS
      $.clock.after(1000, refresh)
    }
    return serve(request)
  }).catch(($, e, next) => ({ deny: `${$.plugin.name}: the sidecar tool failed` }))

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const deny = serve && bashDenial(e.command)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))

  // A job that finishes during a main-thread turn rides on its next tool result, else it is submitted at turn end.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || !takeHeld || result.deny !== undefined) return result
    const texts = await takeHeld()
    return texts.length ? { ...result, context: [...(result.context ?? []), ...texts] } : result
  }).catch(($, e, next) => next(e))
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) turnRunning = true
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      turnRunning = false
      await deliverHeld?.()
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, rows)
    if (list.length === 0) return next(e)
    const ms = await read($, now)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text dimColor>{'─'.repeat(Math.max(0, e.props.bodyColumns))}</Text>
        {list.map(row => {
          const where = row.machine ? ` @ ${row.machine}` : ''
          const detail = row.waiting ? ' · needs an answer' : ` · ${row.role} · ${row.agent}${where} · ${row.kind} · ${elapsed(ms / 1000 - row.started)}`
          return (
            <Text key={row.slot}>
              <Text color={roleColor(row.role)}>{row.waiting ? '?' : '◆'} sidecar {row.slot}</Text>
              <Text color={row.waiting ? 'warning' : undefined} dimColor={!row.waiting}>{detail}</Text>
            </Text>
          )
        })}
      </Box>
    )
  })
}
