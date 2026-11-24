package com.netdatamobile.metrics

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class LocationModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "LocationTracker"

  private val lm by lazy { reactContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager }
  private var listener: LocationListener? = null
  private var lastGpsTime = 0L

  private fun toMap(loc: Location): WritableMap = Arguments.createMap().apply {
    putDouble("latitude", loc.latitude)
    putDouble("longitude", loc.longitude)
    if (loc.hasAltitude()) putDouble("altitude", loc.altitude) else putNull("altitude")
    if (loc.hasSpeed()) putDouble("speed", loc.speed.toDouble()) else putNull("speed")       // m/s
    if (loc.hasBearing()) putDouble("bearing", loc.bearing.toDouble()) else putNull("bearing") // degrés
    if (loc.hasAccuracy()) putDouble("accuracy", loc.accuracy.toDouble()) else putNull("accuracy") // m
    putDouble("timestamp", loc.time.toDouble())
    putString("provider", loc.provider ?: "inconnu")
  }

  private fun stopInternal() {
    listener?.let { lm.removeUpdates(it) }
    listener = null
    lastGpsTime = 0L
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun start(intervalMs: Int, promise: Promise) {
    try {
      stopInternal()

      val l = object : LocationListener {
        override fun onLocationChanged(location: Location) {
          if (location.provider == LocationManager.GPS_PROVIDER) {
            lastGpsTime = location.time
          } else if (lastGpsTime > 0 && location.time - lastGpsTime < intervalMs * 2L) {
            return // position réseau ignorée tant que le GPS répond
          }
          reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("onLocation", toMap(location))
        }

        // Méthodes obligatoires sur Android 10 (API 29)
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
      }

      val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        .filter { lm.isProviderEnabled(it) }
      if (providers.isEmpty()) {
        promise.reject("LOCATION_DISABLED", "La localisation est désactivée sur le téléphone")
        return
      }

      providers.forEach {
        lm.requestLocationUpdates(it, intervalMs.toLong(), 0f, l, Looper.getMainLooper())
      }
      listener = l

      // Envoie tout de suite la dernière position connue
      providers.mapNotNull { lm.getLastKnownLocation(it) }
        .maxByOrNull { it.time }
        ?.let { l.onLocationChanged(it) }

      promise.resolve(null)
    } catch (e: SecurityException) {
      promise.reject("PERMISSION_ERROR", "Permission de localisation manquante")
    } catch (e: Exception) {
      promise.reject("LOCATION_ERROR", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    stopInternal()
    promise.resolve(null)
  }

  override fun invalidate() {
    stopInternal()
    super.invalidate()
  }
}