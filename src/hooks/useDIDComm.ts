import { useCallback, useEffect, useRef, useState } from "react"
import type {
  WorkerMessage, GroupInfo, GroupChatMessage,
  AddMemberPayload, RemoveMemberPayload, LeaveGroupPayload,
  DissolveGroupPayload, RotateGroupKeyPayload,
} from "../lib/workerTypes"

export type ConnectionState = "idle" | "connecting" | "mediated" | "connected" | "error"

export interface LogEntry {
  message: string
  timestamp: number
}

export interface UseDIDCommReturn {
  state: ConnectionState
  did: string
  displayName: string
  groups: GroupInfo[]
  messages: Map<string, GroupChatMessage[]>
  logs: LogEntry[]
  connect: (mediatorDid: string, displayName: string) => void
  createGroup: (name: string, memberDids: { did: string; name: string }[]) => void
  sendMessage: (groupId: string, content: string) => void
  addMember: (groupId: string, members: { did: string; name: string }[]) => void
  removeMember: (groupId: string, memberDids: string[]) => void
  leaveGroup: (groupId: string) => void
  dissolveGroup: (groupId: string, reason?: string) => void
  rotateGroupKey: (groupId: string, reason?: "scheduled" | "compromise" | "policy") => void
}

export function useDIDComm(): UseDIDCommReturn {
  const workerRef = useRef<Worker | null>(null)
  const [state, setState] = useState<ConnectionState>("idle")
  const [did, setDid] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [messages, setMessages] = useState<Map<string, GroupChatMessage[]>>(new Map())
  const [logs, setLogs] = useState<LogEntry[]>([])
  const mediatorDidRef = useRef("")

  const addLog = useCallback((msg: string) => {
    setLogs(prev => [...prev.slice(-99), { message: msg, timestamp: Date.now() }])
  }, [])

  const addMessage = useCallback((msg: GroupChatMessage) => {
    setMessages(prev => {
      const next = new Map(prev)
      const existing = next.get(msg.groupId) || []
      if (existing.some(m => m.id === msg.id)) return prev
      next.set(msg.groupId, [...existing, msg])
      return next
    })
  }, [])

  const updateGroup = useCallback((updated: GroupInfo) => {
    setGroups(prev => {
      const idx = prev.findIndex(g => g.groupId === updated.groupId)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = updated
        return next
      }
      return prev
    })
  }, [])

  useEffect(() => {
    const worker = new Worker(new URL("../lib/worker.ts", import.meta.url))
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<WorkerMessage<any>>) => {
      const { type, payload } = event.data

      switch (type) {
        case "init":
          addLog("Worker ready")
          break

        case "log":
          addLog(payload.message || String(payload))
          break

        case "didGenerated":
          setDid(payload.did)
          setDisplayName(payload.displayName)
          break

        case "connected":
          setState("connected")
          break

        case "disconnected":
          setState("idle")
          addLog("Disconnected from mediator")
          break

        case "error":
          setState("error")
          addLog(`Error: ${payload.message || "Unknown error"}`)
          break

        case "groupCreated":
          setGroups(prev => {
            if (prev.some(g => g.groupId === payload.groupId)) return prev
            return [...prev, payload as GroupInfo]
          })
          break

        case "groupMessageReceived":
        case "groupMessageSent":
          addMessage(payload as GroupChatMessage)
          break

        case "groupStateChanged":
          updateGroup(payload as GroupInfo)
          break

        case "memberAdded":
        case "memberRemoved":
        case "memberLeft":
        case "keyRotated":
        case "groupInfoReceived":
          // These are informational — groupStateChanged handles the actual state update
          break

        case "groupDissolved":
          // Mark group as dissolved in local state
          setGroups(prev => prev.map(g =>
            g.groupId === payload.groupId
              ? { ...g, state: "DISSOLVED" as const }
              : g
          ))
          break

        default:
          console.log("[useDIDComm] Unhandled worker message:", type, payload)
      }
    }

    return () => {
      worker.terminate()
    }
  }, [addLog, addMessage, updateGroup])

  const connect = useCallback((mediatorDid: string, name: string) => {
    mediatorDidRef.current = mediatorDid
    setState("connecting")
    workerRef.current?.postMessage({
      type: "establishMediation",
      payload: { mediatorDid, displayName: name },
    })
  }, [])

  const createGroup = useCallback((name: string, memberDids: { did: string; name: string }[]) => {
    workerRef.current?.postMessage({
      type: "createGroup",
      payload: { name, memberDids },
    })
  }, [])

  const sendMessage = useCallback((groupId: string, content: string) => {
    workerRef.current?.postMessage({
      type: "sendGroupMessage",
      payload: { groupId, content },
    })
  }, [])

  const addMember = useCallback((groupId: string, members: { did: string; name: string }[]) => {
    workerRef.current?.postMessage({
      type: "addMember",
      payload: { groupId, members } satisfies AddMemberPayload,
    })
  }, [])

  const removeMember = useCallback((groupId: string, memberDids: string[]) => {
    workerRef.current?.postMessage({
      type: "removeMember",
      payload: { groupId, memberDids } satisfies RemoveMemberPayload,
    })
  }, [])

  const leaveGroup = useCallback((groupId: string) => {
    workerRef.current?.postMessage({
      type: "leaveGroup",
      payload: { groupId } satisfies LeaveGroupPayload,
    })
  }, [])

  const dissolveGroup = useCallback((groupId: string, reason?: string) => {
    workerRef.current?.postMessage({
      type: "dissolveGroup",
      payload: { groupId, reason } satisfies DissolveGroupPayload,
    })
  }, [])

  const rotateGroupKey = useCallback((groupId: string, reason?: "scheduled" | "compromise" | "policy") => {
    workerRef.current?.postMessage({
      type: "rotateGroupKey",
      payload: { groupId, reason } satisfies RotateGroupKeyPayload,
    })
  }, [])

  return {
    state, did, displayName, groups, messages, logs,
    connect, createGroup, sendMessage,
    addMember, removeMember, leaveGroup, dissolveGroup, rotateGroupKey,
  }
}
