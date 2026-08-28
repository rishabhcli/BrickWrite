import { useEffect, useMemo } from 'react'
import { useRegisterContribution } from '../editor/workbench'
import { AgentWorkbench } from './AgentWorkbench'
import { AgentSession } from './session'

/**
 * Mounts the design partner into the editor shell.
 *
 * The session is created once per mount and lives above the panel, so the
 * conversation survives the dock collapsing, the slot re-rendering, or the
 * operator switching inspector tabs. A session recreated on every render would
 * lose the transcript exactly when someone stopped to look at the model — which
 * is the moment the conversation matters most.
 */
export function AgentWorkbenchContribution() {
  const session = useMemo(() => new AgentSession(), [])
  useEffect(() => () => session.dispose(), [session])

  useRegisterContribution({
    id: 'agent.workbench',
    slot: 'panel-right',
    priority: 120,
    title: 'Design partner',
    render: () => <AgentWorkbench session={session} />,
  })

  return null
}

export default AgentWorkbenchContribution
