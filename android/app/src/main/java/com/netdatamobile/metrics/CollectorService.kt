package com.netdatamobile.metrics

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Service de premier plan (notification permanente) qui exécute la tâche JS
 * "NetdataCollector" : la collecte continue même quand l'app est en arrière-plan.
 */
class CollectorService : HeadlessJsTaskService() {

  companion object {
    const val CHANNEL_ID = "netdata_collector"
    const val NOTIFICATION_ID = 1001
    @Volatile var running = false
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Collecte NetData", NotificationManager.IMPORTANCE_LOW)
      )
    }

    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val pendingIntent = PendingIntent.getActivity(this, 0, launchIntent, PendingIntent.FLAG_IMMUTABLE)

    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("NetData Mobile")
      .setContentText("Collecte des métriques en cours")
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setContentIntent(pendingIntent)
      .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val locationGranted = ContextCompat.checkSelfPermission(
        this, Manifest.permission.ACCESS_FINE_LOCATION
      ) == PackageManager.PERMISSION_GRANTED
      val type = if (locationGranted) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                 else ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      startForeground(NOTIFICATION_ID, notification, type)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    running = true
    super.onStartCommand(intent, flags, startId)
    return START_STICKY
  }

  // Tâche JS sans limite de durée (timeout 0), autorisée aussi quand l'app est au premier plan
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig("NetdataCollector", Arguments.createMap(), 0, true)

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }
}

class CollectorServiceModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val ALERT_CHANNEL_ID = "netdata_alerts"
    const val ALERT_NOTIFICATION_ID = 2001
  }

  override fun getName() = "CollectorService"

  @ReactMethod
  fun start(promise: Promise) {
    try {
      ContextCompat.startForegroundService(reactContext, Intent(reactContext, CollectorService::class.java))
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("SERVICE_ERROR", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    reactContext.stopService(Intent(reactContext, CollectorService::class.java))
    promise.resolve(null)
  }

  @ReactMethod
  fun isRunning(promise: Promise) {
    promise.resolve(CollectorService.running)
  }

  // Notification d'alerte de sécurité (prioritaire, s'affiche même app fermée)
  @ReactMethod
  fun showAlert(title: String, message: String, promise: Promise) {
    val nm = reactContext.getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      nm.createNotificationChannel(
        NotificationChannel(ALERT_CHANNEL_ID, "Alertes de sécurité", NotificationManager.IMPORTANCE_HIGH)
      )
    }

    val launchIntent = reactContext.packageManager.getLaunchIntentForPackage(reactContext.packageName)
    val pendingIntent = PendingIntent.getActivity(reactContext, 1, launchIntent, PendingIntent.FLAG_IMMUTABLE)

    val notification = NotificationCompat.Builder(reactContext, ALERT_CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(message)
      .setStyle(NotificationCompat.BigTextStyle().bigText(message))
      .setSmallIcon(reactContext.applicationInfo.icon)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setContentIntent(pendingIntent)
      .build()

    try {
      nm.notify(ALERT_NOTIFICATION_ID, notification)
    } catch (e: SecurityException) {
      // permission de notification refusée
    }
    promise.resolve(null)
  }
}