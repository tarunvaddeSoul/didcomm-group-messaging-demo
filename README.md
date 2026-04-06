# DIDComm v2 Group Chat

Browser-based, end-to-end encrypted group messaging built on [DIDComm v2](https://identity.foundation/didcomm-messaging/spec/v2.1/) and the [Group Messaging Protocol 1.0](https://github.com/tarunvaddeSoul/didcomm-group-messaging).

No servers. No accounts. No metadata leakage. Just decentralized, peer-to-peer group chat with forward secrecy.

## Why

DIDComm v2 provides excellent pairwise encrypted messaging, but has no standard for **group communication**. Naively sending N pairwise messages means O(N) encryptions per message — it doesn't scale.

This project implements a Group Messaging Protocol that achieves **O(1) per-message encryption** using a shared symmetric Group Content Key (GCK), while preserving DIDComm's privacy and security guarantees:

- **Forward secrecy** — removed members can't decrypt future messages
- **Epoch-based key management** — keys rotate on membership changes, on schedule, or on demand
- **Tamper-evident history** — epoch hash chain binds state transitions cryptographically
- **Mediator-untrusted** — the mediator routes encrypted blobs; it never sees plaintext, membership, or keys
- **Decentralized** — no central server; any DIDComm v2 mediator works

## Architecture

```
  ┌──────────────────────────────────────────────────────────────┐
  │                    BROWSER TAB (Agent)                       │
  │                                                              │
  │  ┌────────────────────┐     postMessage      ┌───────────┐  │
  │  │  React UI          │ ◄──────────────────► │ Web Worker │  │
  │  │  (ChatView,        │                      │            │  │
  │  │   ConnectScreen)   │                      │  Protocol  │  │
  │  │                    │                      │  Engine    │  │
  │  │  useDIDComm hook   │                      │            │  │
  │  └────────────────────┘                      │  Groups    │  │
  │                                              │  Crypto    │  │
  │                                              │  DIDComm   │  │
  │                                              └─────┬──────┘  │
  │                                                    │         │
  └────────────────────────────────────────────────────┼─────────┘
                                                       │
                              WebSocket (live delivery) │ HTTP POST (send)
                                                       │
                              ┌─────────────────────────┴──────┐
                              │        DIDComm v2 Mediator     │
                              │   (Coordinate Mediation 3.0)   │
                              │   (Message Pickup 3.0)         │
                              │                                │
                              │   • Routes encrypted blobs     │
                              │   • Cannot read content        │
                              │   • Cannot see membership      │
                              └─────────────────────────┬──────┘
                                                       │
                              WebSocket (live delivery) │ HTTP POST (send)
                                                       │
  ┌────────────────────────────────────────────────────┼─────────┐
  │                    BROWSER TAB (Agent)              │         │
  │                                              ┌─────┴──────┐  │
  │  ┌────────────────────┐                      │ Web Worker │  │
  │  │  React UI          │ ◄──────────────────► │  Protocol  │  │
  │  └────────────────────┘     postMessage      │  Engine    │  │
  │                                              └────────────┘  │
  └──────────────────────────────────────────────────────────────┘
```

Each browser tab is an independent agent with its own DID, keys, and group state. The mediator is just a relay — it queues and forwards encrypted DIDComm messages.

## How It Works

### Group Content Key (GCK)

Instead of encrypting every message N times (once per member), the admin generates a single AES-256-GCM symmetric key — the **GCK** — and distributes it to all members via pairwise DIDComm authcrypt:

```
Traditional DIDComm group:          This protocol:

  Sender encrypts N times           Sender encrypts ONCE with GCK
  (one per recipient)               (same key for all members)

  O(N) encryptions per message      O(1) encryption per message
```

### Epochs

Every membership change or key rotation advances the **epoch** (a monotonically increasing counter). Each epoch has:

- A unique GCK (fresh random, never derived from previous)
- An epoch hash chaining to the previous state

```
Epoch 0          Epoch 1              Epoch 2
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│ GCK_0    │     │ GCK_1        │     │ GCK_2        │
│ Members: │ ──► │ Members:     │ ──► │ Members:     │
│  Alice   │     │  Alice, Bob  │     │  Alice, Bob  │
│  Bob     │     │  Bob, Carol  │     │              │
│          │     │              │     │ (Carol left) │
│ hash_0   │     │ hash_1       │     │ hash_2       │
└──────────┘     └──────────────┘     └──────────────┘
                   │                    │
                   │ Carol added        │ Carol removed
                   │ new GCK generated  │ new GCK generated
                   │                    │ Carol can't decrypt
                   │                    │ future messages
```

### Message Encryption

```
Plaintext: "Hello everyone"

     ┌───────────────────────────────────────────────┐
     │              AES-256-GCM Encrypt              │
     │                                               │
     │  Key: GCK (current epoch)                     │
     │  IV:  96-bit random                           │
     │  AAD: group_id + "." + epoch + "." + sender   │
     │                                               │
     │  Output: ciphertext + 128-bit auth tag        │
     └───────────────────────────────────────────────┘
                          │
                          ▼
     ┌───────────────────────────────────────────────┐
     │            Delivery Envelope                  │
     │                                               │
     │  { group_id, epoch, sender,                   │
     │    ciphertext, iv, tag }                      │
     └───────────────────────────────────────────────┘
                          │
                          ▼
     ┌───────────────────────────────────────────────┐
     │        DIDComm Pairwise Authcrypt             │
     │        (one per recipient member)             │
     │                                               │
     │  Encrypted for each member's DID              │
     │  Sent via HTTP POST to mediator               │
     └───────────────────────────────────────────────┘
```

### Protocol Message Flow

```
Alice (admin)                Mediator               Bob             Carol
     │                          │                    │                │
     │──── CREATE ──────────────┼───────────────────►│                │
     │──── CREATE ──────────────┼────────────────────┼───────────────►│
     │                          │                    │                │
     │◄─── CREATE-ACK ─────────┼────────────────────│                │
     │◄─── CREATE-ACK ─────────┼────────────────────┼────────────────│
     │                          │                    │                │
     │          Group active at epoch 0              │                │
     │                          │                    │                │
     │──── DELIVERY ────────────┼───────────────────►│                │
     │──── DELIVERY ────────────┼────────────────────┼───────────────►│
     │                          │                    │                │
     │          Bob sends a message                  │                │
     │                          │                    │                │
     │◄─── DELIVERY ────────────┼────────────────────│                │
     │                          │                    │──── DELIVERY ──┼►
     │                          │                    │                │
     │     Alice removes Carol — epoch 0 → 1         │                │
     │                          │                    │                │
     │──── REMOVE-MEMBER ───────┼───────────────────►│ (new GCK)     │
     │──── REMOVE-MEMBER ───────┼────────────────────┼───────────────►│ (no GCK)
     │                          │                    │                │
     │          Carol can no longer decrypt           │                │
     │          Future messages use GCK_1             │              [LEFT]
```

## Running the Demo

### Prerequisites

- Node.js 18+ and npm
- Two browser tabs (one per agent)
- Internet connection (for the public mediator)

### Quick Start

```bash
# Clone and install
git clone https://github.com/tarunvaddeSoul/didcomm-group-messaging-demo.git
cd didcomm-group-messaging-demo
npm install

# Start the dev server
npm start
```

The app opens at `http://localhost:9000`.

### Step-by-Step Demo

**1. Open two browser tabs** both pointing to `http://localhost:9000`.

**2. Connect both agents:**


| Tab 1 (Admin)                   | Tab 2 (Member)                  |
| ------------------------------- | ------------------------------- |
| Display Name: `Faber`           | Display Name: `Alice`           |
| Mediator DID: *(leave default)* | Mediator DID: *(leave default)* |
| Click **Connect**               | Click **Connect**               |


Both tabs connect to the [Indicio public mediator](https://us-east2.public.mediator.indiciotech.io) via WebSocket. Each agent generates a unique `did:peer:4` DID.

**3. Copy Alice's DID:**

In Alice's tab, click the truncated DID below her name to copy it to clipboard.

**4. Create a group from Faber:**

- Click the **+** button in Faber's sidebar
- Group Name: `Team Chat`
- Paste Alice's DID, enter name `Alice`, click **Add**
- Click **Create Group**

**5. Verify on Alice's tab:**

Alice's sidebar should show the new group. Both agents now share:

- The same Group Content Key (GCK)
- Epoch 0
- Matching epoch hashes

**6. Send messages:**

Type messages in either tab — they're encrypted with the shared GCK and delivered via the mediator.

**7. Try admin actions (from Faber's tab):**


| Action       | Button   | What happens                        |
| ------------ | -------- | ----------------------------------- |
| View members | 👥 icon  | Shows member list with roles        |
| Add member   | 👤+ icon | Advances epoch, distributes new GCK |
| Rotate key   | 🔑 icon  | Generates new GCK, advances epoch   |
| Dissolve     | 🗑 icon  | Permanently terminates the group    |


### Important Notes

- **State is in-memory only** — refreshing a tab loses all DIDs, keys, and group state
- **COOP/COEP headers required** — the dev server sets these for WebAssembly support
- Both agents must be connected before creating a group (the mediator queues messages, but live delivery requires an active WebSocket)

## Project Structure

```
src/
├── index.tsx                  # React entry point
├── App.tsx                    # Root component (connect vs chat routing)
├── styles.css                 # Full design system
├── components/
│   ├── ConnectScreen.tsx      # Mediator connection UI
│   └── ChatView.tsx           # Chat UI (sidebar, messages, modals)
├── hooks/
│   └── useDIDComm.ts          # React hook — bridges UI ↔ Web Worker
├── lib/
│   ├── worker.ts              # Web Worker — protocol state machine
│   ├── didcomm.ts             # DIDComm service (pack/unpack, DID resolution)
│   ├── peer2.ts               # did:peer:2 generation & resolution
│   └── peer4.ts               # did:peer:4 generation & resolution
└── protocol/
    ├── types.ts               # Message type constants & body interfaces
    └── crypto.ts              # AES-256-GCM, GCK management, epoch hashing

docs/
└── protocols/
    └── group-messaging/
        └── 1.0/
            └── readme.md      # Full protocol specification
```

## Tech Stack


| Layer     | Technology                                               |
| --------- | -------------------------------------------------------- |
| Protocol  | DIDComm v2 (WASM), Group Messaging 1.0                   |
| Crypto    | WebCrypto API (AES-256-GCM, SHA-256)                     |
| DIDs      | did:peer:2, did:peer:4, did:web, did:key                 |
| Keys      | Ed25519 (signing), X25519 (encryption) via @noble/curves |
| Transport | WebSocket (live delivery), HTTP (message send)           |
| Mediation | Coordinate Mediation 3.0, Message Pickup 3.0             |
| UI        | React 18, TypeScript, Webpack 5                          |
| Fonts     | Space Grotesk (UI), Fira Code (technical data)           |


## Security Model


| Property          | Guarantee                                                            |
| ----------------- | -------------------------------------------------------------------- |
| Confidentiality   | Double encryption: GCK (group) + DIDComm authcrypt (pairwise)        |
| Forward secrecy   | New GCK per epoch; removed members can't decrypt future messages     |
| Authentication    | DIDComm authcrypt proves sender identity                             |
| Replay protection | Message ID deduplication (capped set)                                |
| Tamper evidence   | Epoch hash chain binds all state transitions                         |
| Mediator trust    | Zero trust — mediator sees only encrypted blobs and routing metadata |


### What the mediator CAN see

- Group ID (in delivery envelopes)
- Sender/recipient DIDs
- Message timing and approximate size
- That a group exists

### What the mediator CANNOT see

- Message content
- Group membership list
- Group name or policies
- Encryption keys (GCK or private keys)

## Protocol Specification

The full protocol specification is at `[https://github.com/tarunvaddeSoul/didcomm-group-messaging](./docs/protocols/group-messaging/1.0/readme.md)`.

### Message Types


| Category       | Messages                                                             |
| -------------- | -------------------------------------------------------------------- |
| Lifecycle      | `create`, `create-ack`                                               |
| Messaging      | `delivery` (wraps GCK-encrypted content)                             |
| Membership     | `add-member`, `add-member-ack`, `remove-member`, `remove-member-ack` |
| Key Mgmt       | `key-rotate`, `key-rotate-ack`                                       |
| Member Actions | `leave`, `leave-ack`                                                 |
| State Sync     | `info-request`, `info`                                               |
| Termination    | `dissolve`, `dissolve-ack`                                           |


### Admin State Machine

```
                  ┌──────────┐
      create ──►  │ CREATED  │
                  └────┬─────┘
                       │ members ack
                       ▼
           ┌──────────────────────┐
  ┌───────►│       ACTIVE         │◄────────┐
  │        └──────────┬───────────┘         │
  │                   │                     │
  │          membership change         all acks
  │          or key rotation           received
  │                   │                     │
  │        ┌──────────▼───────────┐         │
  └────────│   EPOCH_ADVANCING    ├─────────┘
           └──────────┬───────────┘
                      │ dissolve
                      ▼
                ┌───────────┐
                │ DISSOLVED │
                └───────────┘
```

## License

MIT