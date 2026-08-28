import React, { useState } from 'react'
import { CredentialSignIn, CredentialSignUp, useUser } from '@hexclave/react'

/** Auth modal that allows sign‑in or sign‑up with email/password */
export const Modal: React.FC = () => {
  const { user } = useUser()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn')

  // If a user is already authenticated we don't render the modal
  if (user) return null

  // When closed, show a simple button to open the auth flow
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ margin: '0.5rem' }}>
        Sign In / Sign Up
      </button>
    )
  }

  return (
    <div className="workbench-modal" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', padding: '2rem', borderRadius: '4px', position: 'relative', minWidth: '300px' }}>
        <button onClick={() => setOpen(false)} style={{ position: 'absolute', top: 8, right: 8 }}>✕</button>
        <div style={{ marginBottom: '1rem' }}>
          <button onClick={() => setMode('signIn')} disabled={mode === 'signIn'} style={{ marginRight: '0.5rem' }}>Sign In</button>
          <button onClick={() => setMode('signUp')} disabled={mode === 'signUp'}>Sign Up</button>
        </div>
        {mode === 'signIn' ? <CredentialSignIn /> : <CredentialSignUp />}
      </div>
    </div>
  )
}
