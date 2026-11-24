package com.netdatamobile.metrics

import android.app.Activity
import android.app.AppOpsManager
import android.app.usage.NetworkStats
import android.app.usage.NetworkStatsManager
import android.content.Intent
import android.net.ConnectivityManager
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.Process
import android.provider.Settings
import android.system.OsConstants
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors

/**
 * VPN local qui intercepte uniquement les requêtes DNS (route vers une IP DNS virtuelle).
 * Le reste du trafic ne passe pas par le VPN : internet fonctionne normalement.
 * Chaque requête est relayée vers le DNS du réseau réel, puis enregistrée (domaine, temps, app...).
 */
class DnsVpnService : VpnService() {

  companion object {
    const val ACTION_START = "com.netdatamobile.vpn.START"
    const val ACTION_STOP = "com.netdatamobile.vpn.STOP"
    const val VPN_ADDRESS = "10.111.222.1"
    const val VPN_DNS = "10.111.222.2"
    const val MAX_EVENTS = 5000

    // Événements DNS en attente, lus par FlowMonitorModule
    val events = ConcurrentLinkedQueue<Map<String, Any?>>()
    @Volatile var running = false
  }

  private var tun: ParcelFileDescriptor? = null
  private var reader: Thread? = null
  private val pool = Executors.newFixedThreadPool(4)

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopVpn()
      stopSelf()
      return START_NOT_STICKY
    }
    if (tun == null) startVpn()
    return START_STICKY
  }

  private fun startVpn() {
    val iface = Builder()
      .setSession("NetData DNS")
      .addAddress(VPN_ADDRESS, 32)
      .addDnsServer(VPN_DNS)
      .addRoute(VPN_DNS, 32)                   // seul le trafic DNS entre dans le VPN
      .addDisallowedApplication(packageName)   // notre app garde le réseau réel
      .setBlocking(true)
      .establish() ?: return
    tun = iface
    running = true

    val input = FileInputStream(iface.fileDescriptor)
    val output = FileOutputStream(iface.fileDescriptor)
    reader = Thread {
      val buf = ByteArray(32767)
      try {
        while (!Thread.interrupted()) {
          val n = input.read(buf)
          if (n > 0) {
            val packet = buf.copyOf(n)
            pool.execute { handlePacket(packet, output) }
          }
        }
      } catch (e: Exception) {
        // interface fermée : fin du VPN
      }
    }.also { it.start() }
  }

  private fun stopVpn() {
    running = false
    reader?.interrupt()
    reader = null
    try { tun?.close() } catch (e: Exception) {}
    tun = null
  }

  override fun onRevoke() {
    stopVpn()
    stopSelf()
  }

  override fun onDestroy() {
    stopVpn()
    pool.shutdownNow()
    super.onDestroy()
  }

  /* ---------- Traitement d'un paquet ---------- */

  private fun u16(b: ByteArray, i: Int) = ((b[i].toInt() and 0xFF) shl 8) or (b[i + 1].toInt() and 0xFF)

  private fun handlePacket(p: ByteArray, output: FileOutputStream) {
    if (p.size < 28 || (p[0].toInt() shr 4) != 4) return   // IPv4 uniquement
    val ihl = (p[0].toInt() and 0x0F) * 4
    if (p[9].toInt() != 17 || p.size < ihl + 8) return       // UDP uniquement
    val srcIp = p.copyOfRange(12, 16)
    val dstIp = p.copyOfRange(16, 20)
    val srcPort = u16(p, ihl)
    if (u16(p, ihl + 2) != 53) return

    val query = p.copyOfRange(ihl + 8, p.size)
    val question = parseQuestion(query) ?: return
    val app = ownerApp(srcIp, srcPort)

    val start = System.nanoTime()
    var response: ByteArray? = null
    try {
      DatagramSocket().use { s ->
        s.soTimeout = 5000
        s.send(DatagramPacket(query, query.size, upstreamDns(), 53))
        val rb = ByteArray(4096)
        val rp = DatagramPacket(rb, rb.size)
        s.receive(rp)
        response = rb.copyOf(rp.length)
      }
      val reply = buildUdpPacket(dstIp, srcIp, 53, srcPort, response!!)
      synchronized(output) { output.write(reply) }
    } catch (e: Exception) {
      // pas de réponse (timeout) : l'application cliente réessaiera
    }
    val dnsMs = (System.nanoTime() - start) / 1_000_000.0
    recordEvent(question.first, question.second, dnsMs, response, app)
  }

  // DNS du réseau réel (Wi-Fi ou mobile), notre app étant exclue du VPN
  private fun upstreamDns(): InetAddress {
    val cm = getSystemService(ConnectivityManager::class.java)
    val servers = cm.activeNetwork?.let { cm.getLinkProperties(it)?.dnsServers }.orEmpty()
    return servers.firstOrNull { it is Inet4Address } ?: servers.firstOrNull() ?: InetAddress.getByName("8.8.8.8")
  }

  private fun ownerApp(srcIp: ByteArray, srcPort: Int): String? = try {
    val cm = getSystemService(ConnectivityManager::class.java)
    val uid = cm.getConnectionOwnerUid(
      OsConstants.IPPROTO_UDP,
      InetSocketAddress(InetAddress.getByAddress(srcIp), srcPort),
      InetSocketAddress(InetAddress.getByName(VPN_DNS), 53)
    )
    if (uid >= 0) packageManager.getNameForUid(uid) ?: uid.toString() else null
  } catch (e: Exception) {
    null
  }

  private fun recordEvent(domain: String, qtype: Int, dnsMs: Double, response: ByteArray?, app: String?) {
    val rcode = response?.let { it[3].toInt() and 0x0F } ?: -1
    events.add(mapOf(
      "timestamp" to System.currentTimeMillis().toDouble(),
      "domain" to domain,
      "query_type" to qtypeName(qtype),
      "dns_time" to dnsMs,
      "rcode" to rcode,
      "success" to (rcode == 0),
      "resolved_ips" to (response?.let { parseAnswers(it) } ?: emptyList<String>()),
      "app" to app,
    ))
    while (events.size > MAX_EVENTS) events.poll()
  }

  private fun qtypeName(t: Int) = when (t) {
    1 -> "A"; 5 -> "CNAME"; 12 -> "PTR"; 16 -> "TXT"; 28 -> "AAAA"; 33 -> "SRV"; 65 -> "HTTPS"
    else -> t.toString()
  }

  /* ---------- Lecture / écriture DNS et IP ---------- */

  private fun parseQuestion(d: ByteArray): Pair<String, Int>? {
    if (d.size < 17) return null
    var i = 12
    val labels = mutableListOf<String>()
    while (i < d.size) {
      val len = d[i].toInt() and 0xFF
      if (len == 0) { i++; break }
      if (len > 63 || i + 1 + len > d.size) return null
      labels.add(String(d, i + 1, len, Charsets.US_ASCII))
      i += 1 + len
    }
    if (i + 2 > d.size) return null
    return labels.joinToString(".") to u16(d, i)
  }

  private fun skipName(d: ByteArray, start: Int): Int {
    var i = start
    while (true) {
      val len = d[i].toInt() and 0xFF
      if (len == 0) return i + 1
      if (len and 0xC0 == 0xC0) return i + 2   // pointeur de compression
      i += 1 + len
    }
  }

  private fun parseAnswers(d: ByteArray): List<String> {
    val ips = mutableListOf<String>()
    try {
      var i = 12
      repeat(u16(d, 4)) { i = skipName(d, i) + 4 }
      repeat(u16(d, 6)) {
        i = skipName(d, i)
        val type = u16(d, i)
        val rdLen = u16(d, i + 8)
        val rdStart = i + 10
        if ((type == 1 && rdLen == 4) || (type == 28 && rdLen == 16)) {
          InetAddress.getByAddress(d.copyOfRange(rdStart, rdStart + rdLen)).hostAddress?.let { ips.add(it) }
        }
        i = rdStart + rdLen
      }
    } catch (e: Exception) {
      // réponse tronquée : on garde ce qui a été lu
    }
    return ips
  }

  private fun buildUdpPacket(src: ByteArray, dst: ByteArray, srcPort: Int, dstPort: Int, payload: ByteArray): ByteArray {
    val total = 28 + payload.size
    val p = ByteArray(total)
    p[0] = 0x45
    p[2] = (total shr 8).toByte(); p[3] = total.toByte()
    p[8] = 64          // TTL
    p[9] = 17          // UDP
    System.arraycopy(src, 0, p, 12, 4)
    System.arraycopy(dst, 0, p, 16, 4)
    val cs = ipChecksum(p)
    p[10] = (cs shr 8).toByte(); p[11] = cs.toByte()
    p[20] = (srcPort shr 8).toByte(); p[21] = srcPort.toByte()
    p[22] = (dstPort shr 8).toByte(); p[23] = dstPort.toByte()
    val udpLen = 8 + payload.size
    p[24] = (udpLen shr 8).toByte(); p[25] = udpLen.toByte()
    // somme de contrôle UDP laissée à 0 : autorisé en IPv4
    System.arraycopy(payload, 0, p, 28, payload.size)
    return p
  }

  private fun ipChecksum(b: ByteArray): Int {
    var sum = 0
    for (i in 0 until 20 step 2) sum += u16(b, i)
    while (sum shr 16 != 0) sum = (sum and 0xFFFF) + (sum shr 16)
    return sum.inv() and 0xFFFF
  }
}

class FlowMonitorModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val REQUEST_VPN = 4201
  }

  private var pendingPromise: Promise? = null

  init {
    reactContext.addActivityEventListener(object : BaseActivityEventListener() {
      override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST_VPN) return
        if (resultCode == Activity.RESULT_OK) {
          launchVpn()
          pendingPromise?.resolve(true)
        } else {
          pendingPromise?.resolve(false)
        }
        pendingPromise = null
      }
    })
  }

  override fun getName() = "FlowMonitor"

  private fun launchVpn() {
    reactContext.startService(Intent(reactContext, DnsVpnService::class.java).setAction(DnsVpnService.ACTION_START))
  }

  // Demande l'autorisation VPN à l'utilisateur (une seule fois), puis démarre le VPN
  @ReactMethod
  fun startVpn(promise: Promise) {
    val consent = VpnService.prepare(reactContext)
    if (consent == null) {
      launchVpn()
      promise.resolve(true)
      return
    }
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "L'application doit être au premier plan")
      return
    }
    pendingPromise = promise
    activity.startActivityForResult(consent, REQUEST_VPN)
  }

  @ReactMethod
  fun stopVpn(promise: Promise) {
    reactContext.startService(Intent(reactContext, DnsVpnService::class.java).setAction(DnsVpnService.ACTION_STOP))
    promise.resolve(null)
  }

  @ReactMethod
  fun isVpnRunning(promise: Promise) {
    promise.resolve(DnsVpnService.running)
  }

  // Retourne et vide les événements DNS en attente
  @ReactMethod
  fun getDnsEvents(promise: Promise) {
    val arr = Arguments.createArray()
    var count = 0
    while (count < 2000) {
      val event = DnsVpnService.events.poll() ?: break
      arr.pushMap(Arguments.makeNativeMap(event))
      count++
    }
    promise.resolve(arr)
  }

  /* ---------- Volumes par application (NetworkStatsManager) ---------- */

  @ReactMethod
  fun hasUsageAccess(promise: Promise) {
    val appOps = reactContext.getSystemService(AppOpsManager::class.java)
    val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), reactContext.packageName)
    } else {
      @Suppress("DEPRECATION")
      appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), reactContext.packageName)
    }
    promise.resolve(mode == AppOpsManager.MODE_ALLOWED)
  }

  @ReactMethod
  fun openUsageAccessSettings(promise: Promise) {
    reactContext.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    promise.resolve(null)
  }

  private fun appName(uid: Int): String = when (uid) {
    -4 -> "applications désinstallées"
    -5 -> "partage de connexion"
    else -> reactContext.packageManager.getNameForUid(uid) ?: uid.toString()
  }

  @Suppress("DEPRECATION")
  @ReactMethod
  fun getAppTraffic(startMs: Double, endMs: Double, promise: Promise) {
    Thread {
      try {
        val nsm = reactContext.getSystemService(NetworkStatsManager::class.java)
        val totals = HashMap<Int, LongArray>() // uid -> [wifi rx, wifi tx, mobile rx, mobile tx]

        for ((type, idx) in listOf(ConnectivityManager.TYPE_WIFI to 0, ConnectivityManager.TYPE_MOBILE to 2)) {
          val stats = nsm.querySummary(type, null, startMs.toLong(), endMs.toLong())
          val bucket = NetworkStats.Bucket()
          while (stats.hasNextBucket()) {
            stats.getNextBucket(bucket)
            val t = totals.getOrPut(bucket.uid) { LongArray(4) }
            t[idx] += bucket.rxBytes
            t[idx + 1] += bucket.txBytes
          }
          stats.close()
        }

        val arr = Arguments.createArray()
        totals.filter { it.value.sum() > 0 }.forEach { (uid, t) ->
          arr.pushMap(Arguments.createMap().apply {
            putInt("uid", uid)
            putString("app", appName(uid))
            putDouble("wifi_rx_bytes", t[0].toDouble())
            putDouble("wifi_tx_bytes", t[1].toDouble())
            putDouble("mobile_rx_bytes", t[2].toDouble())
            putDouble("mobile_tx_bytes", t[3].toDouble())
          })
        }
        promise.resolve(arr)
      } catch (e: SecurityException) {
        promise.reject("PERMISSION_ERROR", "Accès aux statistiques d'utilisation non autorisé")
      } catch (e: Exception) {
        promise.reject("TRAFFIC_ERROR", e)
      }
    }.start()
  }
}