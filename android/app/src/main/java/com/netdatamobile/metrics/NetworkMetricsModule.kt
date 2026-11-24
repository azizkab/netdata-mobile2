package com.netdatamobile.metrics

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.TrafficStats
import android.net.wifi.WifiManager
import android.os.Build
import android.telephony.CellIdentityNr
import android.telephony.CellInfo
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.CellSignalStrengthNr
import android.telephony.TelephonyManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.net.Inet4Address

class NetworkMetricsModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "NetworkMetrics"

  private fun putIntOrNull(map: WritableMap, key: String, value: Int) {
    if (value == CellInfo.UNAVAILABLE) map.putNull(key) else map.putInt(key, value)
  }

  private fun networkTypeName(type: Int): String = when (type) {
    TelephonyManager.NETWORK_TYPE_GPRS,
    TelephonyManager.NETWORK_TYPE_EDGE,
    TelephonyManager.NETWORK_TYPE_CDMA,
    TelephonyManager.NETWORK_TYPE_1xRTT,
    TelephonyManager.NETWORK_TYPE_IDEN,
    TelephonyManager.NETWORK_TYPE_GSM -> "2G"
    TelephonyManager.NETWORK_TYPE_UMTS,
    TelephonyManager.NETWORK_TYPE_EVDO_0,
    TelephonyManager.NETWORK_TYPE_EVDO_A,
    TelephonyManager.NETWORK_TYPE_HSDPA,
    TelephonyManager.NETWORK_TYPE_HSUPA,
    TelephonyManager.NETWORK_TYPE_HSPA,
    TelephonyManager.NETWORK_TYPE_EVDO_B,
    TelephonyManager.NETWORK_TYPE_EHRPD,
    TelephonyManager.NETWORK_TYPE_HSPAP,
    TelephonyManager.NETWORK_TYPE_TD_SCDMA -> "3G"
    TelephonyManager.NETWORK_TYPE_LTE -> "4G"
    TelephonyManager.NETWORK_TYPE_NR -> "5G SA"
    TelephonyManager.NETWORK_TYPE_IWLAN -> "IWLAN"
    else -> "Inconnu"
  }

  @ReactMethod
  fun getConnectionInfo(promise: Promise) {
    try {
      val cm = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val net = cm.activeNetwork
      val caps = net?.let { cm.getNetworkCapabilities(it) }
      val link = net?.let { cm.getLinkProperties(it) }

      val transport = when {
        caps == null -> "Aucune"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "Mobile"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "VPN"
        else -> "Autre"
      }
      val ip = link?.linkAddresses?.firstOrNull { it.address is Inet4Address }?.address?.hostAddress

      val map = Arguments.createMap()
      map.putString("transport", transport)
      map.putString("ipAddress", ip ?: "N/A")
      map.putDouble("downstreamKbps", caps?.linkDownstreamBandwidthKbps?.toDouble() ?: -1.0)
      map.putDouble("upstreamKbps", caps?.linkUpstreamBandwidthKbps?.toDouble() ?: -1.0)
      map.putDouble("rxBytes", TrafficStats.getTotalRxBytes().toDouble())
      map.putDouble("txBytes", TrafficStats.getTotalTxBytes().toDouble())
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("CONNECTION_ERROR", e)
    }
  }

  @ReactMethod
  fun getWifiInfo(promise: Promise) {
    try {
      val cm = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
      if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
        promise.resolve(null)
        return
      }

      val wm = reactContext.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      @Suppress("DEPRECATION")
      val info = wm.connectionInfo
      val freq = info.frequency
      val band = when (freq) {
        in 2400..2500 -> "2,4 GHz"
        in 4900..5900 -> "5 GHz"
        in 5925..7125 -> "6 GHz"
        else -> "Inconnue"
      }

      val map = Arguments.createMap()
      map.putString("ssid", info.ssid.removeSurrounding("\""))
      map.putString("bssid", info.bssid ?: "N/A")
      map.putInt("rssi", info.rssi)
      @Suppress("DEPRECATION")
      map.putInt("signalLevel", WifiManager.calculateSignalLevel(info.rssi, 5))
      map.putInt("frequency", freq)
      map.putString("band", band)
      map.putInt("linkSpeedMbps", info.linkSpeed)
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("WIFI_ERROR", e)
    }
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun getMobileInfo(promise: Promise) {
    try {
      val tm = reactContext.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        // Demande une mesure fraîche des cellules (sur certains téléphones, getAllCellInfo reste vide sinon)
        tm.requestCellInfoUpdate(reactContext.mainExecutor, object : TelephonyManager.CellInfoCallback() {
          override fun onCellInfo(cellInfo: MutableList<CellInfo>) {
            resolveMobile(tm, if (cellInfo.isNotEmpty()) cellInfo else tm.allCellInfo, promise)
          }

          override fun onError(errorCode: Int, detail: Throwable?) {
            resolveMobile(tm, tm.allCellInfo, promise)
          }
        })
      } else {
        resolveMobile(tm, tm.allCellInfo, promise)
      }
    } catch (e: SecurityException) {
      promise.reject("PERMISSION_ERROR", "Permission manquante : ${e.message}")
    } catch (e: Exception) {
      promise.reject("MOBILE_ERROR", e)
    }
  }

  @SuppressLint("MissingPermission")
  private fun resolveMobile(tm: TelephonyManager, cells: List<CellInfo>?, promise: Promise) {
    try {
      val dataType = tm.dataNetworkType
      val ss = tm.signalStrength
      val strengths = ss?.cellSignalStrengths ?: emptyList()

      var type = networkTypeName(dataType)
      if (dataType == TelephonyManager.NETWORK_TYPE_LTE && strengths.any { it is CellSignalStrengthNr }) {
        type = "5G NSA"
      }

      val map = Arguments.createMap()
      map.putString("networkType", type)
      map.putString("operator", tm.networkOperatorName)
      map.putInt("signalLevel", ss?.level ?: 0)
      val main = strengths.firstOrNull()
      if (main != null) putIntOrNull(map, "signalDbm", main.dbm) else map.putNull("signalDbm")

      map.putNull("cellId")
      map.putNull("pci")
      map.putNull("tac")
      map.putString("band", "N/A")

      when (val cell = cells?.firstOrNull { it.isRegistered }) {
        is CellInfoLte -> {
          val id = cell.cellIdentity
          putIntOrNull(map, "cellId", id.ci)
          putIntOrNull(map, "pci", id.pci)
          putIntOrNull(map, "tac", id.tac)
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && id.bands.isNotEmpty()) {
            map.putString("band", id.bands.joinToString(",") { "B$it" })
          }
        }
        is CellInfoNr -> {
          val id = cell.cellIdentity as CellIdentityNr
          if (id.nci != CellInfo.UNAVAILABLE_LONG) map.putDouble("cellId", id.nci.toDouble())
          putIntOrNull(map, "pci", id.pci)
          putIntOrNull(map, "tac", id.tac)
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && id.bands.isNotEmpty()) {
            map.putString("band", id.bands.joinToString(",") { "n$it" })
          }
        }
      }
      promise.resolve(map)
    } catch (e: SecurityException) {
      promise.reject("PERMISSION_ERROR", "Permission manquante : ${e.message}")
    } catch (e: Exception) {
      promise.reject("MOBILE_ERROR", e)
    }
  }
}