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

export const DESCRIPTION = `Runs the claude-sidecar launcher (follow the claude-sidecar:sidecar-review skill). args are the launcher's words after "sidecar", e.g. ["--slot", "2", "--role", "implementer", "ask", "Fix the parser"] or ["--slot", "2", "answer", "Keep the old API"]. status, report, keep, unkeep, stop and unreviewed return their output. Every other command starts a job and returns at once; its output and exit code arrive later as a message (exit 3: the sidecar asks a question). Start parallel sidecars with one call per slot.`

export const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    args: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Launcher arguments: options, command, command arguments.' },
    cwd: { type: 'string', description: "Directory to run in (the checkout the request concerns); the session's by default." },
    input: { type: 'string', description: 'Standard input, for commands given "-" in place of TEXT.' },
  },
  required: ['args'],
  additionalProperties: false,
}

// beats: the worker touches .alive (0.20.1+); a job from an older worker has none, and only .done ends it.
export type Job = { argv: string[]; cwd?: string; started: number; beats?: true }
export type Done = { code: number; finished: number }
export type Request = { args: string[]; cwd?: string; input?: string; slot: string; command: string; inline: boolean }

// The command word and slot of launcher args; every global option takes a value.
export function parseArgs(args: readonly string[]): { command: string; slot: string } {
  let slot = '1'
  let i = 0
  for (let word = args[i]; word?.startsWith('--'); word = args[i]) {
    if (word === '--slot') slot = args[i + 1] ?? slot
    i += 2
  }
  return { command: args[i] ?? '', slot }
}

// A tool call's input as a request, or why it is refused. Without cwd it runs in the session's directory.
export function parseRequest(e: Record<string, unknown>): Request | { deny: string } {
  const { args, cwd, input } = e
  if (!Array.isArray(args) || args.length === 0 || !args.every(a => typeof a === 'string'))
    return { deny: 'args must be a non-empty list of strings' }
  if (input !== undefined && typeof input !== 'string') return { deny: 'input must be a string' }
  const { command, slot } = parseArgs(args)
  if (!command) return { deny: 'args name no command' }
  if (INTERNAL.has(command)) return { deny: `${command} is a hook entry, not a command for the model` }
  return { args, cwd: typeof cwd === 'string' && cwd ? cwd : undefined, input, slot, command, inline: INLINE.has(command) }
}

// The line without here-document bodies, which are data. An unquoted delimiter still runs the body's substitutions, so
// those stay, one per line.
export function stripHeredocs(line: string): string {
  const lines = line.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]!)
    for (const match of lines[i]!.matchAll(/(?<!<)<<(-?)\s*(['"]?)([\w.-]+)\2/g)) {
      const [, dash, quoted, delimiter] = match
      for (i++; i < lines.length; i++) {
        const body = lines[i]!
        if ((dash ? body.replace(/^\t+/, '') : body) === delimiter) break
        if (!quoted) out.push(...substitutions(body).map(s => `$(${s})`))
      }
    }
  }
  return out.join('\n')
}

// The simple commands of a shell line as words: quotes removed, line continuations joined, split at ; & | ( ) and
// newlines. Expansions stay literal, which is enough to recognize the launcher.
export function shellCommands(line: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word: string | undefined
  const endWord = () => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === '\\') {
      if (line[i + 1] === '\n') i++
      else word = (word ?? '') + (line[++i] ?? '')
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1)
      word = (word ?? '') + line.slice(i + 1, end < 0 ? undefined : end)
      i = end < 0 ? line.length : end
    } else if (c === '"') {
      let text = ''
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === '\\' && i + 1 < line.length) {
          if (line[i + 1] !== '\n') text += /["\\$`]/.test(line[i + 1]!) ? line[i + 1] : `\\${line[i + 1]}`
          i++
        } else text += line[i]
      }
      word = (word ?? '') + text
    } else if (c === '&' && word !== undefined && /[<>]$/.test(word)) word += c
    else if (/[;&|()\n]/.test(c)) endCommand()
    else if (/\s/.test(c)) endWord()
    else if (c === '#' && word === undefined) {
      while (i + 1 < line.length && line[i + 1] !== '\n') i++
    } else word = (word ?? '') + c
  }
  endCommand()
  return commands
}

// Words that run the command after them: wrappers and shell control words.
const PREFIXES = new Set(['bash', 'sh', 'env', 'exec', 'command', 'nohup', 'setsid', 'nice', 'time', 'timeout', 'sudo',
  'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{'])
// A redirection word; a bare operator takes the next word as its target.
const REDIRECT = /^\d*(?:&?>>?|<<?<?|[<>]&)/
const BARE_REDIRECT = /^\d*(?:&?>>?|<<?<?|[<>]&)$/

// The bodies of $(...) and `...` substitutions, which run even inside double quotes.
function substitutions(line: string): string[] {
  const bodies: string[] = []
  for (let i = line.indexOf('$('); i >= 0; i = line.indexOf('$(', i + 2)) {
    let depth = 0
    for (let j = i + 1; j < line.length; j++) {
      if (line[j] === '(') depth++
      else if (line[j] === ')' && --depth === 0) {
        bodies.push(line.slice(i + 2, j))
        break
      }
    }
  }
  for (const match of line.matchAll(/`([^`]*)`/g)) bodies.push(match[1]!)
  return bodies
}

// Why a Bash command is refused: the launcher's Bash path would leave a request unobserved.
export function bashDenial(script: string): string | undefined {
  const line = stripHeredocs(script)
  for (const body of substitutions(line)) {
    const inner = bashDenial(body)
    if (inner) return inner
  }
  for (const words of shellCommands(line)) {
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
