package expo.modules.bosuniroh

import computer.iroh.BiStream
import computer.iroh.Connection
import computer.iroh.Endpoint
import computer.iroh.EndpointBuilder
import computer.iroh.EndpointTicket
import computer.iroh.RecvStream
import computer.iroh.SendStream
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

// Bosun's iroh ALPN — must match packages/transport/src/p2p/endpoint.ts
// (`BOSUN_ALPN = bytes of "bosun/1"`). Bump on any wire-incompatible change.
private val BOSUN_ALPN = "bosun/1".toByteArray(Charsets.UTF_8)

/**
 * Native iroh transport for the Bosun app: dials a supervisor by its endpoint
 * ticket over a NAT-traversing QUIC bi-stream and moves length-delimited message
 * frames. Everything above the byte pipe — Bosun's pairing, mutual-auth
 * handshake, allowlist, and NaCl encryption — runs in JS on top of this, exactly
 * as it does over the LAN WebSocket (see src/transport/native-iroh.ts).
 *
 * Mirrors the verified Node client (packages/transport/src/p2p/{client,
 * framing}.ts) against iroh 1.0's Kotlin (uniffi) bindings.
 */
class BosunIrohModule : Module() {
  /**
   * One live connection, keyed by the handle handed back to JS. We retain the
   * [Endpoint] for the connection's whole life: iroh drops its driver future
   * when the Endpoint is released, killing the connection mid-session (learned
   * the hard way in the Node client — see docs/adr/0001-p2p-transport.md).
   */
  private class IrohConn(
    val endpoint: Endpoint,
    val connection: Connection,
    val send: SendStream,
    val recv: RecvStream,
  ) {
    var readJob: Job? = null
  }

  private val conns = ConcurrentHashMap<String, IrohConn>()
  private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

  override fun definition() = ModuleDefinition {
    Name("BosunIroh")
    Events("onData", "onClose")

    // Dial a supervisor by its iroh ticket; resolve a connection handle.
    AsyncFunction("connect") { ticket: String, promise: Promise ->
      scope.launch {
        try {
          val handle = UUID.randomUUID().toString()

          // n0 preset installs the rustls crypto provider and wires relays +
          // discovery — the same preset the Node client applies.
          val builder = EndpointBuilder()
          builder.applyN0()
          builder.alpns(listOf(BOSUN_ALPN))
          val endpoint = builder.bind()

          val addr = EndpointTicket.fromString(ticket).endpointAddr()
          val connection = endpoint.connect(addr, BOSUN_ALPN)
          val bi: BiStream = connection.openBi()

          val conn = IrohConn(endpoint, connection, bi.send(), bi.recv())
          conns[handle] = conn
          startReadLoop(handle, conn)
          promise.resolve(handle)
        } catch (e: Throwable) {
          promise.reject("ERR_IROH_CONNECT", e.message ?: "iroh connect failed", e)
        }
      }
    }

    // Send one JS message frame; the native side length-delimits it.
    AsyncFunction("send") { handle: String, data: String, promise: Promise ->
      val conn = conns[handle]
      if (conn == null) {
        promise.resolve(null)
        return@AsyncFunction
      }
      scope.launch {
        try {
          // iroh's SendStream serializes writes behind an internal mutex, so
          // concurrent frames can't interleave on the stream.
          conn.send.writeAll(frame(data))
          promise.resolve(null)
        } catch (e: Throwable) {
          promise.reject("ERR_IROH_SEND", e.message ?: "iroh send failed", e)
        }
      }
    }

    Function("close") { handle: String -> teardown(handle, notify = false) }

    OnDestroy {
      conns.keys.toList().forEach { teardown(it, notify = false) }
      scope.cancel()
    }
  }

  private fun startReadLoop(handle: String, conn: IrohConn) {
    conn.readJob =
      scope.launch {
        try {
          while (isActive) {
            // 4-byte little-endian length prefix, then the UTF-8 body — mirrors
            // packages/transport/src/p2p/framing.ts.
            val header = conn.recv.readExact(4u)
            val len =
              (header[0].toInt() and 0xFF) or
                ((header[1].toInt() and 0xFF) shl 8) or
                ((header[2].toInt() and 0xFF) shl 16) or
                ((header[3].toInt() and 0xFF) shl 24)
            val body = conn.recv.readExact(len.toUInt())
            val text = String(body, Charsets.UTF_8)
            sendEvent("onData", mapOf("handle" to handle, "data" to text))
          }
        } catch (e: Throwable) {
          // Stream ended or errored → surface a single close to JS.
          teardown(handle, notify = true)
        }
      }
  }

  private fun frame(message: String): ByteArray {
    val body = message.toByteArray(Charsets.UTF_8)
    val out = ByteArray(4 + body.size)
    out[0] = (body.size and 0xFF).toByte()
    out[1] = ((body.size ushr 8) and 0xFF).toByte()
    out[2] = ((body.size ushr 16) and 0xFF).toByte()
    out[3] = ((body.size ushr 24) and 0xFF).toByte()
    body.copyInto(out, 4)
    return out
  }

  private fun teardown(handle: String, notify: Boolean) {
    val conn = conns.remove(handle) ?: return
    conn.readJob?.cancel()
    // 0 = our normal application close code; empty reason.
    runCatching { conn.connection.close(0L, ByteArray(0)) }
    // Dropping the last reference to `conn` (and thus `endpoint`) lets iroh tear
    // the endpoint down cleanly now that the connection is finished.
    if (notify) sendEvent("onClose", mapOf("handle" to handle))
  }
}
