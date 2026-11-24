import { NativeModules, EmitterSubscription } from 'react-native';
import SystemMetrics, { ThermalZone } from '../native/SystemMetrics';
import NetworkMetrics, { WifiInfo, MobileInfo } from '../native/NetworkMetrics';
import LocationTracker, { LocationPoint, onLocation } from '../native/LocationTracker';
import { insert, saveDeviceInfo } from '../database/db';
import { autoSync, SYNC_INTERVAL_MS } from './sync';
import FlowMonitor from '../native/FlowMonitor';
import SignalingMonitor from '../native/SignalingMonitor';

export const COLLECT_INTERVAL_MS = 10000;
const GPS_INTERVAL_MS = 5000;
const APP_TRAFFIC_INTERVAL_MS = 15 * 60 * 1000;

export interface GpsPoint extends LocationPoint {
  networkType: string;
  cellId: number | null;
  pci: number | null;
  band: string;
}

let timer: ReturnType<typeof setInterval> | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let previous: { rx: number; tx: number; time: number } | null = null;

const getCpuTemp = (zones: ThermalZone[]) => {
  const cpuZones = zones.filter(z => z.type.toLowerCase().includes('cpu'));
  return cpuZones.length > 0 ? Math.max(...cpuZones.map(z => z.temp)) : null;
};

/* ---------- GPS ---------- */

let gpsSub: EmitterSubscription | null = null;
let gpsStarted = false;
const pointListeners = new Set<(point: GpsPoint) => void>();

// Permet à l'écran Carte de recevoir les nouveaux points
export const onGpsPoint = (callback: (point: GpsPoint) => void) => {
  pointListeners.add(callback);
  return () => {
    pointListeners.delete(callback);
  };
};

const startGps = async () => {
  if (gpsStarted) return;
  gpsStarted = true;

  if (!gpsSub) {
    gpsSub = onLocation(async loc => {
      let mobile: MobileInfo | null = null;
      try {
        mobile = await NetworkMetrics.getMobileInfo();
      } catch {
        // infos cellule indisponibles : le point est quand même enregistré
      }
      const point: GpsPoint = {
        ...loc,
        networkType: mobile?.networkType ?? 'N/A',
        cellId: mobile?.cellId ?? null,
        pci: mobile?.pci ?? null,
        band: mobile?.band ?? 'N/A',
      };
      try {
        await insert('gps_metrics', point);
      } catch (e) {
        console.warn('Enregistrement GPS :', e);
      }
      pointListeners.forEach(cb => cb(point));
    });
  }

  try {
    await LocationTracker.start(GPS_INTERVAL_MS);
  } catch {
    gpsStarted = false; // permission refusée ou localisation coupée : nouvel essai au prochain cycle
  }
};

/* ---------- Signalisation cellulaire (API Android, sans root) ---------- */

let signalingStarted = false;

const startSignaling = async () => {
  if (signalingStarted) return;
  signalingStarted = true;
  try {
    await SignalingMonitor.start();
  } catch {
    signalingStarted = false; // permission manquante : nouvel essai au prochain cycle
  }
};

const collectSignaling = async () => {
  try {
    const events = await SignalingMonitor.getEvents();
    for (const event of events) {
      await insert('rrc_messages', event, 'android_event');
    }
  } catch (e) {
    console.warn('Signalisation :', e);
  }

  // Mesures radio périodiques (équivalent Measurement Report)
  try {
    const snapshot = await SignalingMonitor.getRadioSnapshot();
    await insert('rrc_messages', { event: 'measurement_report', ...snapshot }, 'measurement');
  } catch (e) {
    console.warn('Mesures radio :', e);
  }
};

/* ---------- Flux réseau (VPN DNS + volumes par application) ---------- */

let lastAppTraffic = 0;

const collectFlows = async () => {
  try {
    const events = await FlowMonitor.getDnsEvents();
    for (const event of events) {
      await insert('flow_metrics', event, 'dns');
    }
  } catch (e) {
    console.warn('Flux DNS :', e);
  }

  const now = Date.now();
  if (now - lastAppTraffic < APP_TRAFFIC_INTERVAL_MS) return;
  try {
    if (await FlowMonitor.hasUsageAccess()) {
      const start = lastAppTraffic || now - APP_TRAFFIC_INTERVAL_MS;
      const apps = await FlowMonitor.getAppTraffic(start, now);
      for (const app of apps) {
        await insert('flow_metrics', { ...app, window_start: start, window_end: now }, 'app_traffic');
      }
      lastAppTraffic = now;
    }
  } catch (e) {
    console.warn('Volumes par application :', e);
  }
};

/* ---------- Collecte ---------- */

// Une collecte complète : métriques système + réseau, enregistrées en base locale
export const collectOnce = async () => {
  startGps();
  startSignaling();

  try {
    const [m, s, b, c, t] = await Promise.all([
      SystemMetrics.getMemoryInfo(),
      SystemMetrics.getStorageInfo(),
      SystemMetrics.getBatteryInfo(),
      SystemMetrics.getCpuInfo(),
      SystemMetrics.getThermalInfo(),
    ]);
    await insert('system_metrics', {
      cpu_usage: c.usagePercent,
      cpu_load_average: c.loadAverage,
      cpu_per_core: c.perCore.map(core => core.load),
      ram_total: m.total,
      ram_used: m.used,
      ram_usage: m.usagePercent,
      storage_total: s.total,
      storage_used: s.used,
      storage_usage: s.usagePercent,
      battery_level: b.level,
      battery_charging: b.isCharging,
      battery_health: b.health,
      battery_temperature: b.temperature,
      battery_voltage: b.voltage,
      battery_current: b.currentNow,
      cpu_temperature: getCpuTemp(t),
      system_temperature: t.find(z => z.type === 'xo-therm-usr')?.temp ?? null,
    });
  } catch (e) {
    console.warn('Collecte système :', e);
  }

  try {
    const conn = await NetworkMetrics.getConnectionInfo();
    const now = Date.now();
    let rxRate: number | null = null;
    let txRate: number | null = null;
    if (previous) {
      const dt = (now - previous.time) / 1000;
      rxRate = (conn.rxBytes - previous.rx) / dt;
      txRate = (conn.txBytes - previous.tx) / dt;
    }
    previous = { rx: conn.rxBytes, tx: conn.txBytes, time: now };

    let wifi: WifiInfo | null = null;
    let mobile: MobileInfo | null = null;
    try {
      wifi = await NetworkMetrics.getWifiInfo();
    } catch {
      // Wi-Fi indisponible
    }
    try {
      mobile = await NetworkMetrics.getMobileInfo();
    } catch {
      // permission téléphone manquante
    }

    await insert(
      'network_metrics',
      {
        transport: conn.transport,
        ip_address: conn.ipAddress,
        rx_bytes_per_second: rxRate,
        tx_bytes_per_second: txRate,
        downstream_kbps: conn.downstreamKbps,
        upstream_kbps: conn.upstreamKbps,
        wifi,
        mobile,
      },
      'passive',
    );
  } catch (e) {
    console.warn('Collecte réseau :', e);
  }

  await collectFlows();
  await collectSignaling();
};

export const startCollector = () => {
  if (timer) return;
  collectOnce();
  timer = setInterval(collectOnce, COLLECT_INTERVAL_MS);
  syncTimer = setInterval(autoSync, SYNC_INTERVAL_MS);
};

export const stopCollector = () => {
  if (timer) clearInterval(timer);
  timer = null;
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
  previous = null;
  gpsSub?.remove();
  gpsSub = null;
  gpsStarted = false;
  LocationTracker.stop();
  signalingStarted = false;
  SignalingMonitor.stop();
};

/* ---------- Arrière-plan (service Android) ---------- */

let finishBackgroundTask: (() => void) | null = null;

// Tâche Headless JS lancée par CollectorService : elle reste active tant que le service tourne
export const backgroundTask = async () => {
  try {
    await saveDeviceInfo();
  } catch (e) {
    console.warn('Base locale :', e);
  }
  startCollector();
  await new Promise<void>(resolve => {
    finishBackgroundTask = resolve;
  });
};

export const startBackground = (): Promise<void> => NativeModules.CollectorService.start();

export const stopBackground = async () => {
  finishBackgroundTask?.();
  finishBackgroundTask = null;
  await NativeModules.CollectorService.stop();
};

export const isBackgroundRunning = (): Promise<boolean> => NativeModules.CollectorService.isRunning();