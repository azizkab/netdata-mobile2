package com.netdatamobile.metrics

import android.annotation.SuppressLint
import android.os.Build
import android.telephony.AccessNetworkConstants
import android.telephony.CellIdentityLte
import android.telephony.CellIdentityNr
import android.telephony.CellInfo
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.CellInfoWcdma
import android.telephony.CellSignalStrengthNr
import android.telephony.NetworkRegistrationInfo
import android.telephony.PhoneStateListener
import android.telephony.ServiceState
import android.telephony.TelephonyDisplayInfo
import android.telephony.TelephonyManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * Signalisation cellulaire visible sans root (informations transmises par le modem à Android).
 *
 * Événements :
 *  - cell_change       : changement de cellule servante (handover si données actives, sinon resélection)
 *  - technology_change : changement de technologie (5G SA / 5G NSA / 4G+ / 4G / 3G / 2G)
 *  - service_state     : en service / hors service / urgences uniquement
 *  - registration      : état d'enregistrement PS (équivalent NAS : enregistré, recherche, refusé...)
 *  - nr_state          : état de la 5G NSA (équivalent RRC Reconfiguration : ajout / retrait de la porteuse NR)
 *
 * Instantané radio (équivalent Measurement Report + SIB) : cellule(s) servante(s), cellules voisines,
 * enregistrement réseau, avec RSRP / RSRQ / SINR / CQI / timing advance, PLMN, TAC, EARFCN, bande...
 */
@Suppress("DEPRECATION")
class SignalingMonitorModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "SignalingMonitor"

  private val tm by lazy { reactContext.getSystemService(TelephonyManager::class.java) }
  private val events = ConcurrentLinkedQueue<Map<String, Any?>>()
  private var listener: PhoneStateListener? = null
  private var lastCell: Map<String, Any?>? = null
  private var lastTech: String? = null
  private var lastService: String? = null
  private var lastRegistration: String? = null
  private var lastNrState: String? = null

  private fun push(event: String, extra: Map<String, Any?>) {
    events.add(mapOf("timestamp" to System.currentTimeMillis().toDouble(), "event" to event) + extra)
    while (events.size > 2000) events.poll()
  }

  private fun v(value: Int): Int? = if (value == CellInfo.UNAVAILABLE) null else value

  private fun techName(type: Int): String = when (type) {
    TelephonyManager.NETWORK_TYPE_GPRS, TelephonyManager.NETWORK_TYPE_EDGE, TelephonyManager.NETWORK_TYPE_CDMA,
    TelephonyManager.NETWORK_TYPE_1xRTT, TelephonyManager.NETWORK_TYPE_IDEN, TelephonyManager.NETWORK_TYPE_GSM -> "2G"
    TelephonyManager.NETWORK_TYPE_UMTS, TelephonyManager.NETWORK_TYPE_EVDO_0, TelephonyManager.NETWORK_TYPE_EVDO_A,
    TelephonyManager.NETWORK_TYPE_HSDPA, TelephonyManager.NETWORK_TYPE_HSUPA, TelephonyManager.NETWORK_TYPE_HSPA,
    TelephonyManager.NETWORK_TYPE_EVDO_B, TelephonyManager.NETWORK_TYPE_EHRPD, TelephonyManager.NETWORK_TYPE_HSPAP,
    TelephonyManager.NETWORK_TYPE_TD_SCDMA -> "3G"
    TelephonyManager.NETWORK_TYPE_LTE -> "4G"
    TelephonyManager.NETWORK_TYPE_NR -> "5G SA"
    else -> "Inconnu"
  }

  private fun techRank(tech: String?) = when (tech) {
    "5G SA" -> 5; "5G NSA" -> 4; "4G+", "4G" -> 3; "3G" -> 2; "2G" -> 1
    else -> 0
  }

  /* ---------- Description complète d'une cellule (identité + mesures) ---------- */

  private fun bandsOf(id: Any): List<Int> = when {
    Build.VERSION.SDK_INT < Build.VERSION_CODES.R -> emptyList()
    id is CellIdentityLte -> id.bands.toList()
    id is CellIdentityNr -> id.bands.toList()
    else -> emptyList()
  }

  private fun cellDetails(cell: CellInfo): Map<String, Any?>? = when (cell) {
    is CellInfoLte -> {
      val id = cell.cellIdentity
      val s = cell.cellSignalStrength
      mapOf(
        "tech" to "LTE", "registered" to cell.isRegistered,
        "cell_id" to v(id.ci), "pci" to v(id.pci), "tac" to v(id.tac), "arfcn" to v(id.earfcn),
        "mcc" to id.mccString, "mnc" to id.mncString, "bandwidth_khz" to v(id.bandwidth), "bands" to bandsOf(id),
        "rsrp" to v(s.rsrp), "rsrq" to v(s.rsrq), "sinr" to v(s.rssnr), "cqi" to v(s.cqi),
        "timing_advance" to v(s.timingAdvance), "dbm" to v(s.dbm),
      )
    }
    is CellInfoNr -> {
      val id = cell.cellIdentity as CellIdentityNr
      val s = cell.cellSignalStrength as CellSignalStrengthNr
      mapOf(
        "tech" to "NR", "registered" to cell.isRegistered,
        "cell_id" to (if (id.nci == CellInfo.UNAVAILABLE_LONG) null else id.nci.toDouble()),
        "pci" to v(id.pci), "tac" to v(id.tac), "arfcn" to v(id.nrarfcn),
        "mcc" to id.mccString, "mnc" to id.mncString, "bands" to bandsOf(id),
        "rsrp" to v(s.ssRsrp), "rsrq" to v(s.ssRsrq), "sinr" to v(s.ssSinr), "dbm" to v(s.dbm),
      )
    }
    is CellInfoWcdma -> {
      val id = cell.cellIdentity
      mapOf(
        "tech" to "WCDMA", "registered" to cell.isRegistered,
        "cell_id" to v(id.cid), "pci" to v(id.psc), "tac" to v(id.lac), "arfcn" to v(id.uarfcn),
        "mcc" to id.mccString, "mnc" to id.mncString, "dbm" to v(cell.cellSignalStrength.dbm),
      )
    }
    is CellInfoGsm -> {
      val id = cell.cellIdentity
      mapOf(
        "tech" to "GSM", "registered" to cell.isRegistered,
        "cell_id" to v(id.cid), "pci" to v(id.bsic), "tac" to v(id.lac), "arfcn" to v(id.arfcn),
        "mcc" to id.mccString, "mnc" to id.mncString, "dbm" to v(cell.cellSignalStrength.dbm),
        "timing_advance" to v(cell.cellSignalStrength.timingAdvance),
      )
    }
    else -> null
  }

  /* ---------- Enregistrement réseau (équivalent NAS) et état 5G NSA ---------- */

  @SuppressLint("MissingPermission")
  private fun registrationInfo(): Map<String, Any?>? {
    val ss = tm.serviceState ?: return null
    val text = ss.toString()
    val ps = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      ss.networkRegistrationInfoList.firstOrNull {
        it.domain and NetworkRegistrationInfo.DOMAIN_PS != 0 &&
          it.transportType == AccessNetworkConstants.TRANSPORT_TYPE_WWAN
      }
    } else null

    val registration = when {
      ps == null -> null
      ps.isRegistered && ps.isRoaming -> "registered_roaming"
      ps.isRegistered -> "registered"
      ps.isSearching -> "searching"
      text.contains("registrationState=DENIED") -> "denied"
      else -> "not_registered"
    }

    return mapOf(
      "operator" to ss.operatorAlphaLong,
      "roaming" to ss.roaming,
      "registration" to registration,
      "access_tech" to ps?.let { techName(it.accessNetworkTechnology) },
      // Champs non exposés par l'API publique : lus dans la description du ServiceState quand ils y figurent
      "nr_state" to Regex("nrState\\s*=\\s*([A-Z_]+)").find(text)?.groupValues?.get(1),
      "reject_cause" to Regex("rejectCause\\s*=\\s*(\\d+)").find(text)?.groupValues?.get(1)?.toIntOrNull()?.takeIf { it != 0 },
      "duplex" to when (ss.duplexMode) {
        ServiceState.DUPLEX_MODE_FDD -> "FDD"
        ServiceState.DUPLEX_MODE_TDD -> "TDD"
        else -> null
      },
      "channel" to v(ss.channelNumber),
      "cell_bandwidths_khz" to ss.cellBandwidths.toList(),
    )
  }

  @Synchronized
  private fun checkRegistration() {
    val info = try { registrationInfo() } catch (e: SecurityException) { null } ?: return

    val registration = info["registration"] as String?
    if (registration != null) {
      val previous = lastRegistration
      if (previous != null && previous != registration) {
        push("registration", mapOf(
          "from_registration" to previous,
          "to_registration" to registration,
          "reject_cause" to info["reject_cause"],
        ))
      }
      lastRegistration = registration
    }

    val nrState = info["nr_state"] as String?
    if (nrState != null) {
      val previous = lastNrState
      if (previous != null && previous != nrState) {
        push("nr_state", mapOf("from_nr_state" to previous, "to_nr_state" to nrState))
      }
      lastNrState = nrState
    }
  }

  /* ---------- Changements de cellule et de technologie ---------- */

  private fun cellKey(cell: Map<String, Any?>) = mapOf(
    "tech" to cell["tech"], "cell_id" to cell["cell_id"], "pci" to cell["pci"], "tac" to cell["tac"], "arfcn" to cell["arfcn"],
  )

  @SuppressLint("MissingPermission")
  @Synchronized
  private fun checkCell() {
    val registered = try { tm.allCellInfo?.firstOrNull { it.isRegistered } } catch (e: SecurityException) { null } ?: return
    val cell = cellDetails(registered)?.let { cellKey(it) } ?: return
    val previous = lastCell
    if (previous != null && (previous["cell_id"] != cell["cell_id"] || previous["pci"] != cell["pci"] || previous["tech"] != cell["tech"])) {
      // Approximation : données mobiles actives = connexion RRC établie -> handover, sinon resélection
      val connected = tm.dataState == TelephonyManager.DATA_CONNECTED
      push("cell_change", mapOf(
        "change_type" to if (connected) "handover" else "reselection",
        "from_cell" to previous,
        "to_cell" to cell,
      ))
    }
    lastCell = cell
  }

  @Synchronized
  private fun onTech(tech: String) {
    if (tech == "Inconnu") return
    val previous = lastTech
    if (previous != null && previous != tech) {
      push("technology_change", mapOf(
        "from_tech" to previous,
        "to_tech" to tech,
        "downgrade" to (techRank(tech) < techRank(previous)),
      ))
    }
    lastTech = tech
  }

  private fun techFromDisplay(info: TelephonyDisplayInfo): String = when (info.overrideNetworkType) {
    TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_NR_NSA,
    TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_NR_NSA_MMWAVE,
    TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_NR_ADVANCED -> "5G NSA"
    TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_LTE_CA,
    TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_LTE_ADVANCED_PRO -> "4G+"
    else -> techName(info.networkType)
  }

  /* ---------- Méthodes appelées depuis JS ---------- */

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun start(promise: Promise) {
    if (listener != null) {
      promise.resolve(true)
      return
    }
    try {
      val l = object : PhoneStateListener(reactContext.mainExecutor) {
        override fun onCellInfoChanged(cellInfo: MutableList<CellInfo>?) {
          checkCell()
        }

        override fun onServiceStateChanged(serviceState: ServiceState?) {
          val state = when (serviceState?.state) {
            ServiceState.STATE_IN_SERVICE -> "in_service"
            ServiceState.STATE_OUT_OF_SERVICE -> "out_of_service"
            ServiceState.STATE_EMERGENCY_ONLY -> "emergency_only"
            ServiceState.STATE_POWER_OFF -> "power_off"
            else -> "unknown"
          }
          val previous = lastService
          if (previous != null && previous != state) {
            push("service_state", mapOf("from_state" to previous, "to_state" to state))
          }
          lastService = state
          checkRegistration()
        }

        override fun onDisplayInfoChanged(telephonyDisplayInfo: TelephonyDisplayInfo) {
          onTech(techFromDisplay(telephonyDisplayInfo))
          checkRegistration()
        }
      }

      var flags = PhoneStateListener.LISTEN_CELL_INFO or PhoneStateListener.LISTEN_SERVICE_STATE
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        flags = flags or PhoneStateListener.LISTEN_DISPLAY_INFO_CHANGED
      }
      tm.listen(l, flags)
      listener = l
      checkCell()
      checkRegistration()
      promise.resolve(true)
    } catch (e: SecurityException) {
      promise.reject("PERMISSION_ERROR", "Permissions téléphone / localisation manquantes")
    } catch (e: Exception) {
      promise.reject("SIGNALING_ERROR", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    listener?.let { tm.listen(it, PhoneStateListener.LISTEN_NONE) }
    listener = null
    promise.resolve(null)
  }

  // Retourne et vide les événements en attente (vérifie aussi cellule et enregistrement)
  @SuppressLint("MissingPermission")
  @ReactMethod
  fun getEvents(promise: Promise) {
    checkCell()
    checkRegistration()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      try { onTech(techName(tm.dataNetworkType)) } catch (e: SecurityException) {}
    }
    val arr = Arguments.createArray()
    while (true) {
      val event = events.poll() ?: break
      arr.pushMap(Arguments.makeNativeMap(event))
    }
    promise.resolve(arr)
  }

  // Instantané radio complet (équivalent Measurement Report + informations système de la cellule)
  @SuppressLint("MissingPermission")
  @ReactMethod
  fun getRadioSnapshot(promise: Promise) {
    val build = { cells: List<CellInfo>? ->
      try {
        val all = cells.orEmpty().mapNotNull { cellDetails(it) }
        val serving = all.filter { it["registered"] == true }
        val neighbors = all.filter { it["registered"] != true }
          .sortedByDescending { (it["dbm"] as Int?) ?: Int.MIN_VALUE }
          .take(8)
        promise.resolve(Arguments.makeNativeMap(mapOf(
          "timestamp" to System.currentTimeMillis().toDouble(),
          "technology" to lastTech,
          "serving" to serving,
          "neighbors" to neighbors,
          "registration" to registrationInfo(),
        )))
      } catch (e: SecurityException) {
        promise.reject("PERMISSION_ERROR", "Permissions téléphone / localisation manquantes")
      } catch (e: Exception) {
        promise.reject("SNAPSHOT_ERROR", e)
      }
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        tm.requestCellInfoUpdate(reactContext.mainExecutor, object : TelephonyManager.CellInfoCallback() {
          override fun onCellInfo(cellInfo: MutableList<CellInfo>) {
            build(if (cellInfo.isNotEmpty()) cellInfo else tm.allCellInfo)
          }

          override fun onError(errorCode: Int, detail: Throwable?) {
            build(tm.allCellInfo)
          }
        })
      } else {
        build(tm.allCellInfo)
      }
    } catch (e: SecurityException) {
      promise.reject("PERMISSION_ERROR", "Permissions téléphone / localisation manquantes")
    }
  }

  override fun invalidate() {
    listener?.let { tm.listen(it, PhoneStateListener.LISTEN_NONE) }
    listener = null
    super.invalidate()
  }
}