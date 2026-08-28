import React, { createContext, useContext, useState, ReactNode } from 'react'

/**
 * Simple extension registry allowing workbench components to register UI extensions.
 * Extensions are stored as React nodes keyed by a string identifier.
 */
interface Registry {
  [key: string]: ReactNode
}

interface ContextValue {
  register: (slot: string, component: ReactNode) => void
  unregister: (slot: string) => void
  get: (slot: string) => ReactNode | undefined
}

const ExtensionRegistryContext = createContext<ContextValue | undefined>(undefined)

export const ExtensionRegistryProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [registry, setRegistry] = useState<Registry>({})

  const register = (slot: string, component: ReactNode) => {
    setRegistry(prev => ({ ...prev, [slot]: component }))
  }
  const unregister = (slot: string) => {
    setRegistry(prev => {
      const { [slot]: _, ...rest } = prev
      return rest
    })
  }
  const get = (slot: string) => registry[slot]

  return (
    <ExtensionRegistryContext.Provider value={{ register, unregister, get }}>
      {children}
    </ExtensionRegistryContext.Provider>
  )
}

export const useExtensionRegistry = () => {
  const ctx = useContext(ExtensionRegistryContext)
  if (!ctx) throw new Error('useExtensionRegistry must be used within ExtensionRegistryProvider')
  return ctx
}
