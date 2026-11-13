import { lex } from './shell'

// The sidecar tool: the model drives sidecars through it. Requests run as detached jobs (scripts/sidecar-job) that
// outlive plugin reloads; each result comes back as a message, so no request goes unobserved. band.tsx serves it.

export const TOOL_NAME = 'sidecar'
export const TOOL = 'mcp__claude-sidecar__sidecar'
// Commands that finish within seconds run inline; the rest are jobs. Hook entries are not the model's to run.
const INLINE = new Set(['status', 'report', 'keep', 'unkeep', 'stop', 'unreviewed'])
const INTERNAL = new Set(['session-start', 'session-end', 'sweep', 'done-close', 'push-gate'])
const JOB_COMMANDS = new Set(['note', 'plan', 'diff', 'coop-review', 'ask', 'answer', 'steer', 'reject', 'wait', 'reload', 'start', 'restart', 'sync-machine'])
export const POLL_MS = 3000
// A running job's worker touches DIR/ID.alive this often (scripts/sidecar-job). One silent for longer than LOST_MS, seen
// so across scans at least that far apart (a suspended machine wakes up stale), died without writing .done.
export const LOST_MS = 90000
// The exit code the plugin records for a job whose worker died.
export const LOST_CODE = -1
const EXIT_MEANING: Record<number, string> = {
  0: 'report delivered',
  2: 'no report submitted; the output shows the pane',
  3: 'the sidecar asks a question; decide (or ask the user), then answer on the same slot with args [..., "answer", "<decision>"]',
  4: 'an identical request is already in flight; wait for it',
  5: 'the sidecar is blocked on an approval in its pane; ask the user to handle it there',
  7: 'refused while a request runs',
  [-1]: 'the job runner died before the launcher finished (killed, or the machine restarted); the sidecar may still be working, so check status and report on its slot',
  129: 'the job runner was hung up',
  130: 'interrupted',
  143: 'terminated',
}
// Progress lines while a request runs say nothing once it has finished.
const PROGRESS = /^sidecar: \S+ still working \(/

export const DESCRIPTION = `Runs the claude-sidecar launcher (follow the claude-sidecar:sidecar-review skill). args are the launcher's words after "sidecar", e.g. ["--slot", "2", "--role", "implementer", "ask", "Fix the parser"] or ["--slot", "2", "answer", "Keep the old API"]. status, report, keep, unkeep, stop and unreviewed return their output. For plan review, use ["plan", "path/to/plan.md", "Review context"]: FILE must be a real path, never "-", and context goes in args, not input. Every other command starts a job and returns at once; its output and exit code arrive later as a message (exit 3: the sidecar asks a question). Start parallel sidecars with one call per slot.`

export const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    args: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Launcher arguments: options, command, command arguments.' },
    cwd: { type: 'string', description: "Directory to run in (the checkout the request concerns); the session's by default." },
    input: { type: 'string', description: 'Standard input for ask, note, answer, steer or reject with "-" in place of TEXT. Not supported by plan: use args ["plan", "FILE", "CONTEXT"].' },
  },
  required: ['args'],
  additionalProperties: false,
}

// beats: the worker touches .alive (0.20.1+); a job from an older worker has none, and only .done ends it.
export type Job = { argv: string[]; cwd?: string; started: number; beats?: true }
export type Done = { code: number; finished: number }
export type Request = { args: string[]; cwd?: string; input?: string; slot: string; command: string; inline: boolean }

// The command word and slot of launcher args; every global option takes a value.
export function parseArgs(args: readonly string[]): { command: string; slot: string; commandIndex: number } {
  let slot = '1'
  let i = 0
  for (let word = args[i]; word?.startsWith('--'); word = args[i]) {
    if (word === '--slot') slot = args[i + 1] ?? slot
    i += 2
  }
  return { command: args[i] ?? '', slot, commandIndex: i }
}

// A tool call's input as a request, or why it is refused. Without cwd it runs in the session's directory.
export function parseRequest(e: Record<string, unknown>): Request | { deny: string } {
  const { args, cwd, input } = e
  if (!Array.isArray(args) || args.length === 0 || !args.every(a => typeof a === 'string'))
    return { deny: 'args must be a non-empty list of strings' }
  if (input !== undefined && typeof input !== 'string') return { deny: 'input must be a string' }
  const { command, slot, commandIndex } = parseArgs(args)
  if (!command) return { deny: 'args name no command' }
  if (INTERNAL.has(command)) return { deny: `${command} is a hook entry, not a command for the model` }
  if (command === 'plan' && (!args[commandIndex + 1] || args[commandIndex + 1] === '-' || input !== undefined))
    return { deny: 'usage: sidecar plan FILE [CONTEXT]. FILE must be a real path, not "-"; put the review context in args, not input.' }
  return { args, cwd: typeof cwd === 'string' && cwd ? cwd : undefined, input, slot, command, inline: INLINE.has(command) }
}

// Words that run the command after them: wrappers and shell control words.
const PREFIXES = new Set(['bash', 'sh', 'env', 'exec', 'command', 'nohup', 'setsid', 'nice', 'time', 'timeout', 'sudo',
  'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{'])
// A redirection word; a bare operator takes the next word as its target.
const REDIRECT = /^\d*(?:&?>>?|<<?<?|[<>]&)/
const BARE_REDIRECT = /^\d*(?:&?>>?|<<?<?|[<>]&)$/

// Why a Bash command is refused: the launcher's Bash path would leave a request unobserved.
export function bashDenial(script: string): string | undefined {
  const { commands, scripts } = lex(script)
  for (const body of scripts) {
    const inner = bashDenial(body)
    if (inner) return inner
  }
  for (const words of commands) {
    // A `bash -c SCRIPT` runs SCRIPT.
    const script = words.findIndex((w, j) => w === '-c' && /^(.*\/)?(ba)?sh$/.test(words[j - 1] ?? ''))
    const inner = script >= 0 ? bashDenial(words[script + 1] ?? '') : undefined
    if (inner) return inner
    let i = 0
    // Assignments, redirections, wrappers and their options or durations.
    while (i < words.length) {
      const w = words[i]!
      if (BARE_REDIRECT.test(w)) i += 2
      else if (REDIRECT.test(w) || /^[A-Za-z_]\w*=/.test(w) || PREFIXES.has(w)) i++
      else if (i > 0 && (w.startsWith('-') || /^\d+[smhd]?$/.test(w))) i++
      else break
    }
    if (!/(^|\/)sidecar$/.test(words[i] ?? '')) continue
    if (JOB_COMMANDS.has(parseArgs(words.slice(i + 1)).command))
      return `Run sidecar requests with the ${TOOL} tool (args = the words after "sidecar"), one call per slot; its result reaches you as a message. Bash runs of ${[...JOB_COMMANDS].join(', ')} are refused.`
  }
  return undefined
}

const quote = (word: string) => (/^[\w./:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)
export const shown = (argv: readonly string[]) => ['sidecar', ...argv].map(quote).join(' ')

// A job's record: DIR/<id>.json. Slot and command in the id are only labels, reduced to what the record pattern takes.
export const JOB_RECORD = /^(\d{14}-[a-z0-9-]+-[0-9a-f]{8})\.json$/
const label = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'x'

export const jobId = (ms: number, request: Request, random: string) =>
  `${new Date(ms).toISOString().replace(/\D/g, '').slice(0, 14)}-${label(request.slot)}-${label(request.command)}-${random.replace(/-/g, '').slice(0, 8)}`

// The message that hands a finished job to the model.
export function jobMessage(dir: string, id: string, job: Job, done: Done, out: string, err: string): string {
  const stderr = err.split('\n').filter(line => line.trim() && !PROGRESS.test(line)).join('\n')
  return [
    `Sidecar job ${id} finished: \`${shown(job.argv)}\`${job.cwd ? ` in ${job.cwd}` : ''}`,
    `Exit ${done.code}: ${EXIT_MEANING[done.code] ?? 'failed'}.`,
    out.trimEnd() && `Output (${dir}/${id}.out):\n${out.trimEnd()}`,
    stderr && `Stderr:\n${stderr}`,
  ].filter(Boolean).join('\n\n')
}
