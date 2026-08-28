import { Cloud } from 'lucide-react'
import { useRegisterContribution, type WorkbenchApi } from '../editor/workbench'
import { CloudSyncProvider } from './CloudSyncProvider'
import { CloudProjectsPanel } from './ProjectsPanel'
import { CloudSyncStatus } from './SyncStatus'
import { CloudVersionHistory } from './VersionHistory'
import { VERSION_HISTORY_MODAL_ID, type CloudWorkbenchApi } from './surface'

/**
 * The cloud layer's surfaces, mounted into the editor shell.
 *
 * One zero-prop component for the composition root to list, because all three
 * surfaces share one runtime and a provider cannot wrap them from a slot — the
 * shell renders each slot's content where the slot lives, not where the
 * contribution was declared. So the provider is mounted here, above the
 * registrations, and each surface reads the runtime through it.
 *
 * `WorkbenchApi` is passed straight through to `CloudWorkbenchApi`, which is
 * the subset these panels use. TypeScript checks the two agree at this line and
 * nowhere else, which is what keeps the panels testable without the editor.
 */
export function CloudProjectsContribution() {
  return (
    <CloudSyncProvider>
      <CloudSyncStatusContribution />
      <CloudProjectsPanelContribution />
      <CloudVersionHistoryContribution />
    </CloudSyncProvider>
  )
}

export function CloudSyncStatusContribution() {
  useRegisterContribution({
    id: 'cloud.sync-status',
    slot: 'status',
    priority: 120,
    title: 'Cloud',
    render: (api: WorkbenchApi) => <CloudSyncStatus api={api satisfies CloudWorkbenchApi} />,
  })
  return null
}

export function CloudProjectsPanelContribution() {
  useRegisterContribution({
    id: 'cloud.projects',
    slot: 'panel-left',
    priority: 120,
    title: 'Projects',
    icon: <Cloud size={11} />,
    render: (api: WorkbenchApi) => <CloudProjectsPanel api={api satisfies CloudWorkbenchApi} />,
  })
  return null
}

export function CloudVersionHistoryContribution() {
  useRegisterContribution({
    id: VERSION_HISTORY_MODAL_ID,
    slot: 'modal',
    priority: 120,
    title: 'Version history',
    render: (api: WorkbenchApi) => <CloudVersionHistory api={api satisfies CloudWorkbenchApi} />,
  })
  return null
}

export default CloudProjectsContribution
