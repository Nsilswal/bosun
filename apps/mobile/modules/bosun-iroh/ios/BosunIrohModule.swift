import ExpoModulesCore
import Foundation
import IrohLib

// Bosun's iroh ALPN — must match packages/transport/src/p2p/endpoint.ts
// (`BOSUN_ALPN = bytes of "bosun/1"`). Bump on any wire-incompatible change.
private let BOSUN_ALPN = Data("bosun/1".utf8)

/// Native iroh transport for the Bosun app: dials a supervisor by its endpoint
/// ticket over a NAT-traversing QUIC bi-stream and moves length-delimited
/// message frames. Everything above the byte pipe — Bosun's pairing, mutual-auth
/// handshake, allowlist, and NaCl encryption — runs in JS on top of this, exactly
/// as it does over the LAN WebSocket (see src/transport/native-iroh.ts).
///
/// This mirrors the verified Node client (packages/transport/src/p2p/{client,
/// framing}.ts) against iroh 1.0's Swift (uniffi) bindings.
public final class BosunIrohModule: Module {
  /// One live connection, keyed by the handle handed back to JS. We retain the
  /// `Endpoint` for the connection's whole life: iroh drops its driver future
  /// when the Endpoint is released ("endpoint driver future was dropped"),
  /// which kills the connection mid-session (learned the hard way in the Node
  /// client — see docs/adr/0001-p2p-transport.md).
  private final class IrohConn {
    let endpoint: Endpoint
    let connection: Connection
    let send: SendStream
    let recv: RecvStream
    var readTask: Task<Void, Never>?

    init(endpoint: Endpoint, connection: Connection, bi: BiStream) {
      self.endpoint = endpoint
      self.connection = connection
      self.send = bi.send()
      self.recv = bi.recv()
    }
  }

  private var conns: [String: IrohConn] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("BosunIroh")
    Events("onData", "onClose")

    // Dial a supervisor by its iroh ticket; resolve a connection handle.
    AsyncFunction("connect") { (ticket: String) async throws -> String in
      let handle = UUID().uuidString

      // n0 preset installs the rustls crypto provider and wires relays +
      // discovery — the same preset the Node client applies.
      let builder = EndpointBuilder()
      builder.applyN0()
      builder.alpns(alpns: [BOSUN_ALPN])
      let endpoint = try await builder.bind()

      let addr = try EndpointTicket.fromString(str: ticket).endpointAddr()
      let connection = try await endpoint.connect(addr: addr, alpn: BOSUN_ALPN)
      let bi = try await connection.openBi()

      let conn = IrohConn(endpoint: endpoint, connection: connection, bi: bi)
      self.put(handle, conn)
      self.startReadLoop(handle: handle, conn: conn)
      return handle
    }

    // Send one JS message frame; the native side length-delimits it.
    AsyncFunction("send") { (handle: String, data: String) async throws in
      guard let conn = self.get(handle) else { return }
      // iroh's SendStream serializes writes behind an internal mutex, so
      // concurrent frames can't interleave on the stream.
      try await conn.send.writeAll(buf: Self.frame(data))
    }

    Function("close") { (handle: String) in
      self.teardown(handle, notify: false)
    }

    OnDestroy {
      for handle in self.allHandles() { self.teardown(handle, notify: false) }
    }
  }

  // MARK: - Read loop

  private func startReadLoop(handle: String, conn: IrohConn) {
    conn.readTask = Task { [weak self] in
      guard let self else { return }
      do {
        while !Task.isCancelled {
          // 4-byte little-endian length prefix, then the UTF-8 body — mirrors
          // packages/transport/src/p2p/framing.ts.
          let header = try await conn.recv.readExact(size: 4)
          let len =
            UInt32(header[0]) | (UInt32(header[1]) << 8)
            | (UInt32(header[2]) << 16) | (UInt32(header[3]) << 24)
          let body = try await conn.recv.readExact(size: len)
          let text = String(decoding: body, as: UTF8.self)
          self.sendEvent("onData", ["handle": handle, "data": text])
        }
      } catch {
        // Stream ended or errored → surface a single close to JS.
        self.teardown(handle, notify: true)
      }
    }
  }

  // MARK: - Framing

  private static func frame(_ message: String) -> Data {
    let body = Data(message.utf8)
    let n = UInt32(body.count)
    var out = Data(capacity: 4 + body.count)
    out.append(UInt8(n & 0xFF))
    out.append(UInt8((n >> 8) & 0xFF))
    out.append(UInt8((n >> 16) & 0xFF))
    out.append(UInt8((n >> 24) & 0xFF))
    out.append(body)
    return out
  }

  // MARK: - Connection table (thread-safe)

  private func put(_ handle: String, _ conn: IrohConn) {
    lock.lock(); defer { lock.unlock() }
    conns[handle] = conn
  }

  private func get(_ handle: String) -> IrohConn? {
    lock.lock(); defer { lock.unlock() }
    return conns[handle]
  }

  private func allHandles() -> [String] {
    lock.lock(); defer { lock.unlock() }
    return Array(conns.keys)
  }

  private func teardown(_ handle: String, notify: Bool) {
    lock.lock()
    let conn = conns.removeValue(forKey: handle)
    lock.unlock()
    guard let conn else { return }
    conn.readTask?.cancel()
    // 0 = our normal application close code; empty reason.
    try? conn.connection.close(errorCode: 0, reason: Data())
    // Dropping the last reference to `conn` (and thus `endpoint`) lets iroh tear
    // the endpoint down cleanly now that the connection is finished.
    if notify { self.sendEvent("onClose", ["handle": handle]) }
  }
}
