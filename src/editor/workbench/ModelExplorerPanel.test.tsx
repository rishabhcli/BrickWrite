import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cadEngine } from '../../cad/engine'
import { createShowcaseDocument } from '../../cad/sample'
import { ModelExplorerPanel } from './ModelExplorerPanel'
import { resetPreferences } from './persistence'
import { useWorkbench } from './useWorkbench'

afterEach(cleanup)

beforeEach(() => {
  resetPreferences()
  cadEngine.replaceDocument(createShowcaseDocument())
})

function Harness() {
  const workbench = useWorkbench()
  return <ModelExplorerPanel workbench={workbench} />
}

describe('shared model map', () => {
  it('selects a complete assembly from the scalable assembly map', () => {
    const assembly = Object.values(cadEngine.getDocument().subassemblies)[0]
    render(<Harness />)

    fireEvent.click(screen.getByTitle(`Select all ${assembly.partIds.length} parts in ${assembly.name}`))

    expect(cadEngine.getSnapshot().selection).toEqual(assembly.partIds)
    expect(screen.getByRole('tab', { name: /SELECTED/ }).textContent).toContain(String(assembly.partIds.length))
  })

  it('finds a placed instance by exact id and puts it under the shared cursor', () => {
    const part = Object.values(cadEngine.getDocument().parts)[4]
    render(<Harness />)

    fireEvent.change(screen.getByLabelText('Search placed model'), { target: { value: part.id } })
    const idLabel = screen.getByText((text) => text.startsWith(`${part.id} ·`))
    fireEvent.click(idLabel.closest('button')!)

    expect(cadEngine.getSnapshot().selection).toEqual([part.id])
    expect((idLabel.closest('button') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true')
  })

  it('locks an assembly through the shared planner and command bus', () => {
    const assembly = Object.values(cadEngine.getDocument().subassemblies).find((item) => !item.locked)!
    const before = cadEngine.getDocument().revision
    render(<Harness />)

    const row = screen
      .getByTitle(`Select all ${assembly.partIds.length} parts in ${assembly.name}`)
      .closest('article')!
    act(() => fireEvent.click(within(row).getByRole('button', { name: 'LOCK' })))

    expect(cadEngine.getDocument().revision).toBe(before + 1)
    expect(cadEngine.getDocument().subassemblies[assembly.id].locked).toBe(true)
    expect(cadEngine.getSnapshot().transactions.at(-1)).toMatchObject({
      author: 'human',
      operations: [{ type: 'subassembly.lock', subassemblyId: assembly.id, locked: true }],
    })
  })

  it('audits agent-authored parts without dumping the whole scene into the DOM', () => {
    const agentParts = Object.values(cadEngine.getDocument().parts).filter((part) => part.provenance === 'agent')
    render(<Harness />)

    fireEvent.click(screen.getByRole('tab', { name: /AGENT/ }))

    expect(screen.getByText(`${agentParts.length} agent-authored part${agentParts.length === 1 ? '' : 's'}`)).toBeVisible()
    expect(document.querySelectorAll('.model-part-row').length).toBeLessThanOrEqual(64)
  })
})
