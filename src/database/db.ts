import { NativeModules, Platform } from 'react-native';
import { open, DB } from '@op-engineering/op-sqlite';

// Tables prévues par le CDC (section 6.1)
export const TABLES = [
  'device_info',
  'system_metrics',
  'network_metrics',
  'flow_metrics',
  'gps_metrics',
  'rrc_messages',
  'pcap_captures',
  'ml_predictions',
] as const;

export type TableName = (typeof TABLES)[number];

// Tables envoyées au serveur (device_info est envoyé à part, avec chaque synchronisation)
export const SYNC_TABLES = TABLES.filter(t => t !== 'device_info');

export interface StoredRow {
  id: number;
  timestamp: number;
  kind: string | null;
  data: string;
}

let opening: Promise<DB> | null = null;

// Ouvre la base chiffrée (SQLCipher, AES-256) et crée les tables si besoin
export const getDb = (): Promise<DB> => {
  if (!opening) {
    opening = (async () => {
      const key: string = await NativeModules.SecureKey.getDatabaseKey();
      const db = open({ name: 'netdata.sqlite', encryptionKey: key });

      for (const table of TABLES) {
        await db.execute(
          `CREATE TABLE IF NOT EXISTS ${table} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            kind TEXT,
            data TEXT NOT NULL,
            synced INTEGER NOT NULL DEFAULT 0
          )`,
        );
        await db.execute(`CREATE INDEX IF NOT EXISTS idx_${table}_timestamp ON ${table}(timestamp)`);
        await db.execute(`CREATE INDEX IF NOT EXISTS idx_${table}_synced ON ${table}(synced)`);
      }

      // Paramètres de l'app (serveur, tokens JWT, identifiant du terminal) : stockés chiffrés eux aussi
      await db.execute('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      return db;
    })().catch(e => {
      opening = null; // nouvel essai au prochain appel
      throw e;
    });
  }
  return opening;
};

export const insert = async (table: TableName, data: object, kind: string | null = null) => {
  const db = await getDb();
  await db.execute(`INSERT INTO ${table} (timestamp, kind, data) VALUES (?, ?, ?)`, [
    Date.now(),
    kind,
    JSON.stringify(data),
  ]);
};

// Retourne les dernières lignes d'une table (données JSON), de la plus ancienne à la plus récente
export const getRecent = async <T>(table: TableName, limit: number, kind?: string): Promise<T[]> => {
  const db = await getDb();
  const res = kind
    ? await db.execute(`SELECT data FROM ${table} WHERE kind = ? ORDER BY timestamp DESC LIMIT ?`, [kind, limit])
    : await db.execute(`SELECT data FROM ${table} ORDER BY timestamp DESC LIMIT ?`, [limit]);
  return res.rows.map(row => JSON.parse(String(row.data)) as T).reverse();
};

export const countRows = async (): Promise<Record<TableName, number>> => {
  const db = await getDb();
  const counts = {} as Record<TableName, number>;
  for (const table of TABLES) {
    const res = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
    counts[table] = Number(res.rows[0]?.n ?? 0);
  }
  return counts;
};

export const clearAll = async () => {
  const db = await getDb();
  for (const table of TABLES) {
    await db.execute(`DELETE FROM ${table}`);
  }
};

// Enregistre les infos du terminal une seule fois
export const saveDeviceInfo = async () => {
  const db = await getDb();
  const res = await db.execute('SELECT COUNT(*) AS n FROM device_info');
  if (Number(res.rows[0]?.n ?? 0) > 0) return;

  const c = Platform.constants as any;
  await insert('device_info', {
    manufacturer: c.Manufacturer,
    brand: c.Brand,
    model: c.Model,
    android_version: c.Release,
    sdk_int: Platform.Version,
    fingerprint: c.Fingerprint,
  });
};

/* ---------- Synchronisation ---------- */

export const getUnsynced = async (table: TableName, limit: number): Promise<StoredRow[]> => {
  const db = await getDb();
  const res = await db.execute(
    `SELECT id, timestamp, kind, data FROM ${table} WHERE synced = 0 ORDER BY id LIMIT ?`,
    [limit],
  );
  return res.rows.map(row => ({
    id: Number(row.id),
    timestamp: Number(row.timestamp),
    kind: row.kind === null ? null : String(row.kind),
    data: String(row.data),
  }));
};

export const markSynced = async (table: TableName, ids: number[]) => {
  if (ids.length === 0) return;
  const db = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  await db.execute(`UPDATE ${table} SET synced = 1 WHERE id IN (${placeholders})`, ids);
};

export const countUnsynced = async (): Promise<number> => {
  const db = await getDb();
  let total = 0;
  for (const table of SYNC_TABLES) {
    const res = await db.execute(`SELECT COUNT(*) AS n FROM ${table} WHERE synced = 0`);
    total += Number(res.rows[0]?.n ?? 0);
  }
  return total;
};

/* ---------- Paramètres ---------- */

export const getSetting = async (key: string): Promise<string | null> => {
  const db = await getDb();
  const res = await db.execute('SELECT value FROM app_settings WHERE key = ?', [key]);
  return res.rows[0] ? String(res.rows[0].value) : null;
};

export const setSetting = async (key: string, value: string) => {
  const db = await getDb();
  await db.execute('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [key, value]);
};

export const deleteSetting = async (key: string) => {
  const db = await getDb();
  await db.execute('DELETE FROM app_settings WHERE key = ?', [key]);
};

// Identifiant unique du terminal, généré une seule fois
export const getDeviceId = async () => {
  let id = await getSetting('device_id');
  if (!id) {
    id = `android-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
    await setSetting('device_id', id);
  }
  return id;
};