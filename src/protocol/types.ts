/**
 * DIDComm v2 Group Messaging Protocol 1.0
 * https://didcomm.org/group-messaging/1.0
 *
 * Message types, body interfaces, and constants per the protocol specification.
 */

// ---------------------------------------------------------------------------
// Protocol base URI
// ---------------------------------------------------------------------------
export const GROUP_PROTOCOL = "https://didcomm.org/group-messaging/1.0"

// ---------------------------------------------------------------------------
// Message type URIs
// ---------------------------------------------------------------------------
export const MSG_CREATE          = `${GROUP_PROTOCOL}/create`
export const MSG_CREATE_ACK      = `${GROUP_PROTOCOL}/create-ack`
export const MSG_MESSAGE         = `${GROUP_PROTOCOL}/message`
export const MSG_DELIVERY        = `${GROUP_PROTOCOL}/delivery`
export const MSG_ADD_MEMBER      = `${GROUP_PROTOCOL}/add-member`
export const MSG_ADD_MEMBER_ACK  = `${GROUP_PROTOCOL}/add-member-ack`
export const MSG_REMOVE_MEMBER     = `${GROUP_PROTOCOL}/remove-member`
export const MSG_REMOVE_MEMBER_ACK = `${GROUP_PROTOCOL}/remove-member-ack`
export const MSG_KEY_ROTATE      = `${GROUP_PROTOCOL}/key-rotate`
export const MSG_KEY_ROTATE_ACK  = `${GROUP_PROTOCOL}/key-rotate-ack`
export const MSG_LEAVE           = `${GROUP_PROTOCOL}/leave`
export const MSG_LEAVE_ACK       = `${GROUP_PROTOCOL}/leave-ack`
export const MSG_INFO_REQUEST    = `${GROUP_PROTOCOL}/info-request`
export const MSG_INFO            = `${GROUP_PROTOCOL}/info`
export const MSG_DISSOLVE        = `${GROUP_PROTOCOL}/dissolve`
export const MSG_DISSOLVE_ACK    = `${GROUP_PROTOCOL}/dissolve-ack`

// ---------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------

/** Member entry with role designation */
export interface MemberEntry {
  did: string
  role: "admin" | "member"
  /** Display name — not in spec but needed for UI */
  name?: string
}

/** Group Content Key transport format (JWK-like) */
export interface GCKTransport {
  /** Base64url-encoded raw AES-256 key bytes */
  k: string
  /** Algorithm identifier — MUST be "A256GCM" */
  alg: "A256GCM"
}

/** Group policy configuration */
export interface GroupPolicy {
  member_can_invite: boolean
  member_can_leave: boolean
  rotation_period_seconds: number
  rotation_period_messages: number
  max_members: number
}

/** Default policy values per spec */
export const DEFAULT_POLICY: GroupPolicy = {
  member_can_invite: false,
  member_can_leave: true,
  rotation_period_seconds: 604800,
  rotation_period_messages: 100,
  max_members: 256,
}

/** Group mediator configuration */
export interface GroupMediatorConfig {
  did: string
  endpoint: string
}

// ---------------------------------------------------------------------------
// Message body interfaces
// ---------------------------------------------------------------------------

/** create — sent by admin to each initial member via pairwise authcrypt */
export interface CreateBody {
  group_id: string
  name?: string
  epoch: number
  members: MemberEntry[]
  gck: GCKTransport
  policy?: GroupPolicy
  group_mediator?: GroupMediatorConfig
}

/** create-ack — sent by member to admin confirming receipt */
export interface CreateAckBody {
  group_id: string
  status: "accepted" | "rejected"
}

/** message — the inner plaintext group message (encrypted with GCK before transport) */
export interface GroupMessageBody {
  content: string
}

/**
 * delivery — the transport envelope wrapping a GCK-encrypted group message.
 * Sent via DIDComm v2 anoncrypt to each recipient.
 */
export interface DeliveryBody {
  group_id: string
  epoch: number
  sender: string
  ciphertext: string
  iv: string
  tag: string
}

/** add-member — sent by admin to existing members when adding new members */
export interface AddMemberBody {
  group_id: string
  epoch: number
  added: MemberEntry[]
  members: MemberEntry[]
  gck: GCKTransport
  epoch_hash: string
}

/** add-member-ack */
export interface AddMemberAckBody {
  group_id: string
  epoch: number
  status: "accepted"
}

/** remove-member — sent by admin to remaining members */
export interface RemoveMemberBody {
  group_id: string
  epoch: number
  removed: string[]
  members: MemberEntry[]
  gck: GCKTransport
  epoch_hash: string
}

/** remove-member notification to the removed member (no GCK, no epoch, no members) */
export interface RemoveMemberNotifyBody {
  group_id: string
  removed: string[]
}

/** remove-member-ack */
export interface RemoveMemberAckBody {
  group_id: string
  epoch: number
  status: "accepted"
}

/** key-rotate — sent by admin to all members to advance epoch */
export interface KeyRotateBody {
  group_id: string
  epoch: number
  reason?: "scheduled" | "compromise" | "policy"
  gck: GCKTransport
  epoch_hash: string
}

/** key-rotate-ack */
export interface KeyRotateAckBody {
  group_id: string
  epoch: number
  status: "accepted"
}

/** leave — sent by departing member to all other members */
export interface LeaveBody {
  group_id: string
}

/** leave-ack */
export interface LeaveAckBody {
  group_id: string
  status: "acknowledged"
}

/** info-request — query current group state */
export interface InfoRequestBody {
  group_id: string
  known_epoch?: number
}

/** info — response with current group state */
export interface InfoBody {
  group_id: string
  name?: string
  epoch: number
  members: MemberEntry[]
  gck: GCKTransport
  policy?: GroupPolicy
  epoch_hash: string
  group_mediator?: GroupMediatorConfig
}

/** dissolve — sent by admin to permanently end the group */
export interface DissolveBody {
  group_id: string
  reason?: string
}

/** dissolve-ack */
export interface DissolveAckBody {
  group_id: string
  status: "acknowledged"
}
