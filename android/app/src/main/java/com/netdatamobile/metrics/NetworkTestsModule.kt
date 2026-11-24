package com.netdatamobile.metrics

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.InputStreamReader
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLException
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import kotlin.math.abs

class NetworkTestsModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "NetworkTests"

  // Les tests réseau sont bloquants : on les exécute dans un thread séparé
  private fun runAsync(promise: Promise, block: () -> Any?) {
    Thread {
      try {
        promise.resolve(block())
      } catch (e: Exception) {
        promise.reject("TEST_ERROR", e.message ?: e.toString(), e)
      }
    }.start()
  }

  private fun ms(start: Long, end: Long) = (end - start) / 1_000_000.0

  // Construit une requête DNS de type A
  private fun buildDnsQuery(domain: String, id: Int): ByteArray {
    val out = ByteArrayOutputStream()
    out.write(id shr 8); out.write(id and 0xFF)
    out.write(0x01); out.write(0x00)          // récursion demandée
    out.write(0x00); out.write(0x01)          // 1 question
    repeat(6) { out.write(0x00) }             // 0 réponse / autorité / additionnel
    domain.split(".").forEach { label ->
      out.write(label.length)
      out.write(label.toByteArray())
    }
    out.write(0x00)
    out.write(0x00); out.write(0x01)          // type A
    out.write(0x00); out.write(0x01)          // classe IN
    return out.toByteArray()
  }

  @ReactMethod
  fun dnsTest(domain: String, server: String, attempts: Int, promise: Promise) = runAsync(promise) {
    val times = mutableListOf<Double>()
    var failures = 0

    repeat(attempts) { i ->
      try {
        if (server == "system") {
          val start = System.nanoTime()
          InetAddress.getAllByName(domain)
          times.add(ms(start, System.nanoTime()))
        } else {
          DatagramSocket().use { socket ->
            socket.soTimeout = 3000
            val query = buildDnsQuery(domain, i + 1)
            val buf = ByteArray(512)
            val response = DatagramPacket(buf, buf.size)
            val start = System.nanoTime()
            socket.send(DatagramPacket(query, query.size, InetAddress.getByName(server), 53))
            socket.receive(response)
            val end = System.nanoTime()
            val rcode = buf[3].toInt() and 0x0F
            val answers = ((buf[6].toInt() and 0xFF) shl 8) or (buf[7].toInt() and 0xFF)
            if (rcode != 0 || answers == 0) throw Exception("Réponse DNS invalide (rcode $rcode)")
            times.add(ms(start, end))
          }
        }
      } catch (e: Exception) {
        failures++
      }
    }

    Arguments.createMap().apply {
      putString("domain", domain)
      putString("server", server)
      putDouble("avgMs", if (times.isEmpty()) -1.0 else times.average())
      putDouble("failureRate", failures * 100.0 / attempts)
    }
  }

  @ReactMethod
  fun tcpTest(host: String, port: Int, attempts: Int, promise: Promise) = runAsync(promise) {
    val address = InetAddress.getByName(host)
    val times = mutableListOf<Double>()
    var failures = 0

    repeat(attempts) {
      try {
        Socket().use { socket ->
          val start = System.nanoTime()
          socket.connect(InetSocketAddress(address, port), 3000)
          times.add(ms(start, System.nanoTime()))
        }
      } catch (e: Exception) {
        failures++
      }
    }

    val jitter = if (times.size > 1) times.zipWithNext { a, b -> abs(b - a) }.average() else 0.0

    Arguments.createMap().apply {
      putString("host", host)
      putInt("port", port)
      putDouble("avgMs", if (times.isEmpty()) -1.0 else times.average())
      putDouble("minMs", times.minOrNull() ?: -1.0)
      putDouble("maxMs", times.maxOrNull() ?: -1.0)
      putDouble("jitterMs", jitter)
      putDouble("lossPercent", failures * 100.0 / attempts)
    }
  }

  @ReactMethod
  fun httpTest(url: String, promise: Promise) = runAsync(promise) {
    val u = URL(url)
    val https = u.protocol == "https"
    val port = if (u.port != -1) u.port else if (https) 443 else 80
    val path = if (u.file.isNullOrEmpty()) "/" else u.file

    val t0 = System.nanoTime()
    val address = InetAddress.getByName(u.host)
    val t1 = System.nanoTime()

    val raw = Socket()
    raw.connect(InetSocketAddress(address, port), 5000)
    raw.soTimeout = 10000
    val t2 = System.nanoTime()

    val socket: Socket = if (https) {
      val factory = SSLSocketFactory.getDefault() as SSLSocketFactory
      val ssl = factory.createSocket(raw, u.host, port, true) as SSLSocket
      ssl.startHandshake()
      if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(u.host, ssl.session)) {
        ssl.close()
        throw SSLException("Certificat invalide pour ${u.host}")
      }
      ssl
    } else raw
    val t3 = System.nanoTime()

    socket.use { s ->
      val request = "GET $path HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: NetdataMobile\r\nConnection: close\r\n\r\n"
      s.getOutputStream().apply {
        write(request.toByteArray())
        flush()
      }
      val statusLine = BufferedReader(InputStreamReader(s.getInputStream())).readLine() ?: ""
      val t4 = System.nanoTime()

      Arguments.createMap().apply {
        putString("url", url)
        putDouble("dnsMs", ms(t0, t1))
        putDouble("tcpMs", ms(t1, t2))
        putDouble("tlsMs", if (https) ms(t2, t3) else -1.0)
        putDouble("responseMs", ms(t3, t4))
        putDouble("totalMs", ms(t0, t4))
        putInt("statusCode", statusLine.split(" ").getOrNull(1)?.toIntOrNull() ?: -1)
      }
    }
  }

  @ReactMethod
  fun downloadTest(url: String, promise: Promise) = runAsync(promise) {
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.connectTimeout = 5000
    conn.readTimeout = 10000

    var bytes = 0L
    val start = System.nanoTime()
    conn.inputStream.use { input ->
      val buf = ByteArray(16 * 1024)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        bytes += n
      }
    }
    val seconds = (System.nanoTime() - start) / 1e9
    conn.disconnect()

    Arguments.createMap().apply {
      putDouble("bytes", bytes.toDouble())
      putDouble("seconds", seconds)
      putDouble("mbps", bytes * 8 / seconds / 1e6)
    }
  }

  @ReactMethod
  fun uploadTest(url: String, sizeBytes: Int, promise: Promise) = runAsync(promise) {
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.connectTimeout = 5000
    conn.readTimeout = 10000
    conn.requestMethod = "POST"
    conn.doOutput = true
    conn.setFixedLengthStreamingMode(sizeBytes)
    conn.setRequestProperty("Content-Type", "application/octet-stream")

    val data = ByteArray(sizeBytes)
    val start = System.nanoTime()
    conn.outputStream.use { it.write(data) }
    val code = conn.responseCode
    val seconds = (System.nanoTime() - start) / 1e9
    conn.disconnect()

    Arguments.createMap().apply {
      putDouble("bytes", sizeBytes.toDouble())
      putDouble("seconds", seconds)
      putDouble("mbps", sizeBytes * 8 / seconds / 1e6)
      putInt("statusCode", code)
    }
  }
}