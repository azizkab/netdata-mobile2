package com.netdatamobile.metrics

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Environment
import android.os.StatFs
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import java.io.File

class SystemMetricsModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "SystemMetrics"

  @ReactMethod
  fun getMemoryInfo(promise: Promise) {
    try {
      val am = reactContext.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val mi = ActivityManager.MemoryInfo()
      am.getMemoryInfo(mi)
      val used = mi.totalMem - mi.availMem
      val map = Arguments.createMap()
      map.putDouble("total", mi.totalMem.toDouble())
      map.putDouble("available", mi.availMem.toDouble())
      map.putDouble("used", used.toDouble())
      map.putDouble("usagePercent", used * 100.0 / mi.totalMem)
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("MEMORY_ERROR", e)
    }
  }

  @ReactMethod
  fun getStorageInfo(promise: Promise) {
    try {
      val stat = StatFs(Environment.getDataDirectory().path)
      val total = stat.totalBytes
      val free = stat.availableBytes
      val used = total - free
      val map = Arguments.createMap()
      map.putDouble("total", total.toDouble())
      map.putDouble("free", free.toDouble())
      map.putDouble("used", used.toDouble())
      map.putDouble("usagePercent", used * 100.0 / total)
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("STORAGE_ERROR", e)
    }
  }

  @ReactMethod
  fun getBatteryInfo(promise: Promise) {
    try {
      val intent = reactContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      if (intent == null) {
        promise.reject("BATTERY_ERROR", "Batterie indisponible")
        return
      }
      val bm = reactContext.getSystemService(Context.BATTERY_SERVICE) as BatteryManager

      val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
      val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
      val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)

      val health = when (intent.getIntExtra(BatteryManager.EXTRA_HEALTH, -1)) {
        BatteryManager.BATTERY_HEALTH_GOOD -> "Bonne"
        BatteryManager.BATTERY_HEALTH_OVERHEAT -> "Surchauffe"
        BatteryManager.BATTERY_HEALTH_DEAD -> "Morte"
        BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "Surtension"
        BatteryManager.BATTERY_HEALTH_COLD -> "Froide"
        else -> "Inconnue"
      }

      val map = Arguments.createMap()
      map.putDouble("level", level * 100.0 / scale)
      map.putBoolean("isCharging",
        status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
      map.putString("health", health)
      map.putDouble("temperature", intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0) // °C
      map.putDouble("voltage", intent.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0) / 1000.0)     // V
      map.putDouble("currentNow", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW) / 1000.0) // mA
      map.putDouble("chargeTimeRemaining", bm.computeChargeTimeRemaining().toDouble()) // ms, -1 si inconnu
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("BATTERY_ERROR", e)
    }
  }

  private fun readLong(path: String): Long =
    try { File(path).readText().trim().toLong() } catch (e: Exception) { -1L }

  @ReactMethod
  fun getCpuInfo(promise: Promise) {
    try {
      val cores = Runtime.getRuntime().availableProcessors()
      val perCore = Arguments.createArray()
      var totalLoad = 0.0
      var counted = 0

      for (i in 0 until cores) {
        val base = "/sys/devices/system/cpu/cpu$i/cpufreq"
        val cur = readLong("$base/scaling_cur_freq")
        val min = readLong("$base/cpuinfo_min_freq")
        val max = readLong("$base/cpuinfo_max_freq")
        val load = if (cur > 0 && max > min) (cur - min) * 100.0 / (max - min) else -1.0

        val core = Arguments.createMap()
        core.putInt("id", i)
        core.putDouble("curFreqMHz", if (cur > 0) cur / 1000.0 else -1.0)
        core.putDouble("maxFreqMHz", if (max > 0) max / 1000.0 else -1.0)
        core.putDouble("load", load)
        perCore.pushMap(core)

        if (load >= 0) { totalLoad += load; counted++ }
      }

      val loadAvg = try {
        File("/proc/loadavg").readText().trim().split(" ")[0].toDouble()
      } catch (e: Exception) { -1.0 }

      val map = Arguments.createMap()
      map.putInt("cores", cores)
      map.putDouble("usagePercent", if (counted > 0) totalLoad / counted else -1.0)
      map.putDouble("loadAverage", loadAvg)
      map.putArray("perCore", perCore)
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("CPU_ERROR", e)
    }
  }

  @ReactMethod
  fun getThermalInfo(promise: Promise) {
    val zones: WritableArray = Arguments.createArray()
    File("/sys/class/thermal").listFiles()
      ?.filter { it.name.startsWith("thermal_zone") }
      ?.forEach { dir ->
        try {
          val type = File(dir, "type").readText().trim()
          val raw = File(dir, "temp").readText().trim().toDouble()
          val temp = if (raw > 1000) raw / 1000.0 else raw
          if (temp in -40.0..150.0) {
            val z = Arguments.createMap()
            z.putString("type", type)
            z.putDouble("temp", temp)
            zones.pushMap(z)
          }
        } catch (e: Exception) { /* zone non lisible : ignorée */ }
      }
    promise.resolve(zones)
  }
}