import {
  ed25519,
  edwardsToMontgomeryPub,
  edwardsToMontgomeryPriv,
} from "@noble/curves/ed25519"
import {
  DIDResolver,
  DIDDoc,
  SecretsResolver,
  Secret,
  Message,
  UnpackMetadata,
  PackEncryptedMetadata,
  MessagingServiceMetadata,
  IMessage,
  Service,
} from "didcomm"
import DIDPeer from "./peer2"
import * as DIDPeer4 from "./peer4"
import { v4 as uuidv4 } from "uuid"
import * as multibase from "multibase"
import * as multicodec from "multicodec"

export type DID = string

function x25519ToSecret(did: DID, x25519KeyPriv: Uint8Array, _x25519Key: Uint8Array): Secret {
  const encIdent = "key-2"
  return {
    id: `${did}#${encIdent}`,
    type: "X25519KeyAgreementKey2020",
    privateKeyMultibase: DIDPeer.keyToMultibase(x25519KeyPriv, "x25519-priv"),
  }
}

async function ed25519ToSecret(did: DID, ed25519KeyPriv: Uint8Array, ed25519Key: Uint8Array): Promise<Secret> {
  const verIdent = "key-1"
  const ed25519KeyPriv2 = new Uint8Array(ed25519Key.length + ed25519KeyPriv.length)
  ed25519KeyPriv2.set(ed25519KeyPriv)
  ed25519KeyPriv2.set(ed25519Key, ed25519KeyPriv.length)
  return {
    id: `${did}#${verIdent}`,
    type: "Ed25519VerificationKey2020",
    privateKeyMultibase: DIDPeer.keyToMultibase(ed25519KeyPriv2, "ed25519-priv"),
  }
}

export async function generateDidForMediator(): Promise<{ did: DID; secrets: Secret[] }> {
  const key = ed25519.utils.randomPrivateKey()
  const enckeyPriv = edwardsToMontgomeryPriv(key)
  const verkey = ed25519.getPublicKey(key)
  const enckey = edwardsToMontgomeryPub(verkey)
  const service = {
    type: "DIDCommMessaging",
    id: "#service",
    serviceEndpoint: {
      uri: "didcomm:transport/queue",
      accept: ["didcomm/v2"],
      routingKeys: [] as string[],
    },
  }
  const doc = {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/multikey/v1"
    ],
    verificationMethod: [
      { id: "#key-1", type: "Multikey", publicKeyMultibase: DIDPeer.keyToMultibase(verkey, "ed25519-pub") },
      { id: "#key-2", type: "Multikey", publicKeyMultibase: DIDPeer.keyToMultibase(enckey, "x25519-pub") },
    ],
    authentication: ["#key-1"],
    capabilityDelegation: ["#key-1"],
    service: [service],
    keyAgreement: ["#key-2"],
  }
  const did = await DIDPeer4.encode(doc)
  const secretVer = await ed25519ToSecret(did, key, verkey)
  const secretEnc = x25519ToSecret(did, enckeyPriv, enckey)
  return { did, secrets: [secretVer, secretEnc] }
}

export async function generateDid(routingDid: DID): Promise<{ did: DID; secrets: Secret[] }> {
  const key = ed25519.utils.randomSecretKey()
  const enckeyPriv = ed25519.utils.toMontgomerySecret(key)
  const verkey = ed25519.getPublicKey(key)
  const enckey = ed25519.utils.toMontgomery(verkey)
  const service = {
    type: "DIDCommMessaging",
    id: "#service",
    serviceEndpoint: {
      uri: routingDid,
      accept: ["didcomm/v2"],
    },
  }
  const doc = {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/multikey/v1"
    ],
    verificationMethod: [
      { id: "#key-1", type: "Multikey", publicKeyMultibase: DIDPeer.keyToMultibase(verkey, "ed25519-pub") },
      { id: "#key-2", type: "Multikey", publicKeyMultibase: DIDPeer.keyToMultibase(enckey, "x25519-pub") },
    ],
    authentication: ["#key-1"],
    capabilityDelegation: ["#key-1"],
    service: [service],
    keyAgreement: ["#key-2"],
  }
  const did = await DIDPeer4.encode(doc)
  const secretVer = await ed25519ToSecret(did, key, verkey)
  const secretEnc = x25519ToSecret(did, enckeyPriv, enckey)
  return { did, secrets: [secretVer, secretEnc] }
}

// --- Resolvers ---

export class DIDPeerResolver implements DIDResolver {
  async resolve(did: DID): Promise<DIDDoc | null> {
    const raw_doc = DIDPeer.resolve(did)
    return {
      id: raw_doc.id,
      verificationMethod: raw_doc.verificationMethod,
      authentication: raw_doc.authentication,
      keyAgreement: raw_doc.keyAgreement,
      service: raw_doc.service,
    }
  }
}

export class DIDPeer4Resolver implements DIDResolver {
  async resolve(did: DID): Promise<DIDDoc | null> {
    const raw_doc = await DIDPeer4.resolve(did)
    const fix_vms = (vms: Array<Record<string, any>>): any[] => {
      return vms.map((k: Record<string, any>) => {
        const new_method: any = {
          id: `${did}${k.id}`,
          type: k.type,
          controller: k.controller,
          publicKeyMultibase: k.publicKeyMultibase,
        }
        if (new_method.type === "Multikey") {
          const key = multibase.decode(k.publicKeyMultibase)
          const codec = multicodec.getNameFromData(key)
          switch (codec) {
            case "x25519-pub":
              new_method.type = "X25519KeyAgreementKey2020"
              break
            case "ed25519-pub":
              new_method.type = "Ed25519VerificationKey2020"
              break
          }
        }
        return new_method
      })
    }
    return {
      id: raw_doc.id,
      verificationMethod: fix_vms(raw_doc.verificationMethod),
      authentication: raw_doc.authentication.map((kid: string) => `${raw_doc.id}${kid}`),
      keyAgreement: raw_doc.keyAgreement.map((kid: string) => `${raw_doc.id}${kid}`),
      service: raw_doc.service,
    }
  }
}

const did_web_cache: Record<DID, any> = {}

/** Resolves did:web and did:webvh by fetching /.well-known/did.json */
export class DIDWebResolver implements DIDResolver {
  async resolve(did: DID): Promise<DIDDoc | null> {
    if (did in did_web_cache) return did_web_cache[did]

    let domain: string

    if (did.startsWith("did:webvh:")) {
      // did:webvh:{SCID}:{domain}[:{path}...]
      const rest = did.slice("did:webvh:".length)
      const parts = rest.split(":")
      // First part is the SCID hash, second+ is the domain/path
      parts.shift() // remove SCID
      domain = parts[0].replaceAll(/%3[aA]/g, ":")
      if (parts.length === 1) {
        domain = `${domain}/.well-known/did.json`
      } else {
        domain = parts.join("/") + "/did.json"
      }
    } else {
      // did:web:{domain}[:{path}...]
      const rest = did.slice("did:web:".length)
      const parts = rest.split(":")
      parts[0] = parts[0].replaceAll(/%3[aA]/g, ":")
      if (parts.length === 1) {
        domain = `${parts[0]}/.well-known/did.json`
      } else {
        domain = parts.join("/") + "/did.json"
      }
    }

    const url = `https://${domain}`
    console.log("[DIDWebResolver] fetching:", url)

    const raw_doc = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
    })
    if (!raw_doc.ok) {
      throw new Error(`Failed to fetch DID document: ${raw_doc.status} ${raw_doc.statusText}`)
    }
    const doc = await raw_doc.json()
    console.log("[DIDWebResolver] resolved:", did, doc)

    const new_methods: any[] = []
    for (const method of doc["verificationMethod"] || []) {
      let t = "Multikey"
      if (doc["authentication"]?.includes(method["id"])) t = "Ed25519VerificationKey2020"
      if (doc["keyAgreement"]?.includes(method["id"])) t = "X25519KeyAgreementKey2020"
      const new_method = { ...method, type: t }
      if (new_method.id.startsWith("#")) new_method.id = new_method.controller + new_method.id
      new_methods.push(new_method)
    }
    doc["verificationMethod"] = new_methods
    doc["keyAgreement"]?.forEach((value: string, index: number, arr: string[]) => {
      if (value.startsWith("#")) arr[index] = did + value
    })
    doc["authentication"]?.forEach((value: string, index: number, arr: string[]) => {
      if (value.startsWith("#")) arr[index] = did + value
    })
    doc["service"] = (doc["service"] || []).filter((s: any) => s.type === "DIDCommMessaging")

    did_web_cache[did] = doc
    return doc
  }
}

export class DIDKeyResolver implements DIDResolver {
  async resolve(did: DID): Promise<DIDDoc | null> {
    // did:key:z6Mk... → extract multibase-encoded public key
    const fragment = did.slice("did:key:".length)
    const keyBytes = multibase.decode(fragment)
    const codec = multicodec.getNameFromData(keyBytes)
    const rawKey = multicodec.rmPrefix(keyBytes)

    if (codec === "ed25519-pub") {
      const x25519Pub = edwardsToMontgomeryPub(rawKey)
      return {
        id: did,
        verificationMethod: [
          {
            id: `${did}#${fragment}`,
            type: "Ed25519VerificationKey2020",
            controller: did,
            publicKeyMultibase: fragment,
          },
          {
            id: `${did}#key-x25519-1`,
            type: "X25519KeyAgreementKey2020",
            controller: did,
            publicKeyMultibase: DIDPeer.keyToMultibase(x25519Pub, "x25519-pub"),
          },
        ],
        authentication: [`${did}#${fragment}`],
        keyAgreement: [`${did}#key-x25519-1`],
        service: [],
      }
    }

    if (codec === "x25519-pub") {
      return {
        id: did,
        verificationMethod: [
          {
            id: `${did}#${fragment}`,
            type: "X25519KeyAgreementKey2020",
            controller: did,
            publicKeyMultibase: fragment,
          },
        ],
        authentication: [],
        keyAgreement: [`${did}#${fragment}`],
        service: [],
      }
    }

    throw new Error(`Unsupported did:key codec: ${codec}`)
  }
}

type ResolverMap = { [key: string]: DIDResolver }

export class PrefixResolver implements DIDResolver {
  resolver_map: ResolverMap = {}

  constructor() {
    const webResolver = new DIDWebResolver() as DIDResolver
    this.resolver_map = {
      "did:peer:2": new DIDPeerResolver() as DIDResolver,
      "did:peer:4": new DIDPeer4Resolver() as DIDResolver,
      "did:web:": webResolver,
      "did:webvh:": webResolver,
      "did:key:": new DIDKeyResolver() as DIDResolver,
    }
  }

  async resolve(did: DID): Promise<DIDDoc | null> {
    const prefix = Object.keys(this.resolver_map).find(p => did.startsWith(p))
    if (!prefix) throw new Error(`No resolver for DID: ${did}`)
    return await this.resolver_map[prefix].resolve(did)
  }
}

// --- Secrets ---

export interface SecretsManager extends SecretsResolver {
  store_secret: (secret: Secret) => void
}

export class EphemeralSecretsResolver implements SecretsManager {
  private secrets: Record<string, Secret> = {}

  async get_secret(secret_id: string): Promise<Secret | null> {
    return this.secrets[secret_id] || null
  }

  async find_secrets(secret_ids: Array<string>): Promise<Array<string>> {
    return secret_ids
      .map(id => this.secrets[id])
      .filter(secret => !!secret)
      .map(secret => secret.id)
  }

  store_secret(secret: Secret): void {
    this.secrets[secret.id] = secret
  }
}

// --- DIDComm message types ---

export interface DIDCommMessage {
  type: string
  body?: any
  [key: string]: any
}

// --- Main DIDComm class ---

export class DIDCommService {
  private readonly resolver: DIDResolver
  private readonly secretsResolver: SecretsManager

  constructor() {
    this.resolver = new PrefixResolver()
    this.secretsResolver = new EphemeralSecretsResolver()
  }

  async generateDidForMediator(): Promise<DID> {
    const { did, secrets } = await generateDidForMediator()
    secrets.forEach(secret => this.secretsResolver.store_secret(secret))
    return did
  }

  async generateDid(routingDid: DID): Promise<DID> {
    const { did, secrets } = await generateDid(routingDid)
    secrets.forEach(secret => this.secretsResolver.store_secret(secret))
    return did
  }

  async resolve(did: DID): Promise<DIDDoc | null> {
    return await this.resolver.resolve(did)
  }

  async resolveDIDCommServices(did: DID): Promise<Service[]> {
    const doc = await this.resolve(did)
    if (!doc) throw new Error("Unable to resolve DID")
    if (!doc.service) throw new Error("No service found")
    return doc.service
      .filter((s: any) => s.type === "DIDCommMessaging")
      .filter((s: any) => s.serviceEndpoint?.accept?.includes("didcomm/v2"))
  }

  async wsEndpoint(did: DID): Promise<MessagingServiceMetadata> {
    const services = await this.resolveDIDCommServices(did)
    const service = services.find((s: any) => s.serviceEndpoint.uri.startsWith("ws"))
    if (!service) throw new Error("No WebSocket endpoint found")
    return { id: service.id, service_endpoint: service.serviceEndpoint.uri }
  }

  async httpEndpoint(did: DID): Promise<MessagingServiceMetadata> {
    const services = await this.resolveDIDCommServices(did)
    // Prefer a direct HTTP endpoint
    const httpService = services.find((s: any) => s.serviceEndpoint.uri.startsWith("http"))
    if (httpService) {
      return { id: httpService.id, service_endpoint: httpService.serviceEndpoint.uri }
    }
    // Fall back: convert wss:// to https:// (mediators often accept HTTP POST on the same URL)
    const wssService = services.find((s: any) => s.serviceEndpoint.uri.startsWith("wss://"))
    if (wssService) {
      const httpsUri = wssService.serviceEndpoint.uri.replace(/^wss:\/\//, "https://")
      return { id: wssService.id, service_endpoint: httpsUri }
    }
    const wsService = services.find((s: any) => s.serviceEndpoint.uri.startsWith("ws://"))
    if (wsService) {
      const httpUri = wsService.serviceEndpoint.uri.replace(/^ws:\/\//, "http://")
      return { id: wsService.id, service_endpoint: httpUri }
    }
    throw new Error("No HTTP endpoint found")
  }

  async prepareMessage(
    to: DID,
    from: DID,
    message: DIDCommMessage
  ): Promise<[IMessage, string, PackEncryptedMetadata]> {
    const msg = new Message({
      id: uuidv4(),
      typ: "application/didcomm-plain+json",
      from: from,
      to: [to],
      body: message.body || {},
      created_time: Date.now(),
      ...message,
    })
    const [packed, meta] = await msg.pack_encrypted(
      to, from, null,
      this.resolver, this.secretsResolver,
      { forward: true }
    )
    if (!meta.messaging_service) {
      meta.messaging_service = await this.httpEndpoint(to)
    }
    return [msg.as_value(), packed, meta]
  }

  async unpackMessage(message: string): Promise<[Message, UnpackMetadata]> {
    return await Message.unpack(message, this.resolver, this.secretsResolver, {})
  }

  async sendMessageAndExpectReply(
    to: DID,
    from: DID,
    message: DIDCommMessage
  ): Promise<[Message, UnpackMetadata]> {
    const [_plaintext, packed, meta] = await this.prepareMessage(to, from, message)
    if (!meta.messaging_service) throw new Error("No messaging service found")

    const response = await fetch(meta.messaging_service.service_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/didcomm-encrypted+json" },
      body: packed,
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Error sending message: ${text}`)
    }
    const packedResponse = await response.text()
    return await this.unpackMessage(packedResponse)
  }

  async sendMessage(to: DID, from: DID, message: DIDCommMessage): Promise<void> {
    const [_plaintext, packed, meta] = await this.prepareMessage(to, from, message)
    if (!meta.messaging_service) throw new Error("No messaging service found")

    console.log("[DIDComm] sendMessage →", {
      to: to.slice(0, 30) + "...",
      endpoint: meta.messaging_service.service_endpoint,
      type: message.type,
      forwarded: meta.from_kid !== undefined,
    })

    const response = await fetch(meta.messaging_service.service_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/didcomm-encrypted+json" },
      body: packed,
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Error sending message: ${text}`)
    }
  }
}
