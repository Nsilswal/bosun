# Bosun

**Supervise your Claude Code agents from your phone.** Self-hosted, no accounts, and your agents never run on anyone else's machine.

Bosun lets you start a Claude Code session at your laptop and supervise it from a native mobile app — watch the live conversation, and approve or deny permission escalations from anywhere, so long-running agents don't stall waiting for you at the keyboard.

## How it works

- A **supervisor** runs on your machine. It owns agent sessions, driven through the
  [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).
- The **mobile app** (React Native / Expo) is a thin client onto the supervisor. It discovers
  the supervisor on your LAN, pairs via a QR code, and streams the session live.
- A **permission broker** sits in front of every tool call with three layers:
  1. a deterministic PreToolUse hard-floor hook that blocks never-cross actions no matter what,
  2. a policy engine that auto-approves the safe majority,
  3. an escalation queue — anything else blocks the agent until you approve or deny from the app.

## Trust model

- **Single-tenant by construction.** Every user runs their own supervisor. There is no hosted
  service, no accounts, no user database.
- **Keypair identity.** Devices are identified by Ed25519 keypairs exchanged during QR pairing.
  The supervisor only talks to a fixed allowlist of paired devices.
- **Encrypted transport.** All app↔supervisor traffic is end-to-end encrypted at the
  application layer (X25519 + XSalsa20-Poly1305), independent of the underlying network.

## Status

Early. Working: LAN-direct transport, QR pairing, live session streaming, and the
escalation approve/deny round-trip. Off-Wi-Fi peer-to-peer transport (iroh QUIC + NAT
hole-punching) is implemented and verified on the supervisor and a Node client
(`scripts/p2p-loopback.ts`). The app is transport-aware — it stores each supervisor's
P2P ticket and falls back LAN→P2P automatically — but reaching a supervisor over P2P
from the phone still needs a small native iroh module
([docs/mobile-p2p.md](./docs/mobile-p2p.md)). See
[ADR 0001](./docs/adr/0001-p2p-transport.md).

## Quickstart

The published one-liner (goal — not on npm yet):

```sh
# on your laptop, in the workspace you want the agent to use:
npx bosun          # → prints a QR code; scan it with the Bosun app to pair
```

Today, run the supervisor from source:

```sh
git clone https://github.com/Nsilswal/bosun && cd bosun
pnpm install                       # builds the workspace packages
pnpm dev /path/to/your/workspace   # starts the supervisor + prints the QR
```

You also need the app on your phone — see [RELEASE.md](./RELEASE.md) for the
EAS dev-build steps (it can't run in Expo Go). Phone and laptop must share a
LAN for this slice.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design.

## Repo layout

| Path | What |
|---|---|
| `packages/protocol` | Shared zod message schemas — the app↔supervisor contract |
| `packages/broker` | Policy engine, escalation queue, hard-floor hook |
| `packages/transport` | Transport interface + LAN-direct impl (mDNS, WS, NaCl handshake) |
| `packages/supervisor` | Owns Claude Code sessions via the Agent SDK; the `bosun` CLI |
| `apps/mobile` | The Expo app |

## Development

```sh
pnpm install     # install + build packages
pnpm test        # unit + integration tests across packages
pnpm typecheck   # type-check every package and the app
```

Run the real end-to-end demo (spawns an actual Claude agent on loopback and
drives an auto-approve, a phone-approved escalation, and a hard-deny):

```sh
pnpm --filter @bosun/supervisor exec tsx scripts/e2e-demo.ts
```

Verify the P2P transport (full pairing + handshake + protocol over real iroh QUIC,
loopback, relays disabled):

```sh
pnpm --filter @bosun/transport exec tsx scripts/p2p-loopback.ts
```

## License

MIT
