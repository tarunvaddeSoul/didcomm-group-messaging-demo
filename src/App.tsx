import React from "react"
import { useDIDComm } from "./hooks/useDIDComm"
import { ConnectScreen } from "./components/ConnectScreen"
import { ChatView } from "./components/ChatView"

export function App(): React.ReactElement {
  const {
    state, did, displayName, groups, messages, logs,
    connect, createGroup, sendMessage,
    addMember, removeMember, leaveGroup, dissolveGroup, rotateGroupKey,
  } = useDIDComm()

  if (state === "idle" || state === "connecting" || state === "error") {
    return (
      <>
        <ConnectScreen
          onConnect={connect}
          isConnecting={state === "connecting"}
        />
        {state === "error" && (
          <div className="error-banner">
            Connection failed. Check the mediator DID and try again.
          </div>
        )}
      </>
    )
  }

  return (
    <ChatView
      did={did}
      displayName={displayName}
      groups={groups}
      messages={messages}
      logs={logs.map(l => `[${new Date(l.timestamp).toLocaleTimeString()}] ${l.message}`)}
      onCreateGroup={createGroup}
      onSendMessage={sendMessage}
      onAddMember={addMember}
      onRemoveMember={removeMember}
      onLeaveGroup={leaveGroup}
      onDissolveGroup={dissolveGroup}
      onRotateKey={rotateGroupKey}
    />
  )
}
