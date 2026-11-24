package com.netdatamobile.metrics

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class SystemMetricsPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(
      SystemMetricsModule(reactContext),
      NetworkMetricsModule(reactContext),
      NetworkTestsModule(reactContext),
      LocationModule(reactContext),
      SecureKeyModule(reactContext),
      CollectorServiceModule(reactContext),
      FlowMonitorModule(reactContext),
      SignalingMonitorModule(reactContext),
    )

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}