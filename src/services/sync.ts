import { NativeModules } from 'react-native';
import {
  SYNC_TABLES,
  TableName,
  getUnsynced,
  markSynced,
  getRecent,
  getSetting,
  setSetting,
  deleteSetting,
  getDeviceId,
} from '../database/db';
import { apiPost, isAuthError } from './api';

export const SYNC_INTERVAL_MS = 5000;
const BATCH_SIZE = 200;   // lignes max par table et par requête
const MAX_BATCHES = 10;   // requêtes max par synchronisation

// Résultat de l'analyse serveur (score de risque global, section 9 du CDC)
export interface RiskReport {
  timestamp: number;
  risk_score: number;
  risk_class: string;
  components: { ml: number; behavioral: number; url: number; mobile: number };
  alerts: string[];
  suspicious_domains: { domain: string; class: string; score: number; reasons: string[] }[];
  predictions: {
    battery_drain_per_hour: number | null;
    battery_hours_left: number | null;
    signal_dbm_30min: number | null;
    signal_loss_risk: boolean | null;
  };
  ml: { score?: number; status?: string; training_windows?: number };
  baseline: { score?: number; status?: string };
  domain_model: string;
}

export const RISK_LEVELS: Record<string, number> = {
  'Normal': 0,
  'Anomalie réseau': 1,
  'Menace potentielle': 2,
  'Menace confirmée': 3,
};

let running = false;

export const getLastRisk = async (): Promise<RiskReport | null> => {
  const value = await getSetting('last_risk');
  return value ? (JSON.parse(value) as RiskReport) : null;
};

// Enregistre le dernier score et notifie quand le niveau de risque augmente
const handleRisk = async (risk: RiskReport | null) => {
  if (!risk) return;
  await setSetting('last_risk', JSON.stringify(risk));

  const level = RISK_LEVELS[risk.risk_class] ?? 0;
  const previous = Number((await getSetting('last_risk_level')) ?? 0);
  if (level > previous) {
    NativeModules.CollectorService.showAlert(
      `Alerte NetData : ${risk.risk_class} (${Math.round(risk.risk_score)}/100)`,
      risk.alerts.slice(0, 3).join('\n') || 'Anomalie détectée',
    ).catch(() => {});
  }
  await setSetting('last_risk_level', String(level));
};

// Envoie au serveur les lignes non synchronisées et retourne le nombre envoyé
export const syncOnce = async (): Promise<number> => {
  if (running) return 0;
  running = true;
  let sent = 0;
  let risk: RiskReport | null = null;

  try {
    const deviceId = await getDeviceId();
    const [deviceInfo] = await getRecent<object>('device_info', 1);

    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const records: Record<string, object[]> = {};
      let total = 0;

      for (const table of SYNC_TABLES) {
        const rows = await getUnsynced(table, BATCH_SIZE);
        if (rows.length > 0) {
          records[table] = rows.map(r => ({
            local_id: r.id,
            timestamp: r.timestamp,
            kind: r.kind,
            data: JSON.parse(r.data),
          }));
          total += rows.length;
        }
      }
      if (total === 0) break;

      const res = await apiPost('/api/sync', {
        device_id: deviceId,
        device_info: deviceInfo ?? {},
        records,
      });

      for (const [table, ids] of Object.entries(res.accepted ?? {})) {
        await markSynced(table as TableName, ids as number[]);
      }
      if (res.risk) risk = res.risk;
      sent += total;
    }

    await setSetting('last_sync', String(Date.now()));
    await deleteSetting('last_sync_error');
    await handleRisk(risk);
    return sent;
  } finally {
    running = false;
  }
};

// Synchronisation automatique : les erreurs sont enregistrées au lieu d'être levées
export const autoSync = async () => {
  try {
    await syncOnce();
  } catch (e: any) {
    if (!isAuthError(e)) {
      setSetting('last_sync_error', e?.message ?? String(e)).catch(() => {});
    }
  }
};