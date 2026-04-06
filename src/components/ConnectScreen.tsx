import React, { useState } from "react"

interface ConnectScreenProps {
  onConnect: (mediatorDid: string, displayName: string) => void
  isConnecting: boolean
}

const DEFAULT_MEDIATOR = "did:web:us-east2.public.mediator.indiciotech.io"

const ShieldLockIcon = (): React.ReactElement => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <rect x="9" y="10.5" width="6" height="5" rx="1" />
    <path d="M10 10.5V9a2 2 0 0 1 4 0v1.5" />
  </svg>
)

export function ConnectScreen({ onConnect, isConnecting }: ConnectScreenProps): React.ReactElement {
  const [mediatorDid, setMediatorDid] = useState(DEFAULT_MEDIATOR)
  const [displayName, setDisplayName] = useState("")

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (mediatorDid.trim() && displayName.trim()) {
      onConnect(mediatorDid.trim(), displayName.trim())
    }
  }

  const canSubmit = mediatorDid.trim() && displayName.trim() && !isConnecting

  return (
    <div className="connect-screen">
      <div className="connect-card">
        <div className="connect-brand">
          <div className="connect-icon">
            <ShieldLockIcon />
          </div>
          <h1>DIDComm Group Chat</h1>
          <p className="connect-subtitle">
            Decentralized, end-to-end encrypted messaging
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label className="field-label">Display Name</label>
            <input
              type="text"
              className="field-input"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Enter your name"
              disabled={isConnecting}
              autoFocus
            />
          </div>
          <div className="field">
            <label className="field-label">Mediator DID</label>
            <input
              type="text"
              className="field-input mono"
              value={mediatorDid}
              onChange={e => setMediatorDid(e.target.value)}
              placeholder="did:web:mediator.example.com"
              disabled={isConnecting}
            />
          </div>
          <button type="submit" className="btn-connect" disabled={!canSubmit}>
            {isConnecting && <span className="spinner" />}
            {isConnecting ? "Establishing secure channel..." : "Connect"}
          </button>
        </form>

        <div className="connect-footer">
          DIDComm v2 &middot; Coordinate Mediation 3.0
        </div>
      </div>
    </div>
  )
}
