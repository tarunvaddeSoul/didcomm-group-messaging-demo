import type { MemberEntry, GroupPolicy } from "../protocol/types"

// ---------------------------------------------------------------------------
// Commands: main thread → worker
// ---------------------------------------------------------------------------

export type WorkerCommandType =
  | "init"
  | "establishMediation"
  | "connect"
  | "disconnect"
  | "sendMessage"
  | "pickupStatus"
  | "createGroup"
  | "sendGroupMessage"
  | "addMember"
  | "removeMember"
  | "leaveGroup"
  | "dissolveGroup"
  | "rotateGroupKey"
  | "requestGroupInfo"

export interface WorkerCommand<T> {
  type: WorkerCommandType
  payload: T
}

// ---------------------------------------------------------------------------
// Messages: worker → main thread
// ---------------------------------------------------------------------------

export type WorkerMessageType =
  | "init"
  | "log"
  | "didGenerated"
  | "messageReceived"
  | "connected"
  | "disconnected"
  | "error"
  // Group lifecycle
  | "groupCreated"
  | "groupMessageReceived"
  | "groupMessageSent"
  | "memberAdded"
  | "memberRemoved"
  | "memberLeft"
  | "groupDissolved"
  | "keyRotated"
  | "groupInfoReceived"
  | "groupStateChanged"

export interface WorkerMessage<T> {
  type: WorkerMessageType
  payload: T
}

// ---------------------------------------------------------------------------
// Group protocol types (shared between worker and UI)
// ---------------------------------------------------------------------------

/** Admin / Member state machine states per spec */
export type AdminGroupState = "CREATED" | "ACTIVE" | "EPOCH_ADVANCING" | "DISSOLVED"
export type MemberGroupState = "INVITED" | "ACTIVE" | "UPDATING_KEYS" | "LEFT"

export interface GroupMember {
  did: string
  role: "admin" | "member"
  name?: string
}

export interface GroupInfo {
  groupId: string
  name: string
  adminDid: string
  members: GroupMember[]
  epoch: number
  epochHash: string
  state: AdminGroupState | MemberGroupState
  policy: GroupPolicy
  /** Whether the local agent is admin of this group */
  isAdmin: boolean
}

export interface GroupChatMessage {
  id: string
  groupId: string
  senderDid: string
  senderName: string
  content: string
  timestamp: number
  epoch: number
}

// ---------------------------------------------------------------------------
// Command payloads
// ---------------------------------------------------------------------------

export interface CreateGroupPayload {
  name: string
  memberDids: { did: string; name: string }[]
  policy?: Partial<GroupPolicy>
}

export interface AddMemberPayload {
  groupId: string
  members: { did: string; name: string }[]
}

export interface RemoveMemberPayload {
  groupId: string
  memberDids: string[]
}

export interface LeaveGroupPayload {
  groupId: string
}

export interface DissolveGroupPayload {
  groupId: string
  reason?: string
}

export interface RotateGroupKeyPayload {
  groupId: string
  reason?: "scheduled" | "compromise" | "policy"
}

export interface RequestGroupInfoPayload {
  groupId: string
  targetDid?: string
}

export interface SendGroupMessagePayload {
  groupId: string
  content: string
}
