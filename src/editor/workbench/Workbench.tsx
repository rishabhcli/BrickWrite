import React from 'react'
import { Toolbar } from './Toolbar'
import { Panels } from './Panels'
import { Inspector } from './Inspector'
import { Modal } from './Modal'
import { StatusBar } from './StatusBar'
import { ExtensionRegistryProvider } from './ExtensionRegistry'

/**
 * Top‑level workbench component. It currently renders a minimal layout that
 * includes the extensible UI slots (toolbar, panels, inspector, modal, status
 * bar). The actual editor implementation will be wired here later.
 */
export const Workbench: React.FC = () => {
  return (
    <ExtensionRegistryProvider>
      <div className="workbench-root" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <Toolbar />
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <Panels />
          <Inspector />
        </div>
        <StatusBar />
        <Modal />
      </div>
    </ExtensionRegistryProvider>
  )
}
