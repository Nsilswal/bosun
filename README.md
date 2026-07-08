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

Early. The current vertical slice: LAN-direct transport, QR pairing, live session streaming,
and the escalation approve/deny round-trip on a physical phone. Off-Wi-Fi peer-to-peer
transport (NAT hole-punching) is next — the transport interface is already designed for it.

## Quickstart

```sh
# on your laptop, in the workspace you want the agent to use:
npx bosun

# → prints a QR code. Scan it with the Bosun app to pair.
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for design, and [RELEASE.md](./RELEASE.md) for
building the mobile app.

## License

MIT
