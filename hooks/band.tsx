import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { SlotRow } from '../types'

const rows = atom({ plugin: 'claude-sidecar', key: 'rows' } as const, [] as SlotRow[])
const now = atom({ plugin: 'claude-sidecar', key: 'now' } as const, 0)

// Fast while a row shows or right after this session runs the launcher; slow otherwise.
const FAST_MS = 3000
const SLOW_MS = 30000
const LAUNCH_WINDOW_MS = 15000

// Claude Code's subagent red for reviewers, blue for implementers, green for researchers, yellow for explorers.
const ROLE_COLORS: Record<string, string> = { implementer: '#2563eb', researcher: '#16a34a', explorer: '#ca8a04' }
const roleColor = (role: string) => ROLE_COLORS[role] ?? '#dc2626'

function elapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export const register: Register = on => {
  let timer: { cancel(): void } | undefined
  let fastUntil = 0
  let refresh: (() => void) | undefined
  let ticker: { cancel(): void } | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const home = await $.env.get('HOME')
    const pane = await $.env.get('HERDR_PANE_ID')
    // The launcher's owner name: SIDECAR_AGENT, else sc-<pane id, lowercased, ':' as '-'>.
    const owner = (await $.env.get('SIDECAR_AGENT')) || (pane ? `sc-${pane.toLowerCase().replace(/:/g, '-')}` : undefined)
    if (!home || !owner) return result
    const dir = `${home}/.cache/claude-sidecar`
    const pattern = new RegExp(`^${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-(\\d+))?\\.request\\.json$`)
    const text = (name: string, fallback: string) =>
      $.fs.read(`${dir}/${name}`).then(t => (typeof t === 'string' ? t.trim() : fallback) || fallback, () => fallback)

    // A failed look still schedules the next one.
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
        let request: { id?: string; started?: number; finished?: number }
        try {
          request = JSON.parse(await text(entry.name, '{}'))
        } catch {
          continue
        }
        const busy = request.finished === undefined
        const waiting = !busy && names.has(`${name}.pending`)
        if (!busy && !waiting) continue
        found.push({
          slot,
          role: await text(`${name}.role`, 'reviewer'),
          agent: await text(`${name}.agent`, 'pi'),
          // The binding's first line is the machine; a second may hold the remote checkout.
          machine: (await text(`${name}.machine`, 'local')).split('\n')[0] || 'local',
          kind: request.id?.split('-')[2] ?? 'request',
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

  // A launcher call starts or answers a request: look now and keep looking until it shows.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (refresh && /\bsidecar\b/.test(e.command)) {
      fastUntil = (await $.clock.now()) + LAUNCH_WINDOW_MS
      $.clock.after(1000, refresh)
    }
    return next(e)
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
          const where = row.machine === 'local' ? '' : ` @ ${row.machine}`
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
