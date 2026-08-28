import React from 'react'
import { verifyToken } from '../../functions/share/token'

// wouter passes route params as a prop named `params`
export default function SharePage({ params }: { params: { slug: string } }) {
  const { slug } = params
  const valid = verifyToken(slug)

  return (
    <main className="share-page" style={{ padding: '2rem' }}>
      {valid ? (
        <div>
          <h1>Shared Project</h1>
          <p>Token is valid. Load the shared project snapshot here.</p>
          {/* Placeholder – actual loading logic to be implemented */}
        </div>
      ) : (
        <div>
          <h1>Invalid Share Link</h1>
          <p>The share token is missing, malformed, or expired.</p>
        </div>
      )}
    </main>
  )
}
