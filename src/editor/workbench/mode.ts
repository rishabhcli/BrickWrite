import type { Workbench } from './useWorkbench'

type ModeSource = Pick<Workbench, 'tool' | 'placement' | 'connect'>
type EscapeSource = Pick<Workbench, 'tool' | 'placement' | 'connect' | 'state'>

/** What the next click means. Rendered on the toolbar island. */
export function describeWorkbenchMode({ tool, placement, connect }: ModeSource): string {
  if (placement) return 'PLACING'
  if (tool === 'connect') return `CONNECT · ${connect.stage.toUpperCase()}`
  return tool.toUpperCase()
}

/** How to leave the current mode. Always a sentence that names Esc. */
export function describeWorkbenchEscape({ tool, placement, connect, state }: EscapeSource): string {
  if (placement) return 'Esc puts the part back'
  if (tool === 'connect' && connect.stage !== 'source') return 'Esc backs out one stage'
  if (state.proposals.length) return 'Esc rejects the ghost proposal'
  return 'Esc returns to Select'
}
