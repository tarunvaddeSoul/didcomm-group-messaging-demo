import { DIDCommService, DID } from "./didcomm"
import { IMessage } from "didcomm"
import {
  WorkerCommand, WorkerMessage,
  GroupInfo, GroupChatMessage, GroupMember,
  CreateGroupPayload, AddMemberPayload, RemoveMemberPayload,
  LeaveGroupPayload, DissolveGroupPayload, RotateGroupKeyPayload,
  RequestGroupInfoPayload, SendGroupMessagePayload,
  AdminGroupState, MemberGroupState,
} from "./workerTypes"
import {
  MSG_CREATE, MSG_CREATE_ACK, MSG_DELIVERY,
  MSG_ADD_MEMBER, MSG_ADD_MEMBER_ACK,
  MSG_REMOVE_MEMBER, MSG_REMOVE_MEMBER_ACK,
  MSG_KEY_ROTATE, MSG_KEY_ROTATE_ACK,
  MSG_LEAVE, MSG_LEAVE_ACK,
  MSG_INFO_REQUEST, MSG_INFO,
  MSG_DISSOLVE, MSG_DISSOLVE_ACK,
  DEFAULT_POLICY,
  type MemberEntry, type GCKTransport, type GroupPolicy,
  type CreateBody, type CreateAckBody,
  type DeliveryBody,
  type AddMemberBody, type AddMemberAckBody,
  type RemoveMemberBody, type RemoveMemberNotifyBody, type RemoveMemberAckBody,
  type KeyRotateBody, type KeyRotateAckBody,
  type LeaveBody, type LeaveAckBody,
  type InfoRequestBody, type InfoBody,
  type DissolveBody, type DissolveAckBody,
} from "../protocol/types"
import {
  generateGCK, exportGCK, importGCK,
  encryptWithGCK, decryptWithGCK,
  computeEpochHash, gckFingerprint,
} from "../protocol/crypto"
import { v4 as uuidv4 } from "uuid"

const ctx: Worker = self as any

// ---------------------------------------------------------------------------
// Internal group state
// ---------------------------------------------------------------------------

interface GroupState {
  groupId: string
  name: string
  adminDid: string
  members: MemberEntry[]
  epoch: number
  gck: CryptoKey
  gckBase64: string
  epochHash: string
  policy: GroupPolicy
  /** State machine state */
  state: AdminGroupState | MemberGroupState
  /** Whether the local agent is admin */
  isAdmin: boolean
  /** Old GCKs for grace-window decryption (epoch → key) */
  oldGcks: Map<number, CryptoKey>
  /** Queued messages with future epochs */
  queuedMessages: IMessage[]
  /** Message count since last key rotation (for rotation_period_messages policy) */
  messagesSinceRotation: number
}

// ---------------------------------------------------------------------------
// Pending WS reply tracking
// ---------------------------------------------------------------------------

interface PendingReply {
  resolve: (message: IMessage) => void
  reject: (error: Error) => void
  expectedTypes: string[]
  timer: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// Worker implementation
// ---------------------------------------------------------------------------

class DIDCommWorker {
  private didcomm!: DIDCommService
  private didForMediator: string = ""
  private routingDid: string = ""
  private mediatorDid: string = ""
  private did: string = ""
  private displayName: string = ""
  private ws: WebSocket | null = null
  private groups: Map<string, GroupState> = new Map()
  private processedMessageIds: Set<string> = new Set()
  private pendingReplies: PendingReply[] = []

  init(): void {
    this.didcomm = new DIDCommService()
    this.post({ type: "init", payload: {} })
    this.log("Worker initialized")
  }

  // =========================================================================
  // WebSocket send helpers
  // =========================================================================

  private sendWsAndExpectReply(packed: string, expectedTypes: string[], timeoutMs = 15000): Promise<IMessage> {
    return new Promise<IMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies = this.pendingReplies.filter(p => p !== pending)
        reject(new Error(`Timeout waiting for reply (expected: ${expectedTypes.join(", ")})`))
      }, timeoutMs)

      const pending: PendingReply = { resolve, reject, expectedTypes, timer }
      this.pendingReplies.push(pending)

      this.ws!.send(packed)
    })
  }

  private async sendAndExpectReply(to: DID, from: DID, message: any, expectedTypes: string[]): Promise<IMessage> {
    const [, packed] = await this.didcomm.prepareMessage(to, from, message)
    return this.sendWsAndExpectReply(packed, expectedTypes)
  }

  private async sendOverWs(to: DID, from: DID, message: any): Promise<void> {
    const [, packed] = await this.didcomm.prepareMessage(to, from, message)
    this.ws!.send(packed)
  }

  private async sendViaHttp(to: DID, from: DID, message: any): Promise<void> {
    await this.didcomm.sendMessage(to, from, message)
  }

  // =========================================================================
  // WebSocket connection
  // =========================================================================

  private connectWs(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl)

      this.ws.onopen = () => {
        this.log("WebSocket connected")
        resolve()
      }

      this.ws.onerror = () => {
        this.log("WebSocket error")
        reject(new Error("WebSocket connection failed"))
      }

      this.ws.onclose = () => {
        this.log("WebSocket closed")
        for (const p of this.pendingReplies) {
          clearTimeout(p.timer)
          p.reject(new Error("WebSocket closed"))
        }
        this.pendingReplies = []
        this.post({ type: "disconnected", payload: {} })
      }

      this.ws.onmessage = async (event: MessageEvent<Blob>) => {
        try {
          const text = typeof event.data === "string" ? event.data : await event.data.text()
          await this.handlePackedMessage(text)
        } catch (err) {
          console.error("[Worker] Error handling WS message:", err)
        }
      }
    })
  }

  // =========================================================================
  // Mediation flow (Coordinate Mediation 3.0 + Pickup 3.0)
  // =========================================================================

  async establishMediation({ mediatorDid, displayName }: { mediatorDid: string; displayName: string }): Promise<void> {
    try {
    this.displayName = displayName
    this.mediatorDid = mediatorDid
    this.log(`Establishing mediation with: ${mediatorDid}`)

    this.didForMediator = await this.didcomm.generateDidForMediator()
    this.log(`Generated DID for mediator: ${this.didForMediator.slice(0, 30)}...`)

    // Step 1: Connect WebSocket
    const endpoint = await this.didcomm.wsEndpoint(mediatorDid)
    this.log(`Connecting to: ${endpoint.service_endpoint}`)
    await this.connectWs(endpoint.service_endpoint)

    // Step 2: mediate-request → mediate-grant
    this.log("Sending mediate-request...")
    const grant = await this.sendAndExpectReply(
      mediatorDid, this.didForMediator,
      { type: "https://didcomm.org/coordinate-mediation/3.0/mediate-request" },
      ["https://didcomm.org/coordinate-mediation/3.0/mediate-grant"]
    )
    this.log("Received mediate-grant")

    const routingDid = grant.body.routing_did[0]
    this.routingDid = routingDid
    this.log(`Routing DID: ${routingDid.slice(0, 30)}...`)

    // Step 3: Generate routed DID
    this.did = await this.didcomm.generateDid(routingDid)
    this.log(`Generated routed DID: ${this.did.slice(0, 30)}...`)

    // Step 4: Register DID with mediator
    this.log("Registering DID with mediator...")
    const updateReply = await this.sendAndExpectReply(
      mediatorDid, this.didForMediator,
      {
        type: "https://didcomm.org/coordinate-mediation/3.0/recipient-update",
        body: {
          updates: [{ recipient_did: this.did, action: "add" }],
        },
      },
      ["https://didcomm.org/coordinate-mediation/3.0/recipient-update-response"]
    )

    if (updateReply.body.updated[0]?.result !== "success") {
      throw new Error(`Recipient update failed: ${JSON.stringify(updateReply.body)}`)
    }
    this.log("DID registered with mediator")

    // Step 5: Enable live delivery
    this.log("Enabling live delivery...")
    await this.sendOverWs(
      mediatorDid, this.didForMediator,
      {
        type: "https://didcomm.org/messagepickup/3.0/live-delivery-change",
        body: { live_delivery: true },
      }
    )

    // Step 6: Pickup queued messages
    this.log("Requesting message pickup status...")
    const status = await this.sendAndExpectReply(
      mediatorDid, this.didForMediator,
      { type: "https://didcomm.org/messagepickup/3.0/status-request", body: {} },
      ["https://didcomm.org/messagepickup/3.0/status"]
    )
    if (status.body.message_count > 0) {
      this.log(`${status.body.message_count} queued messages, requesting delivery...`)
      await this.requestDelivery(status.body.message_count)
    }

    this.post({ type: "didGenerated", payload: { did: this.did, displayName } })
    this.post({ type: "connected", payload: {} })
    this.log("Mediation established and connected!")
    } catch (err) {
      this.log(`Mediation failed: ${err}`)
      this.post({ type: "error", payload: { message: `Mediation failed: ${err}` } })
    }
  }

  private async requestDelivery(count: number): Promise<void> {
    const delivery = await this.sendAndExpectReply(
      this.mediatorDid, this.didForMediator,
      {
        type: "https://didcomm.org/messagepickup/3.0/delivery-request",
        body: { limit: count },
      },
      ["https://didcomm.org/messagepickup/3.0/delivery", "https://didcomm.org/messagepickup/3.0/status"]
    )
    if (delivery.type === "https://didcomm.org/messagepickup/3.0/delivery") {
      await this.processDelivery(delivery)
    }
  }

  private async processDelivery(delivery: IMessage): Promise<void> {
    const received: string[] = []
    for (const attachment of delivery.attachments || []) {
      if (attachment.id) received.push(attachment.id)
      if ("base64" in attachment.data) {
        const bytes = Uint8Array.from(
          globalThis.atob(attachment.data.base64),
          c => c.charCodeAt(0)
        )
        await this.handlePackedMessage(new TextDecoder().decode(bytes))
      } else if ("json" in attachment.data) {
        await this.handlePackedMessage(JSON.stringify(attachment.data.json))
      }
    }
    if (received.length > 0) {
      const status = await this.sendAndExpectReply(
        this.mediatorDid, this.didForMediator,
        {
          type: "https://didcomm.org/messagepickup/3.0/messages-received",
          body: { message_id_list: received },
        },
        ["https://didcomm.org/messagepickup/3.0/status"]
      )
      if (status.body.message_count > 0) {
        await this.requestDelivery(status.body.message_count)
      }
    }
  }

  async disconnect(): Promise<void> {
    this.ws?.close()
    this.ws = null
  }

  // =========================================================================
  // Message dispatch
  // =========================================================================

  private async handlePackedMessage(packed: string): Promise<void> {
    const [msg] = await this.didcomm.unpackMessage(packed)
    const message = msg.as_value()
    this.log(`Received: ${message.type.split("/").pop()} from=${(message.from || "anon").slice(0, 30)}...`)
    await this.handleMessage(message)
  }

  private async handleMessage(message: IMessage): Promise<void> {
    // Check pending replies first
    const pendingIdx = this.pendingReplies.findIndex(p =>
      p.expectedTypes.includes(message.type)
    )
    if (pendingIdx >= 0) {
      const pending = this.pendingReplies[pendingIdx]
      this.pendingReplies.splice(pendingIdx, 1)
      clearTimeout(pending.timer)
      pending.resolve(message)
      return
    }

    // Guard: ignore group protocol messages from ourselves (mediator echo)
    if (message.from === this.did && message.type.startsWith("https://didcomm.org/group-messaging/")) {
      this.log(`Ignoring self-sent message: ${message.type.split("/").pop()}`)
      return
    }

    // Route by message type
    switch (message.type) {
      // Mediator protocols
      case "https://didcomm.org/messagepickup/3.0/status":
        if (message.body.message_count > 0) {
          await this.requestDelivery(message.body.message_count)
        }
        break

      case "https://didcomm.org/messagepickup/3.0/delivery":
        await this.processDelivery(message)
        break

      // Group messaging protocol
      case MSG_CREATE:
        await this.handleCreate(message)
        break

      case MSG_CREATE_ACK:
        await this.handleCreateAck(message)
        break

      case MSG_DELIVERY:
        await this.handleDelivery(message)
        break

      case MSG_ADD_MEMBER:
        await this.handleAddMember(message)
        break

      case MSG_ADD_MEMBER_ACK:
        await this.handleAddMemberAck(message)
        break

      case MSG_REMOVE_MEMBER:
        await this.handleRemoveMember(message)
        break

      case MSG_REMOVE_MEMBER_ACK:
        await this.handleRemoveMemberAck(message)
        break

      case MSG_KEY_ROTATE:
        await this.handleKeyRotate(message)
        break

      case MSG_KEY_ROTATE_ACK:
        await this.handleKeyRotateAck(message)
        break

      case MSG_LEAVE:
        await this.handleLeave(message)
        break

      case MSG_LEAVE_ACK:
        await this.handleLeaveAck(message)
        break

      case MSG_INFO_REQUEST:
        await this.handleInfoRequest(message)
        break

      case MSG_INFO:
        await this.handleInfo(message)
        break

      case MSG_DISSOLVE:
        await this.handleDissolve(message)
        break

      case MSG_DISSOLVE_ACK:
        await this.handleDissolveAck(message)
        break

      default:
        this.log(`Unhandled message type: ${message.type}`)
        break
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /** Convert internal GroupState to GroupInfo for the UI */
  private toGroupInfo(g: GroupState): GroupInfo {
    return {
      groupId: g.groupId,
      name: g.name,
      adminDid: g.adminDid,
      members: g.members.map(m => ({ did: m.did, role: m.role, name: m.name })),
      epoch: g.epoch,
      epochHash: g.epochHash,
      state: g.state,
      policy: g.policy,
      isAdmin: g.isAdmin,
    }
  }

  /** Build GCKTransport from a CryptoKey */
  private async buildGckTransport(key: CryptoKey): Promise<GCKTransport> {
    return { k: await exportGCK(key), alg: "A256GCM" }
  }

  /** Build MemberEntry array with roles */
  private buildMembers(adminDid: string, members: MemberEntry[]): MemberEntry[] {
    return members.map(m => ({
      did: m.did,
      role: m.did === adminDid ? "admin" : "member",
      name: m.name,
    }))
  }

  /** Find member name by DID in a group */
  private memberName(group: GroupState, did: string): string {
    const m = group.members.find(m => m.did === did)
    return m?.name || did.slice(0, 20) + "..."
  }

  /** Notify UI of group state change */
  private emitGroupState(group: GroupState): void {
    this.post({ type: "groupStateChanged", payload: this.toGroupInfo(group) })
  }

  /** Process any queued messages for a group after epoch update */
  private async processQueuedMessages(group: GroupState): Promise<void> {
    const remaining: IMessage[] = []
    for (const msg of group.queuedMessages) {
      const body = msg.body as DeliveryBody
      if (body.epoch === group.epoch) {
        await this.decryptAndEmitDelivery(group, body)
      } else if (body.epoch > group.epoch) {
        remaining.push(msg)
      }
      // Discard if epoch < current (too old)
    }
    group.queuedMessages = remaining
  }

  /** Decrypt a delivery body and post the chat message to the UI */
  private async decryptAndEmitDelivery(group: GroupState, body: DeliveryBody): Promise<void> {
    // Verify sender is a member at the indicated epoch
    const senderMember = group.members.find(m => m.did === body.sender)
    if (!senderMember) {
      this.log(`Delivery from non-member ${body.sender} in group ${group.name} — discarding`)
      return
    }

    const content = await decryptWithGCK(
      group.gck, body.ciphertext, body.iv, body.tag,
      body.group_id, body.epoch, body.sender
    )

    const chatMsg: GroupChatMessage = {
      id: uuidv4(),
      groupId: body.group_id,
      senderDid: body.sender,
      senderName: senderMember.name || body.sender.slice(0, 20) + "...",
      content,
      timestamp: Date.now(),
      epoch: body.epoch,
    }
    this.post({ type: "groupMessageReceived", payload: chatMsg })
  }

  // =========================================================================
  // GROUP CREATION
  // =========================================================================

  async createGroup(payload: CreateGroupPayload): Promise<void> {
    const groupId = `urn:uuid:${uuidv4()}`
    const epoch = 0
    const gck = await generateGCK()
    const gckBase64 = await exportGCK(gck)
    const gckFp = await gckFingerprint(gck)
    const policy = { ...DEFAULT_POLICY, ...payload.policy }

    const allMembers: MemberEntry[] = [
      { did: this.did, role: "admin", name: this.displayName },
      ...payload.memberDids.map(m => ({ did: m.did, role: "member" as const, name: m.name })),
    ]

    const memberDids = allMembers.map(m => m.did)
    const epochHash = await computeEpochHash("", epoch, memberDids, gckFp)

    const state: GroupState = {
      groupId, name: payload.name, adminDid: this.did,
      members: allMembers, epoch, gck, gckBase64, epochHash,
      policy, state: "CREATED", isAdmin: true,
      oldGcks: new Map(), queuedMessages: [], messagesSinceRotation: 0,
    }
    this.groups.set(groupId, state)

    // Send `create` to each initial member via pairwise authcrypt
    const gckTransport: GCKTransport = { k: gckBase64, alg: "A256GCM" }
    const body: CreateBody = {
      group_id: groupId,
      name: payload.name,
      epoch,
      members: allMembers,
      gck: gckTransport,
      policy,
    }

    for (const member of payload.memberDids) {
      this.log(`Sending create to ${member.name}...`)
      await this.sendViaHttp(member.did, this.did, { type: MSG_CREATE, body })
    }

    // Transition to ACTIVE once all acks arrive (or optimistically for demo)
    state.state = "ACTIVE"
    this.post({ type: "groupCreated", payload: this.toGroupInfo(state) })
    this.log(`Group "${payload.name}" created with ${allMembers.length} members at epoch 0`)
  }

  /** Handle incoming create message (we are being invited to a group) */
  private async handleCreate(message: IMessage): Promise<void> {
    const body = message.body as CreateBody

    // Skip if we already have this group (prevents overwriting admin state)
    if (this.groups.has(body.group_id)) {
      this.log(`Ignoring duplicate create for group "${body.name || body.group_id}" — already exists`)
      return
    }

    const gck = await importGCK(body.gck.k)
    const senderDid = message.from || body.members.find(m => m.role === "admin")?.did || ""

    const state: GroupState = {
      groupId: body.group_id,
      name: body.name || "Unnamed Group",
      adminDid: senderDid,
      members: body.members,
      epoch: body.epoch,
      gck,
      gckBase64: body.gck.k,
      epochHash: "",
      policy: body.policy || { ...DEFAULT_POLICY },
      state: "ACTIVE",
      isAdmin: false,
      oldGcks: new Map(),
      queuedMessages: [],
      messagesSinceRotation: 0,
    }

    // Compute and store epoch hash
    const gckFp = await gckFingerprint(gck)
    state.epochHash = await computeEpochHash("", body.epoch, body.members.map(m => m.did), gckFp)
    this.groups.set(body.group_id, state)

    // Send create-ack to admin
    const ackBody: CreateAckBody = { group_id: body.group_id, status: "accepted" }
    await this.sendViaHttp(senderDid, this.did, {
      type: MSG_CREATE_ACK,
      body: ackBody,
      thid: message.id,
    })

    this.post({ type: "groupCreated", payload: this.toGroupInfo(state) })
    this.log(`Joined group "${state.name}" — sent create-ack`)
  }

  /** Handle create-ack from a member */
  private async handleCreateAck(message: IMessage): Promise<void> {
    const body = message.body as CreateAckBody
    const group = this.groups.get(body.group_id)
    if (!group) return

    const from = message.from || "unknown"
    if (body.status === "accepted") {
      this.log(`${this.memberName(group, from)} accepted group "${group.name}"`)
    } else {
      this.log(`${this.memberName(group, from)} rejected group "${group.name}"`)
      // Remove the member who rejected
      group.members = group.members.filter(m => m.did !== from)
      this.emitGroupState(group)
    }
  }

  // =========================================================================
  // GROUP MESSAGE SENDING & RECEIVING
  // =========================================================================

  async sendGroupMessage(payload: SendGroupMessagePayload): Promise<void> {
    const group = this.groups.get(payload.groupId)
    if (!group) throw new Error(`Unknown group: ${payload.groupId}`)
    if (group.state === "DISSOLVED" || group.state === "LEFT") {
      throw new Error(`Cannot send to ${group.state} group`)
    }

    const { ciphertext, iv, tag } = await encryptWithGCK(
      group.gck, payload.content, group.groupId, group.epoch, this.did
    )

    const body: DeliveryBody = {
      group_id: group.groupId,
      epoch: group.epoch,
      sender: this.did,
      ciphertext,
      iv,
      tag,
    }

    // Direct fan-out: send to each member via pairwise authcrypt
    for (const member of group.members) {
      if (member.did === this.did) continue
      await this.sendViaHttp(member.did, this.did, { type: MSG_DELIVERY, body })
    }

    // Echo to local UI
    const chatMsg: GroupChatMessage = {
      id: uuidv4(),
      groupId: group.groupId,
      senderDid: this.did,
      senderName: this.displayName,
      content: payload.content,
      timestamp: Date.now(),
      epoch: group.epoch,
    }
    this.post({ type: "groupMessageSent", payload: chatMsg })

    // Track message count for rotation policy
    group.messagesSinceRotation++
    if (group.isAdmin && group.messagesSinceRotation >= group.policy.rotation_period_messages) {
      this.log(`Rotation threshold reached (${group.policy.rotation_period_messages} messages) — rotating key`)
      await this.rotateGroupKey({ groupId: group.groupId, reason: "policy" })
    }
  }

  /** Handle incoming delivery envelope */
  private async handleDelivery(message: IMessage): Promise<void> {
    const body = message.body as DeliveryBody

    // Replay protection (capped to prevent memory leak)
    if (this.processedMessageIds.has(message.id || "")) {
      return
    }
    if (message.id) {
      this.processedMessageIds.add(message.id)
      if (this.processedMessageIds.size > 10_000) {
        // Evict oldest entries (Sets iterate in insertion order)
        const iter = this.processedMessageIds.values()
        for (let i = 0; i < 2_000; i++) iter.next()
        const keep = new Set<string>()
        for (const id of iter) keep.add(id)
        this.processedMessageIds = keep
      }
    }

    // Silent discard for unknown group_id (spec: MUST NOT send problem report)
    const group = this.groups.get(body.group_id)
    if (!group) return

    // Epoch handling
    if (body.epoch > group.epoch) {
      // Future epoch — queue and request info
      this.log(`Delivery with future epoch ${body.epoch} (current: ${group.epoch}) — queuing`)
      group.queuedMessages.push(message)
      // Request current group state from sender or admin
      const targetDid = group.adminDid !== this.did ? group.adminDid : body.sender
      const infoBody: InfoRequestBody = { group_id: body.group_id, known_epoch: group.epoch }
      await this.sendViaHttp(targetDid, this.did, {
        type: MSG_INFO_REQUEST,
        body: infoBody,
        return_route: "all",
      })
      return
    }

    if (body.epoch < group.epoch) {
      // Old epoch — try cached GCK
      const oldGck = group.oldGcks.get(body.epoch)
      if (oldGck) {
        try {
          const content = await decryptWithGCK(
            oldGck, body.ciphertext, body.iv, body.tag,
            body.group_id, body.epoch, body.sender
          )
          const senderMember = group.members.find(m => m.did === body.sender)
          const chatMsg: GroupChatMessage = {
            id: message.id || uuidv4(),
            groupId: body.group_id,
            senderDid: body.sender,
            senderName: senderMember?.name || body.sender.slice(0, 20) + "...",
            content,
            timestamp: Date.now(),
            epoch: body.epoch,
          }
          this.post({ type: "groupMessageReceived", payload: chatMsg })
        } catch (err) {
          this.log(`Failed to decrypt old-epoch message (epoch ${body.epoch}): ${err} — discarding`)
        }
      }
      return
    }

    // Current epoch — decrypt
    await this.decryptAndEmitDelivery(group, body)
  }

  // =========================================================================
  // ADD MEMBER
  // =========================================================================

  async addMember(payload: AddMemberPayload): Promise<void> {
    const group = this.groups.get(payload.groupId)
    if (!group) throw new Error(`Unknown group: ${payload.groupId}`)
    if (!group.isAdmin) throw new Error("Only admin can add members")
    if (group.state !== "ACTIVE") throw new Error(`Cannot add members in ${group.state} state`)

    // Check max_members
    if (group.members.length + payload.members.length > group.policy.max_members) {
      throw new Error(`Adding ${payload.members.length} members would exceed max_members (${group.policy.max_members})`)
    }

    // Transition to EPOCH_ADVANCING
    group.state = "EPOCH_ADVANCING"

    // Generate new GCK for new epoch
    const newEpoch = group.epoch + 1
    const newGck = await generateGCK()
    const newGckBase64 = await exportGCK(newGck)
    const newGckFp = await gckFingerprint(newGck)

    const addedMembers: MemberEntry[] = payload.members.map(m => ({
      did: m.did, role: "member", name: m.name,
    }))
    const newMembers = [...group.members, ...addedMembers]
    const newMemberDids = newMembers.map(m => m.did)
    const newEpochHash = await computeEpochHash(group.epochHash, newEpoch, newMemberDids, newGckFp)
    const gckTransport: GCKTransport = { k: newGckBase64, alg: "A256GCM" }

    // Send add-member to all EXISTING members
    const addBody: AddMemberBody = {
      group_id: group.groupId,
      epoch: newEpoch,
      added: addedMembers,
      members: newMembers,
      gck: gckTransport,
      epoch_hash: newEpochHash,
    }
    for (const member of group.members) {
      if (member.did === this.did) continue
      await this.sendViaHttp(member.did, this.did, { type: MSG_ADD_MEMBER, body: addBody })
    }

    // Send create to NEW members (full group state at new epoch)
    const createBody: CreateBody = {
      group_id: group.groupId,
      name: group.name,
      epoch: newEpoch,
      members: newMembers,
      gck: gckTransport,
      policy: group.policy,
    }
    for (const member of addedMembers) {
      await this.sendViaHttp(member.did, this.did, { type: MSG_CREATE, body: createBody })
    }

    // Update local state
    group.oldGcks.set(group.epoch, group.gck)
    group.epoch = newEpoch
    group.gck = newGck
    group.gckBase64 = newGckBase64
    group.epochHash = newEpochHash
    group.members = newMembers
    group.messagesSinceRotation = 0
    group.state = "ACTIVE"

    this.emitGroupState(group)
    this.log(`Added ${addedMembers.map(m => m.name).join(", ")} to "${group.name}" — epoch ${newEpoch}`)
    this.post({ type: "memberAdded", payload: { groupId: group.groupId, added: addedMembers } })
  }

  /** Handle incoming add-member (we are an existing member being notified) */
  private async handleAddMember(message: IMessage): Promise<void> {
    const body = message.body as AddMemberBody
    const group = this.groups.get(body.group_id)
    if (!group) return

    const from = message.from || ""
    // Verify sender is admin
    if (from !== group.adminDid) {
      this.log(`add-member from non-admin ${from} — discarding`)
      return
    }

    // Cache old GCK
    group.oldGcks.set(group.epoch, group.gck)

    // Update state
    group.epoch = body.epoch
    group.gck = await importGCK(body.gck.k)
    group.gckBase64 = body.gck.k
    group.epochHash = body.epoch_hash
    group.members = body.members
    group.messagesSinceRotation = 0

    // Send ack
    const ackBody: AddMemberAckBody = { group_id: body.group_id, epoch: body.epoch, status: "accepted" }
    await this.sendViaHttp(from, this.did, {
      type: MSG_ADD_MEMBER_ACK,
      body: ackBody,
      thid: message.id,
    })

    // Process queued messages
    await this.processQueuedMessages(group)

    this.emitGroupState(group)
    this.log(`Members added to "${group.name}" — epoch ${body.epoch}`)
    this.post({ type: "memberAdded", payload: { groupId: body.group_id, added: body.added } })
  }

  private async handleAddMemberAck(message: IMessage): Promise<void> {
    const body = message.body as AddMemberAckBody
    const group = this.groups.get(body.group_id)
    if (!group) return
    this.log(`${this.memberName(group, message.from || "")} acknowledged add-member (epoch ${body.epoch})`)
  }

  // =========================================================================
  // REMOVE MEMBER
  // =========================================================================

  async removeMember(payload: RemoveMemberPayload): Promise<void> {
    const group = this.groups.get(payload.groupId)
    if (!group) throw new Error(`Unknown group: ${payload.groupId}`)
    if (!group.isAdmin) throw new Error("Only admin can remove members")
    if (group.state !== "ACTIVE") throw new Error(`Cannot remove members in ${group.state} state`)

    group.state = "EPOCH_ADVANCING"

    const newEpoch = group.epoch + 1
    const newGck = await generateGCK()
    const newGckBase64 = await exportGCK(newGck)
    const newGckFp = await gckFingerprint(newGck)

    const remainingMembers = group.members.filter(m => !payload.memberDids.includes(m.did))
    const newMemberDids = remainingMembers.map(m => m.did)
    const newEpochHash = await computeEpochHash(group.epochHash, newEpoch, newMemberDids, newGckFp)
    const gckTransport: GCKTransport = { k: newGckBase64, alg: "A256GCM" }

    // Send remove-member to remaining members (with new GCK)
    const removeBody: RemoveMemberBody = {
      group_id: group.groupId,
      epoch: newEpoch,
      removed: payload.memberDids,
      members: remainingMembers,
      gck: gckTransport,
      epoch_hash: newEpochHash,
    }
    for (const member of remainingMembers) {
      if (member.did === this.did) continue
      await this.sendViaHttp(member.did, this.did, { type: MSG_REMOVE_MEMBER, body: removeBody })
    }

    // Send notification to removed members (NO GCK)
    const notifyBody: RemoveMemberNotifyBody = {
      group_id: group.groupId,
      removed: payload.memberDids,
    }
    for (const removedDid of payload.memberDids) {
      await this.sendViaHttp(removedDid, this.did, { type: MSG_REMOVE_MEMBER, body: notifyBody })
    }

    // Update local state
    group.oldGcks.set(group.epoch, group.gck)
    group.epoch = newEpoch
    group.gck = newGck
    group.gckBase64 = newGckBase64
    group.epochHash = newEpochHash
    group.members = remainingMembers
    group.messagesSinceRotation = 0
    group.state = "ACTIVE"

    const removedNames = payload.memberDids.map(d => this.memberName(group, d)).join(", ")
    this.emitGroupState(group)
    this.log(`Removed ${removedNames} from "${group.name}" — epoch ${newEpoch}`)
    this.post({ type: "memberRemoved", payload: { groupId: group.groupId, removed: payload.memberDids } })
  }

  /** Handle incoming remove-member */
  private async handleRemoveMember(message: IMessage): Promise<void> {
    const body = message.body as (RemoveMemberBody | RemoveMemberNotifyBody)
    const group = this.groups.get(body.group_id)
    if (!group) return

    const from = message.from || ""
    if (from !== group.adminDid) {
      this.log(`remove-member from non-admin ${from} — discarding`)
      return
    }

    // Check if we are being removed (notification has no epoch/gck/members)
    if (body.removed.includes(this.did)) {
      this.log(`Removed from group "${group.name}"`)
      group.state = "LEFT"
      // Discard GCK
      group.oldGcks.clear()
      this.emitGroupState(group)
      this.post({ type: "memberRemoved", payload: { groupId: body.group_id, removed: body.removed } })

      // Send ack
      const ackBody: RemoveMemberAckBody = {
        group_id: body.group_id,
        epoch: group.epoch,
        status: "accepted",
      }
      await this.sendViaHttp(from, this.did, {
        type: MSG_REMOVE_MEMBER_ACK,
        body: ackBody,
        thid: message.id,
      })
      return
    }

    // We are a remaining member — full body with new GCK
    const fullBody = body as RemoveMemberBody

    group.oldGcks.set(group.epoch, group.gck)
    group.epoch = fullBody.epoch
    group.gck = await importGCK(fullBody.gck.k)
    group.gckBase64 = fullBody.gck.k
    group.epochHash = fullBody.epoch_hash
    group.members = fullBody.members
    group.messagesSinceRotation = 0

    const ackBody: RemoveMemberAckBody = {
      group_id: body.group_id,
      epoch: fullBody.epoch,
      status: "accepted",
    }
    await this.sendViaHttp(from, this.did, {
      type: MSG_REMOVE_MEMBER_ACK,
      body: ackBody,
      thid: message.id,
    })

    await this.processQueuedMessages(group)
    this.emitGroupState(group)
    this.log(`Members removed from "${group.name}" — epoch ${fullBody.epoch}`)
    this.post({ type: "memberRemoved", payload: { groupId: body.group_id, removed: fullBody.removed } })
  }

  private async handleRemoveMemberAck(message: IMessage): Promise<void> {
    const body = message.body as RemoveMemberAckBody
    const group = this.groups.get(body.group_id)
    if (!group) return
    this.log(`${this.memberName(group, message.from || "")} acknowledged remove-member (epoch ${body.epoch})`)
  }

  // =========================================================================
  // KEY ROTATION
  // =========================================================================

  async rotateGroupKey(payload: RotateGroupKeyPayload): Promise<void> {
    const group = this.groups.get(payload.groupId)
    if (!group) throw new Error(`Unknown group: ${payload.groupId}`)
    if (!group.isAdmin) throw new Error("Only admin can rotate keys")
    if (group.state !== "ACTIVE") throw new Error(`Cannot rotate in ${group.state} state`)

    group.state = "EPOCH_ADVANCING"

    const newEpoch = group.epoch + 1
    const newGck = await generateGCK()
    const newGckBase64 = await exportGCK(newGck)
    const newGckFp = await gckFingerprint(newGck)

    const memberDids = group.members.map(m => m.did)
    const newEpochHash = await computeEpochHash(group.epochHash, newEpoch, memberDids, newGckFp)
    const gckTransport: GCKTransport = { k: newGckBase64, alg: "A256GCM" }

    const rotateBody: KeyRotateBody = {
      group_id: group.groupId,
      epoch: newEpoch,
      reason: payload.reason,
      gck: gckTransport,
      epoch_hash: newEpochHash,
    }

    for (const member of group.members) {
      if (member.did === this.did) continue
      await this.sendViaHttp(member.did, this.did, { type: MSG_KEY_ROTATE, body: rotateBody })
    }

    group.oldGcks.set(group.epoch, group.gck)
    group.epoch = newEpoch
    group.gck = newGck
    group.gckBase64 = newGckBase64
    group.epochHash = newEpochHash
    group.messagesSinceRotation = 0
    group.state = "ACTIVE"

    this.emitGroupState(group)
    this.log(`Key rotated for "${group.name}" — epoch ${newEpoch} (reason: ${payload.reason || "manual"})`)
    this.post({ type: "keyRotated", payload: { groupId: group.groupId, epoch: newEpoch } })
  }

  /** Handle incoming key-rotate */
  private async handleKeyRotate(message: IMessage): Promise<void> {
    const body = message.body as KeyRotateBody
    const group = this.groups.get(body.group_id)
    if (!group) return

    const from = message.from || ""
    if (from !== group.adminDid) {
      this.log(`key-rotate from non-admin ${from} — discarding`)
      return
    }

    group.oldGcks.set(group.epoch, group.gck)
    group.epoch = body.epoch
    group.gck = await importGCK(body.gck.k)
    group.gckBase64 = body.gck.k
    group.epochHash = body.epoch_hash
    group.messagesSinceRotation = 0

    // Send ack
    const ackBody: KeyRotateAckBody = { group_id: body.group_id, epoch: body.epoch, status: "accepted" }
    await this.sendViaHttp(from, this.did, {
      type: MSG_KEY_ROTATE_ACK,
      body: ackBody,
      thid: message.id,
    })

    await this.processQueuedMessages(group)
    this.emitGroupState(group)
    this.log(`Key rotated for "${group.name}" — epoch ${body.epoch}`)
    this.post({ type: "keyRotated", payload: { groupId: body.group_id, epoch: body.epoch } })
  }

  private async handleKeyRotateAck(message: IMessage): Promise<void> {
    const body = message.body as KeyRotateAckBody
    const group = this.groups.get(body.group_id)
    if (!group) return
    this.log(`${this.memberName(group, message.from || "")} acknowledged key-rotate (epoch ${body.epoch})`)
  }

  // =========================================================================
  // LEAVE
  // =========================================================================

  async leaveGroup(payload: LeaveGroupPayload): Promise<void> {
    const group = this.groups.get(payload.groupId)
    if (!group) throw new Error(`Unknown group: ${payload.groupId}`)
    if (group.state !== "ACTIVE") throw new Error(`Cannot leave ${group.state} group`)

    // Check policy
    if (!group.policy.member_can_leave && !group.isAdmin) {
      throw new Error("Group policy does not allow members to leave")
    }

    // Admin cannot leave if they are the only admin
    if (group.isAdmin) {
      const admins = group.members.filter(m => m.role === "admin")
      if (admins.length <= 1) {
        throw new Error("Cannot leave — you are the only admin. Dissolve the group or promote another admin first.")
      }
    }

    const leaveBody: LeaveBody = { group_id: group.groupId }
    for (const member of group.members) {
      if (member.did === this.did) continue
      await this.sendViaHttp(member.did, this.did, { type: MSG_LEAVE, body: leaveBody })
    }

    group.state = "LEFT"
    group.oldGcks.clear()
    this.emitGroupState(group)
    this.log(`Left group "${group.name}"`)
    this.post({ type: "memberLeft", payload: { groupId: group.groupId, memberDid: this.did } })
  }

  /** Handle incoming leave message */
  private async handleLeave(message: IMessage): Promise<void> {
    const body = message.body as LeaveBody
    const group = this.groups.get(body.group_id)
    if (!group) return

    const from = message.from || ""
    this.log(`${this.memberName(group, from)} left group "${group.name}"`)

    // Send ack
    const ackBody: LeaveAckBody = { group_id: body.group_id, status: "acknowledged" }
    await this.sendViaHttp(from, this.did, {
      type: MSG_LEAVE_ACK,
      body: ackBody,
      thid: message.id,
    })

    // If we are admin, trigger key rotation to exclude the leaving member
    if (group.isAdmin) {
      // Remove the member first
      group.members = group.members.filter(m => m.did !== from)
      this.emitGroupState(group)

      // Rotate key for forward secrecy
      await this.rotateGroupKey({ groupId: group.groupId, reason: "policy" })
      this.post({ type: "memberLeft", payload: { groupId: body.group_id, memberDid: from } })
    } else {
      // Non-admin: just note it, admin will send key-rotate
      this.post({ type: "memberLeft", payload: { groupId: body.group_id, memberDid: from } })
    }
  }

  private async handleLeaveAck(message: IMessage): Promise<void> {
    const body = message.body as LeaveAckBody
    this.log(`Received leave-ack for group ${body.group_id}`)
  }

  // =========================================================================
  // INFO REQUEST / INFO
  // =========================================================================

  async requestGroupInfo(payload: RequestGroupInfoPayload): Promise<void> {
    const group = this.groups.get(payload.groupId)
    if (!group) throw new Error(`Unknown group: ${payload.groupId}`)

    const targetDid = payload.targetDid || group.adminDid
    const infoReqBody: InfoRequestBody = {
      group_id: group.groupId,
      known_epoch: group.epoch,
    }
    await this.sendViaHttp(targetDid, this.did, {
      type: MSG_INFO_REQUEST,
      body: infoReqBody,
      return_route: "all",
    })
    this.log(`Requested group info for "${group.name}" from ${this.memberName(group, targetDid)}`)
  }

  /** Handle incoming info-request — respond with current group state */
  private async handleInfoRequest(message: IMessage): Promise<void> {
    const body = message.body as InfoRequestBody
    const group = this.groups.get(body.group_id)
    if (!group) return

    const from = message.from || ""
    // Verify requester is a current member
    if (!group.members.some(m => m.did === from)) {
      this.log(`info-request from non-member ${from} — discarding`)
      return
    }

    const gckTransport = await this.buildGckTransport(group.gck)
    const infoBody: InfoBody = {
      group_id: group.groupId,
      name: group.name,
      epoch: group.epoch,
      members: group.members,
      gck: gckTransport,
      policy: group.policy,
      epoch_hash: group.epochHash,
    }
    await this.sendViaHttp(from, this.did, {
      type: MSG_INFO,
      body: infoBody,
      thid: message.id,
    })
    this.log(`Sent group info for "${group.name}" to ${this.memberName(group, from)}`)
  }

  /** Handle incoming info response */
  private async handleInfo(message: IMessage): Promise<void> {
    const body = message.body as InfoBody
    const group = this.groups.get(body.group_id)
    if (!group) return

    // Only update if the info is newer
    if (body.epoch <= group.epoch) {
      this.log(`Received stale info (epoch ${body.epoch}, current ${group.epoch}) — ignoring`)
      return
    }

    group.oldGcks.set(group.epoch, group.gck)
    group.epoch = body.epoch
    group.gck = await importGCK(body.gck.k)
    group.gckBase64 = body.gck.k
    group.epochHash = body.epoch_hash
    group.members = body.members
    if (body.name) group.name = body.name
    if (body.policy) group.policy = body.policy
    group.messagesSinceRotation = 0

    await this.processQueuedMessages(group)
    this.emitGroupState(group)
    this.log(`Updated group "${group.name}" to epoch ${body.epoch} via info response`)
    this.post({ type: "groupInfoReceived", payload: this.toGroupInfo(group) })
  }

  // =========================================================================
  // DISSOLVE
  // =========================================================================

  async dissolveGroup(payload: DissolveGroupPayload): Promise<void> {
    const group = this.groups.get(payload.groupId)
    if (!group) throw new Error(`Unknown group: ${payload.groupId}`)
    if (!group.isAdmin) throw new Error("Only admin can dissolve the group")

    const dissolveBody: DissolveBody = {
      group_id: group.groupId,
      reason: payload.reason,
    }
    for (const member of group.members) {
      if (member.did === this.did) continue
      await this.sendViaHttp(member.did, this.did, { type: MSG_DISSOLVE, body: dissolveBody })
    }

    group.state = "DISSOLVED"
    group.oldGcks.clear()
    this.emitGroupState(group)
    this.log(`Dissolved group "${group.name}"`)
    this.post({ type: "groupDissolved", payload: { groupId: group.groupId } })
  }

  /** Handle incoming dissolve */
  private async handleDissolve(message: IMessage): Promise<void> {
    const body = message.body as DissolveBody
    const group = this.groups.get(body.group_id)
    if (!group) return

    const from = message.from || ""
    if (from !== group.adminDid) {
      this.log(`dissolve from non-admin ${from} — discarding`)
      return
    }

    // Send ack
    const ackBody: DissolveAckBody = { group_id: body.group_id, status: "acknowledged" }
    await this.sendViaHttp(from, this.did, {
      type: MSG_DISSOLVE_ACK,
      body: ackBody,
      thid: message.id,
    })

    group.state = "LEFT"
    group.oldGcks.clear()
    this.emitGroupState(group)
    this.log(`Group "${group.name}" dissolved by admin${body.reason ? ": " + body.reason : ""}`)
    this.post({ type: "groupDissolved", payload: { groupId: group.groupId } })
  }

  private async handleDissolveAck(message: IMessage): Promise<void> {
    const body = message.body as DissolveAckBody
    const group = this.groups.get(body.group_id)
    if (!group) return
    this.log(`${this.memberName(group, message.from || "")} acknowledged dissolve`)
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  private post<T>(message: WorkerMessage<T>): void {
    self.postMessage(message)
  }

  private log(msg: string): void {
    console.log(`[Worker] ${msg}`)
    this.post({ type: "log", payload: { message: msg, timestamp: Date.now() } })
  }

  /** Allowed commands from the UI thread (whitelist prevents arbitrary method invocation) */
  private readonly commands: Record<string, (payload: any) => Promise<void>> = {
    establishMediation: (p) => this.establishMediation(p),
    createGroup:        (p) => this.createGroup(p),
    sendGroupMessage:   (p) => this.sendGroupMessage(p),
    addMember:          (p) => this.addMember(p),
    removeMember:       (p) => this.removeMember(p),
    leaveGroup:         (p) => this.leaveGroup(p),
    dissolveGroup:      (p) => this.dissolveGroup(p),
    rotateGroupKey:     (p) => this.rotateGroupKey(p),
    requestGroupInfo:   (p) => this.requestGroupInfo(p),
    disconnect:         ()  => this.disconnect(),
  }

  async route(event: MessageEvent<WorkerCommand<any>>): Promise<void> {
    const { type, payload } = event.data
    this.log(`Command: ${type}`)
    const handler = this.commands[type]
    if (handler) {
      try {
        await handler(payload)
      } catch (error) {
        this.log(`Error in ${type}: ${error}`)
        this.post({ type: "error", payload: { message: String(error) } })
      }
    } else {
      this.log(`Unknown command: ${type}`)
    }
  }
}

const handler = new DIDCommWorker()
ctx.onmessage = async (event: MessageEvent) => {
  await handler.route(event)
}
handler.init()
