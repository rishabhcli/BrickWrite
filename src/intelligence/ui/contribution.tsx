import { Telescope } from 'lucide-react'
import { useRegisterContribution, type WorkbenchApi } from '../../editor/workbench'
import { FindPartsPanel, type PartSearchApi } from './FindPartsPanel'

/**
 * Mounts natural-language part search into the editor's left dock.
 *
 * Zero props, one line in the composition root. It sits below the catalogue
 * palette because the two answer different questions and the palette is the
 * one people reach for first; this is where you go when you cannot name the
 * thing you want.
 *
 * Nothing is fetched by mounting it. The corpus and the four-megabyte latent
 * index are both loaded by the first query, which is why opening the editor
 * costs nothing for a feature most sessions never use.
 */
export function PartSearchContribution() {
  useRegisterContribution({
    id: 'intelligence.find-parts',
    slot: 'panel-left',
    priority: 130,
    title: 'Find parts',
    icon: <Telescope size={11} />,
    render: (api: WorkbenchApi) => <FindPartsPanel api={api satisfies PartSearchApi} />,
  })
  return null
}

export default PartSearchContribution
