import React, { useEffect, useRef, useState } from "react"
import type { GroupInfo, GroupChatMessage } from "../lib/workerTypes"

/* ─── Props ───────────────────────────────────────────────────────── */

interface ChatViewProps {
  did: string
  displayName: string
  groups: GroupInfo[]
  messages: Map<string, GroupChatMessage[]>
  logs: string[]
  onCreateGroup: (name: string, memberDids: { did: string; name: string }[]) => void
  onSendMessage: (groupId: string, content: string) => void
  onAddMember: (groupId: string, members: { did: string; name: string }[]) => void
  onRemoveMember: (groupId: string, memberDids: string[]) => void
  onLeaveGroup: (groupId: string) => void
  onDissolveGroup: (groupId: string, reason?: string) => void
  onRotateKey: (groupId: string, reason?: "scheduled" | "compromise" | "policy") => void
}

type ModalType = "create" | "addMember" | "members" | null

/* ─── Icons (inline SVG) ─────────────────────────────────────────── */

const ICON = {
  shield: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  users: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  userPlus: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" />
      <line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" />
    </svg>
  ),
  key: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  ),
  trash: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  ),
  logOut: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
  send: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  ),
  plus: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  x: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  terminal: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  copy: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
  check: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  messageCircle: (s = 40) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  ),
}

/* ─── Helpers ─────────────────────────────────────────────────────── */

const AVATAR_COLORS = [
  "#10b981", "#3b82f6", "#8b5cf6", "#f59e0b",
  "#ef4444", "#06b6d4", "#f97316", "#ec4899",
]

function avatarColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function truncateDid(d: string): string {
  return d.length <= 28 ? d : d.slice(0, 16) + "..." + d.slice(-8)
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

interface MessageGroup {
  senderDid: string
  senderName: string
  isMine: boolean
  messages: GroupChatMessage[]
}

function groupMessages(msgs: GroupChatMessage[], myDid: string): MessageGroup[] {
  const groups: MessageGroup[] = []
  for (const msg of msgs) {
    const last = groups[groups.length - 1]
    if (last && last.senderDid === msg.senderDid) {
      last.messages.push(msg)
    } else {
      groups.push({
        senderDid: msg.senderDid,
        senderName: msg.senderName,
        isMine: msg.senderDid === myDid,
        messages: [msg],
      })
    }
  }
  return groups
}

/* ─── Avatar Component ────────────────────────────────────────────── */

function Avatar({ name, size = "md" }: { name: string; size?: "xs" | "sm" | "md" }): React.ReactElement {
  const cls = size === "xs" ? "avatar avatar-xs" : size === "sm" ? "avatar avatar-sm" : "avatar"
  return (
    <div className={cls} style={{ background: avatarColor(name) }}>
      {initials(name)}
    </div>
  )
}

/* ─── Main Component ──────────────────────────────────────────────── */

export function ChatView({
  did, displayName, groups, messages, logs,
  onCreateGroup, onSendMessage,
  onAddMember, onRemoveMember, onLeaveGroup, onDissolveGroup, onRotateKey,
}: ChatViewProps): React.ReactElement {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [messageInput, setMessageInput] = useState("")
  const [activeModal, setActiveModal] = useState<ModalType>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [newGroupName, setNewGroupName] = useState("")
  const [newMemberDid, setNewMemberDid] = useState("")
  const [newMemberName, setNewMemberName] = useState("")
  const [pendingMembers, setPendingMembers] = useState<{ did: string; name: string }[]>([])
  const [confirmAction, setConfirmAction] = useState<{ type: string; label: string; action: () => void } | null>(null)
  const messagesAreaRef = useRef<HTMLDivElement>(null)
  const logsScrollRef = useRef<HTMLDivElement>(null)

  const selectedGroup = groups.find(g => g.groupId === selectedGroupId)
  const groupMessages = selectedGroupId ? (messages.get(selectedGroupId) || []) : []
  const isGroupActive = selectedGroup && selectedGroup.state !== "DISSOLVED" && selectedGroup.state !== "LEFT"
  const msgGroups = groupMessages.length > 0 ? groupMessages : []

  useEffect(() => {
    const el = messagesAreaRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [groupMessages.length])

  useEffect(() => {
    const el = logsScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs.length])

  useEffect(() => {
    if (!selectedGroupId && groups.length > 0) {
      setSelectedGroupId(groups[0].groupId)
    }
  }, [groups, selectedGroupId])

  const handleSend = (e: React.FormEvent): void => {
    e.preventDefault()
    if (messageInput.trim() && selectedGroupId && isGroupActive) {
      onSendMessage(selectedGroupId, messageInput.trim())
      setMessageInput("")
    }
  }

  const handleAddPendingMember = (): void => {
    if (newMemberDid.trim() && newMemberName.trim()) {
      setPendingMembers(prev => [...prev, { did: newMemberDid.trim(), name: newMemberName.trim() }])
      setNewMemberDid("")
      setNewMemberName("")
    }
  }

  const handleCreateGroup = (): void => {
    if (newGroupName.trim() && pendingMembers.length > 0) {
      onCreateGroup(newGroupName.trim(), pendingMembers)
      setNewGroupName("")
      setPendingMembers([])
      setActiveModal(null)
    }
  }

  const handleAddMemberSubmit = (): void => {
    if (selectedGroupId && pendingMembers.length > 0) {
      onAddMember(selectedGroupId, pendingMembers)
      setPendingMembers([])
      setActiveModal(null)
    }
  }

  const closeModal = (): void => {
    setActiveModal(null)
    setPendingMembers([])
    setNewMemberDid("")
    setNewMemberName("")
    setNewGroupName("")
    setConfirmAction(null)
  }

  const handleCopyDid = (): void => {
    navigator.clipboard.writeText(did)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const stateLabel = (state: string): React.ReactElement | null => {
    switch (state) {
      case "DISSOLVED": return <span className="state-badge dissolved">dissolved</span>
      case "LEFT": return <span className="state-badge left">left</span>
      case "CREATED":
      case "EPOCH_ADVANCING":
      case "UPDATING_KEYS":
        return <span className="state-badge updating">syncing</span>
      default: return null
    }
  }

  /* ─── Render ──────────────────────────────────────────────────── */

  return (
    <div className="chat-layout">
      {/* ── Sidebar ─────────────────────────────────────────────── */}
      <div className="sidebar">
        <div className="sidebar-user">
          <Avatar name={displayName} />
          <div className="sidebar-user-info">
            <div className="sidebar-user-name">{displayName}</div>
            <div className="sidebar-user-did" onClick={handleCopyDid}>
              {copied
                ? <span className="copy-feedback">{ICON.check(12)} Copied</span>
                : <>{ICON.copy(12)} {truncateDid(did)}</>
              }
            </div>
          </div>
        </div>

        <div className="sidebar-section">
          <span className="sidebar-section-label">Groups</span>
          <button className="icon-btn" onClick={() => setActiveModal("create")} data-tooltip="Create Group">
            {ICON.plus(16)}
          </button>
        </div>

        <div className="group-list">
          {groups.length === 0 && (
            <div className="empty-groups">No groups yet</div>
          )}
          {groups.map(g => (
            <div
              key={g.groupId}
              className={`group-item ${selectedGroupId === g.groupId ? "active" : ""} ${g.state === "DISSOLVED" || g.state === "LEFT" ? "inactive" : ""}`}
              onClick={() => setSelectedGroupId(g.groupId)}
            >
              <div className="group-item-avatar" style={{ background: avatarColor(g.name) }}>
                {initials(g.name)}
              </div>
              <div className="group-item-body">
                <div className="group-item-name">
                  {g.name}
                  {stateLabel(g.state)}
                </div>
                <div className="group-item-meta">
                  {g.members.length} member{g.members.length !== 1 && "s"} &middot; Epoch {g.epoch}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <button
            className={`icon-btn ${showLogs ? "active" : ""}`}
            onClick={() => setShowLogs(!showLogs)}
            data-tooltip={showLogs ? "Hide Logs" : "Protocol Logs"}
          >
            {ICON.terminal(16)}
          </button>
        </div>
      </div>

      {/* ── Main Area ───────────────────────────────────────────── */}
      <div className="main-area">
        {showLogs ? (
          <div className="logs-panel">
            <div className="logs-header">
              <div className="logs-dot" />
              <h3>Protocol Logs</h3>
            </div>
            <div className="logs-scroll" ref={logsScrollRef}>
              {logs.map((log, i) => (
                <div key={i} className="log-entry">{log}</div>
              ))}
            </div>
          </div>
        ) : selectedGroup ? (
          <>
            {/* Chat header */}
            <div className="chat-header">
              <div className="chat-header-left">
                <div className="chat-header-icon">{ICON.shield(20)}</div>
                <div className="chat-header-info">
                  <div className="chat-header-name">{selectedGroup.name}</div>
                  <div className="chat-header-meta">
                    <span className="epoch-badge">E{selectedGroup.epoch}</span>
                    <span>{selectedGroup.members.length} member{selectedGroup.members.length !== 1 && "s"}</span>
                    {selectedGroup.isAdmin && <span style={{ color: "var(--purple)" }}>Admin</span>}
                  </div>
                </div>
              </div>
              {isGroupActive && (
                <div className="chat-header-actions">
                  <button className="icon-btn" onClick={() => setActiveModal("members")} data-tooltip="Members">
                    {ICON.users(16)}
                  </button>
                  {selectedGroup.isAdmin && (
                    <>
                      <button className="icon-btn" onClick={() => setActiveModal("addMember")} data-tooltip="Add Member">
                        {ICON.userPlus(16)}
                      </button>
                      <button className="icon-btn" onClick={() => onRotateKey(selectedGroup.groupId, "scheduled")} data-tooltip="Rotate Key">
                        {ICON.key(16)}
                      </button>
                      <button
                        className="icon-btn danger"
                        data-tooltip="Dissolve"
                        onClick={() => setConfirmAction({
                          type: "dissolve",
                          label: `Dissolve "${selectedGroup.name}"? This cannot be undone.`,
                          action: () => { onDissolveGroup(selectedGroup.groupId); setConfirmAction(null) },
                        })}
                      >
                        {ICON.trash(16)}
                      </button>
                    </>
                  )}
                  {!selectedGroup.isAdmin && (
                    <button
                      className="icon-btn danger"
                      data-tooltip="Leave"
                      onClick={() => setConfirmAction({
                        type: "leave",
                        label: `Leave "${selectedGroup.name}"?`,
                        action: () => { onLeaveGroup(selectedGroup.groupId); setConfirmAction(null) },
                      })}
                    >
                      {ICON.logOut(16)}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Messages */}
            <div className="messages-area" ref={messagesAreaRef}>
              {msgGroups.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">{ICON.messageCircle(48)}</div>
                  <div className="empty-state-title">No messages yet</div>
                  <div className="empty-state-text">
                    Send the first message to this encrypted group
                  </div>
                </div>
              ) : (
                groupMessages.length > 0 && groupMessageGroups(groupMessages, did).map((group, gi) => (
                  <div key={gi} className={`msg-group ${group.isMine ? "mine" : "theirs"}`}>
                    <div className="msg-group-header">
                      {!group.isMine && <Avatar name={group.senderName} size="xs" />}
                      <span className="msg-sender-name">
                        {group.isMine ? "You" : group.senderName}
                      </span>
                      <span className="msg-time">
                        {formatTime(group.messages[0].timestamp)}
                      </span>
                    </div>
                    {group.messages.map(msg => (
                      <div key={msg.id} className="msg-bubble">{msg.content}</div>
                    ))}
                  </div>
                ))
              )}
            </div>

            {/* Message input */}
            {isGroupActive ? (
              <form className="message-input-bar" onSubmit={handleSend}>
                <input
                  type="text"
                  value={messageInput}
                  onChange={e => setMessageInput(e.target.value)}
                  placeholder="Type a message..."
                  autoFocus
                />
                <button type="submit" className="send-btn" disabled={!messageInput.trim()}>
                  {ICON.send(16)}
                </button>
              </form>
            ) : (
              <div className="message-input-disabled">
                This group is {selectedGroup.state.toLowerCase()}
              </div>
            )}
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">{ICON.shield(48)}</div>
            <div className="empty-state-title">Select or create a group</div>
            <div className="empty-state-text">
              Start an encrypted conversation with DIDComm v2
            </div>
          </div>
        )}
      </div>

      {/* ── Confirmation Dialog ─────────────────────────────────── */}
      {confirmAction && (
        <div className="modal-overlay" onClick={() => setConfirmAction(null)}>
          <div className="modal modal-confirm" onClick={e => e.stopPropagation()}>
            <p>{confirmAction.label}</p>
            <div className="modal-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmAction(null)}>Cancel</button>
              <button className="btn btn-danger btn-sm" onClick={confirmAction.action}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Group Modal ──────────────────────────────────── */}
      {activeModal === "create" && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Create Group</h2>
            <div className="field">
              <label className="field-label">Group Name</label>
              <input
                type="text"
                className="field-input"
                value={newGroupName}
                onChange={e => setNewGroupName(e.target.value)}
                placeholder="Team Chat"
                autoFocus
              />
            </div>
            <div className="field">
              <label className="field-label">Add Members</label>
              <div className="member-add-row">
                <input
                  type="text"
                  className="field-input"
                  value={newMemberName}
                  onChange={e => setNewMemberName(e.target.value)}
                  placeholder="Name"
                />
                <input
                  type="text"
                  className="field-input mono"
                  value={newMemberDid}
                  onChange={e => setNewMemberDid(e.target.value)}
                  placeholder="did:peer:4..."
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={handleAddPendingMember}
                  disabled={!newMemberDid.trim() || !newMemberName.trim()}
                >
                  Add
                </button>
              </div>
            </div>

            {pendingMembers.length > 0 && (
              <div className="pending-list">
                {pendingMembers.map((m, i) => (
                  <div key={i} className="pending-item">
                    <Avatar name={m.name} size="xs" />
                    <span className="pending-item-name">{m.name}</span>
                    <span className="pending-item-did">{truncateDid(m.did)}</span>
                    <button className="icon-btn danger" onClick={() => setPendingMembers(prev => prev.filter((_, j) => j !== i))}>
                      {ICON.x(14)}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-ghost btn-sm" onClick={closeModal}>Cancel</button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleCreateGroup}
                disabled={!newGroupName.trim() || pendingMembers.length === 0}
              >
                Create Group
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Member Modal ────────────────────────────────────── */}
      {activeModal === "addMember" && selectedGroup && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Add Members to {selectedGroup.name}</h2>
            <div className="field">
              <label className="field-label">New Member</label>
              <div className="member-add-row">
                <input
                  type="text"
                  className="field-input"
                  value={newMemberName}
                  onChange={e => setNewMemberName(e.target.value)}
                  placeholder="Name"
                />
                <input
                  type="text"
                  className="field-input mono"
                  value={newMemberDid}
                  onChange={e => setNewMemberDid(e.target.value)}
                  placeholder="did:peer:4..."
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={handleAddPendingMember}
                  disabled={!newMemberDid.trim() || !newMemberName.trim()}
                >
                  Add
                </button>
              </div>
            </div>

            {pendingMembers.length > 0 && (
              <div className="pending-list">
                {pendingMembers.map((m, i) => (
                  <div key={i} className="pending-item">
                    <Avatar name={m.name} size="xs" />
                    <span className="pending-item-name">{m.name}</span>
                    <span className="pending-item-did">{truncateDid(m.did)}</span>
                    <button className="icon-btn danger" onClick={() => setPendingMembers(prev => prev.filter((_, j) => j !== i))}>
                      {ICON.x(14)}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-ghost btn-sm" onClick={closeModal}>Cancel</button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleAddMemberSubmit}
                disabled={pendingMembers.length === 0}
              >
                Add Members
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Members Modal ───────────────────────────────────────── */}
      {activeModal === "members" && selectedGroup && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Members &mdash; {selectedGroup.name}</h2>
            <div className="members-list">
              {selectedGroup.members.map(m => (
                <div key={m.did} className="member-row">
                  <Avatar name={m.name || truncateDid(m.did)} size="sm" />
                  <div className="member-row-info">
                    <div className="member-row-name">
                      {m.name || truncateDid(m.did)}
                      {m.did === did && <span className="member-row-you">(you)</span>}
                      <span className={`role-badge ${m.role}`}>{m.role}</span>
                    </div>
                    <div className="member-row-did">{truncateDid(m.did)}</div>
                  </div>
                  {selectedGroup.isAdmin && m.did !== did && m.role !== "admin" && (
                    <button
                      className="icon-btn danger"
                      data-tooltip="Remove"
                      onClick={() => { onRemoveMember(selectedGroup.groupId, [m.did]); closeModal() }}
                    >
                      {ICON.x(14)}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="members-footer">
              Epoch {selectedGroup.epoch} &middot; {selectedGroup.epochHash.slice(0, 24)}...
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost btn-sm" onClick={closeModal}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Extracted for readability ───────────────────────────────────── */

function groupMessageGroups(msgs: GroupChatMessage[], myDid: string): MessageGroup[] {
  return groupMessages(msgs, myDid)
}
