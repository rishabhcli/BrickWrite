import { useEffect, useMemo } from 'react'
import { Cloud } from 'lucide-react'
import { useRegisterContribution, type WorkbenchApi } from '../editor/workbench'
import { browserCloudRuntime } from './browserRuntime'
import { CloudSyncProvider } from './CloudSyncProvider'
import { CloudProjectsPanel } from './ProjectsPanel'
import type { CloudRuntime } from './runtime'
import { CloudSyncStatus } from './SyncStatus'
import { CloudVersionHistory } from './VersionHistory'
import { VERSION_HISTORY_MODAL_ID, type CloudWorkbenchApi } from './surface'

/**
 * The cloud layer's surfaces, mounted into the editor shell.
 *
 * One zero-prop component for the composition root to list. It resolves the
 * runtime once and hands the same instance to all three registrations, so the
 * status line, the panel and the dialog can never disagree about whether there
 * is a deployment or who is signed in.
 *
 * Each `render` re-provides that runtime around its own subtree, because the
 * shell draws a slot's content where the *slot* lives — not where the
 * contribution was declared — so a provider mounted here would not be an
 * ancestor of anything the slots render. Only the outer provider owns the
 * runtime's lifetime; the ones inside `render` are pure context.
 *
 * `WorkbenchApi` is passed straight through as `CloudWorkbenchApi`, the subset
 * these panels use. TypeScript checks the two agree at these four lines and
 * nowhere else, which is what keeps the panels testable without the editor.
 */
export function CloudProjectsContribution({ runtime }: { runtime?: CloudRuntime } = {}) {
  const resolved = useCloudRuntimeInstance(runtime)
  return (
    <CloudSyncProvider runtime={resolved}>
      <CloudSyncStatusContribution runtime={resolved} />
      <CloudProjectsPanelContribution runtime={resolved} />
      <CloudVersionHistoryContribution runtime={resolved} />
    </CloudSyncProvider>
  )
}

export function CloudSyncStatusContribution({ runtime }: { runtime?: CloudRuntime } = {}) {
  const resolved = useCloudRuntimeInstance(runtime)
  useRegisterContribution({
    id: 'cloud.sync-status',
    slot: 'status',
    priority: 120,
    title: 'Cloud',
    render: (api: WorkbenchApi) => (
      <CloudSyncProvider runtime={resolved} lifecycle={false}>
        <CloudSyncStatus api={api satisfies CloudWorkbenchApi} />
      </CloudSyncProvider>
    ),
  })
  return null
}

export function CloudProjectsPanelContribution({ runtime }: { runtime?: CloudRuntime } = {}) {
  const resolved = useCloudRuntimeInstance(runtime)
  useRegisterContribution({
    id: 'cloud.projects',
    slot: 'panel-left',
    priority: 120,
    title: 'Projects',
    icon: <Cloud size={11} />,
    render: (api: WorkbenchApi) => (
      <CloudSyncProvider runtime={resolved} lifecycle={false}>
        <CloudProjectsPanel api={api satisfies CloudWorkbenchApi} />
      </CloudSyncProvider>
    ),
  })
  return null
}

export function CloudVersionHistoryContribution({ runtime }: { runtime?: CloudRuntime } = {}) {
  const resolved = useCloudRuntimeInstance(runtime)
  useRegisterContribution({
    id: VERSION_HISTORY_MODAL_ID,
    slot: 'modal',
    priority: 120,
    title: 'Version history',
    render: (api: WorkbenchApi) => (
      <CloudSyncProvider runtime={resolved} lifecycle={false}>
        <CloudVersionHistory api={api satisfies CloudWorkbenchApi} />
      </CloudSyncProvider>
    ),
  })
  return null
}

/**
 * The runtime for a contribution, and its browser lifetime while mounted alone.
 *
 * `start()` is reference counted, so calling it from every contribution is
 * correct whether they were mounted together by `CloudProjectsContribution` or
 * one at a time by somebody composing their own shell.
 */
function useCloudRuntimeInstance(runtime?: CloudRuntime): CloudRuntime {
  const resolved = useMemo(() => runtime ?? browserCloudRuntime(), [runtime])
  useEffect(() => resolved.start(), [resolved])
  return resolved
}

export default CloudProjectsContribution
