type Env = { HOME?: string; USERPROFILE?: string; SIDECAR_MUX?: string; HERDR_PANE_ID?: string; HC_TERMINAL_ID?: string; SIDECAR_AGENT?: string }

// The launcher's state directory and owner name, or undefined outside a Herdr pane or Herdr app terminal.
export function identity(env: Env): { dir: string; owner: string } | undefined {
  // Claude on Windows often has no HOME; the launcher's Git Bash HOME is the user profile.
  const home = env.HOME || env.USERPROFILE
  // The launcher's owner name: SIDECAR_AGENT, else sc-<herdr pane id, lowercased, ':' as '-'>, else sc-hc-<hc terminal>.
  // SIDECAR_MUX picks the host when both IDs are inherited.
  const pane = env.SIDECAR_MUX === 'hc' ? undefined : env.HERDR_PANE_ID
  const terminal = env.SIDECAR_MUX === 'herdr' ? undefined : env.HC_TERMINAL_ID
  const id = pane || (terminal ? `hc-${terminal}` : undefined)
  const owner = env.SIDECAR_AGENT || (id ? `sc-${id.toLowerCase().replace(/:/g, '-')}` : undefined)
  if (!home || !owner) return undefined
  return { dir: `${home}/.cache/claude-sidecar`, owner }
}
