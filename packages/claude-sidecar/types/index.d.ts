export type SlotRow = {
  slot: string
  role: string
  agent: string
  machine: string
  kind: string
  started: number
  waiting: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'claude-sidecar': { rows: SlotRow[]; now: number }
  }
}
