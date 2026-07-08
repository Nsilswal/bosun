# Bosun Architecture

## Overview

```
┌──────────────┐         transport          ┌──────────────────────────────┐
│  Mobile app  │◄──────────────────────────►│         Supervisor           │
│ (Expo, thin  │   e2e-encrypted protocol   │  owns sessions, source of    │
│   client)    │   (LAN now, P2P later)     │  truth                       │
└──────────────┘                            │                              │
                                            │  ┌────────────────────────┐  │
       QR pairing (key exchange)            │  │ AgentRunner (Claude    │  │
                                            │  │ Agent SDK, streaming)  │  │
                                            │  └───────────┬────────────┘  │
                                            │              │ tool calls    │
                                            │  ┌───────────▼────────────┐  │
                                            │  │   Permission broker    │  │
                                            │  │ policy → escalation Q  │  │
                                            │  └────────────────────────┘  │
                                            └──────────────────────────────┘
```

**The supervisor owns the session and is the source of truth.** Every surface — the mobile
app today, other clients later — attaches over the transport layer. The supervisor runs
headless; the app is optional at any given moment.

**Single-tenant by construction.** Each user runs their own supervisor on their own machine.
No hosted service, no accounts, no user database. Agents never run on third-party
infrastructure.

## Packages

| Package | Role |
|---|---|
| `packages/protocol` | zod schemas + types for every app↔supervisor message. The only contract. |
| `packages/transport` | `TransportServer`/`TransportClient`/`PeerConnection` interfaces + LAN-direct impl (mDNS + WebSocket + app-layer crypto). P2P impl lands here next. |
| `packages/broker` | Pure `PolicyEngine`, blocking `EscalationQueue`, `PermissionBroker`, hook adapters, and the hard-floor PreToolUse hook script. |
| `packages/supervisor` | Composition root + CLI. AgentRunner (Claude Agent SDK), pairing, device allowlist, protocol server. |
| `apps/mobile` | Expo app (dev client). Discovery, QR pairing, live session view, escalation cards, push. |

## Permission model — three layers

1. **Hard floor (deterministic).** A PreToolUse hook script installed for every session.
   It encodes never-cross rules (writes outside the workspace, `git push`, destructive
   deletes) and blocks by **exiting with code 2** — the only exit code Claude Code treats
   as blocking. It runs before the model-facing layers and holds even under prompt
   injection, because it never consults the model. Failure mode is fail-closed: internal
   errors exit 2.

2. **Policy engine (programmatic).** One pure `PolicyEngine` evaluated by the
   `PermissionBroker`. For supervisor-owned SDK sessions the broker is wired into a
   **PreToolUse hook, not (only) `canUseTool`** — empirically, Claude Code auto-approves
   some tool calls internally (e.g. read-only Bash like `ls`), and those never reach
   `canUseTool`. Hooks fire for every tool call unconditionally, so the hook asks the
   broker and returns `permissionDecision: allow|deny`; `canUseTool` stays wired as a
   fallback for any path that skips hooks. Sessions also run with `settingSources: []`
   and default permission mode so user allow-rules can't bypass the broker. Interactive
   `claude` sessions on the laptop will use the same hook shape via settings (later
   slice).

   Starter policy: allow file reads and in-workspace edits; escalate Bash and anything
   touching git; hard-deny the destructive set.

3. **Escalation queue.** Anything the policy can't clear becomes a pending decision pushed
   to paired devices. The agent's tool call **blocks** until a device approves or denies.
   Escalations expire after a configurable timeout and **deny by default** — hook timeouts
   (600 s default) and the `canUseTool` abort signal mean an unbounded block would fail in
   an undefined way otherwise.

## Identity & pairing

- Every device (supervisor included) has an **Ed25519 keypair**. No accounts.
- Pairing: the supervisor prints a QR code containing its public key, reachable addresses,
  and a short-lived single-use pairing token. Scanning proves physical proximity; the app
  submits the token with its public key and is added to the supervisor's allowlist.
- Every connection thereafter performs a mutual challenge/response: both sides prove
  possession of their private key, then derive X25519 session keys
  (libsodium `crypto_kx`) and encrypt all frames with XSalsa20-Poly1305.
- The supervisor rejects connections from any public key not on the allowlist.
- We deliberately use app-layer encryption over plain WebSocket instead of self-signed TLS:
  React Native's TLS-pinning story is poor, and the keypair identity model carries directly
  into the P2P transport (iroh/libp2p use the same construction).

## Transport

One interface, multiple implementations. Callers (supervisor core, app screens) only ever
see authenticated `PeerConnection`s keyed by public key — never addresses, sockets, or NAT
concerns.

- **LAN-direct (implemented):** supervisor advertises via mDNS/Bonjour; app discovers it;
  WebSocket + the handshake above. Zero infrastructure.
- **P2P (supervisor + Node client implemented; mobile native module pending):** the
  supervisor embeds [iroh](https://iroh.computer) (QUIC + NAT traversal) for a direct
  encrypted path off-Wi-Fi, with an encrypted relay fallback where hole-punching fails.
  iroh only provides the byte pipe — Bosun's identity, pairing, allowlist, and NaCl
  encryption ride on top of a QUIC stream unchanged, so it's one security model across
  both transports. The relay/signaling choice (`n0` public relays, `disabled`, or
  self-hosted `custom` URLs) is injected as config, never baked into callers. See
  [ADR 0001](./docs/adr/0001-p2p-transport.md) for the iroh-over-libp2p decision.
- **Manual URL:** escape hatch for users with their own tunnel.

Callers select a transport through `createTransportServer({ kind: "lan" | "p2p", … })`
and only ever see `TransportServer` / `PeerConnection`; the LAN and P2P server handshakes
share one socket-agnostic core (`server-core` + `client-core`), so the wire protocol is
identical regardless of the underlying pipe.

## Session handoff (design; not in current slice)

Interactive `claude` on the laptop runs with the broker's hooks injected, so the same
policy and hard floor apply. Handoff = the supervisor resumes the session by `session_id`
(SDK `resume`) and the app attaches. One active driver at a time; the interactive session
must exit before the supervisor resumes it, to avoid transcript divergence. Live
simultaneous mirroring is explicitly out of scope for now.

## Privacy notes

- Push notifications route through Expo's push service. Payloads are therefore generic
  ("approval pending") — tool names, commands, and paths travel only over the encrypted
  transport.
- With LAN-direct transport, no traffic leaves your network. With the future P2P
  transport, only the encrypted handshake touches signaling infrastructure; agent traffic
  is peer-to-peer.

## Provider support

Claude Code is the target. The agent integration is behind the `AgentRunner` interface so
other backends can slot in later; provider-agnosticism is a non-goal for now.
