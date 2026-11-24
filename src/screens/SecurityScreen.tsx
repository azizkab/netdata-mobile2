import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { RiskReport, getLastRisk, syncOnce } from '../services/sync';

const REFRESH_MS = 5000;

const CLASS_COLORS: Record<string, string> = {
  'Normal': '#27ae60',
  'Anomalie réseau': '#f39c12',
  'Menace potentielle': '#e67e22',
  'Menace confirmée': '#c0392b',
};

const COMPONENTS: { key: keyof RiskReport['components']; label: string; weight: string }[] = [
  { key: 'ml', label: 'Machine Learning', weight: '30 %' },
  { key: 'behavioral', label: 'Analyse comportementale', weight: '30 %' },
  { key: 'url', label: 'Réputation des domaines', weight: '20 %' },
  { key: 'mobile', label: 'Métriques mobiles', weight: '20 %' },
];

const barColor = (value: number) => (value < 30 ? '#27ae60' : value < 55 ? '#f39c12' : value < 75 ? '#e67e22' : '#c0392b');

const ago = (timestamp: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return seconds < 60 ? `il y a ${seconds} s` : `il y a ${Math.round(seconds / 60)} min`;
};

export default function SecurityScreen() {
  const [risk, setRisk] = useState<RiskReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRisk(await getLastRisk());
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const analyzeNow = async () => {
    setBusy(true);
    try {
      await syncOnce();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
    await load();
    setBusy(false);
  };

  if (!risk) {
    return (
      <View style={styles.empty}>
        {error && <Text style={styles.error}>{error}</Text>}
        <Text style={styles.emptyText}>Aucune analyse reçue pour l'instant.</Text>
        <Text style={styles.small}>Connecte-toi au serveur dans Paramètres : le score arrive avec la synchronisation.</Text>
      </View>
    );
  }

  const color = CLASS_COLORS[risk.risk_class] ?? '#7f8c8d';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {error && <Text style={styles.error}>{error}</Text>}

      <View style={[styles.scoreCard, { backgroundColor: color }]}>
        <Text style={styles.scoreValue}>{Math.round(risk.risk_score)}</Text>
        <Text style={styles.scoreMax}>/ 100</Text>
        <Text style={styles.scoreClass}>{risk.risk_class}</Text>
        <Text style={styles.scoreTime}>Analyse {ago(risk.timestamp)}</Text>
      </View>

      <TouchableOpacity style={[styles.button, busy && styles.disabled]} disabled={busy} onPress={analyzeNow}>
        <Text style={styles.buttonText}>{busy ? 'Envoi...' : 'Synchroniser et analyser'}</Text>
      </TouchableOpacity>

      <View style={styles.card}>
        <Text style={styles.title}>Composantes du score</Text>
        {COMPONENTS.map(c => {
          const value = risk.components[c.key] ?? 0;
          return (
            <View key={c.key} style={styles.component}>
              <View style={styles.row}>
                <Text>{c.label} ({c.weight})</Text>
                <Text style={styles.bold}>{Math.round(value)}</Text>
              </View>
              <View style={styles.barBackground}>
                <View style={[styles.bar, { width: `${Math.min(100, value)}%`, backgroundColor: barColor(value) }]} />
              </View>
            </View>
          );
        })}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Alertes ({risk.alerts.length})</Text>
        {risk.alerts.length === 0 ? (
          <Text style={styles.ok}>Aucune alerte</Text>
        ) : (
          risk.alerts.map(alert => (
            <Text key={alert} style={styles.alert}>• {alert}</Text>
          ))
        )}
      </View>

      {risk.suspicious_domains.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.title}>Domaines suspects</Text>
          {risk.suspicious_domains.map(d => (
            <View key={d.domain} style={styles.domain}>
              <Text style={styles.bold}>{d.domain}</Text>
              <Text style={styles.small}>
                {d.class} · score {d.score}
                {d.reasons.length > 0 ? ` · ${d.reasons.join(', ')}` : ''}
              </Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.title}>Prédictions</Text>
        <Text>
          Décharge batterie :{' '}
          {risk.predictions.battery_drain_per_hour !== null ? `${risk.predictions.battery_drain_per_hour} %/h` : 'N/A (en charge ou pas assez de données)'}
        </Text>
        <Text>
          Autonomie restante :{' '}
          {risk.predictions.battery_hours_left !== null ? `${risk.predictions.battery_hours_left} h` : 'N/A'}
        </Text>
        <Text>
          Signal mobile dans 30 min :{' '}
          {risk.predictions.signal_dbm_30min !== null
            ? `${risk.predictions.signal_dbm_30min} dBm${risk.predictions.signal_loss_risk ? ' (risque de perte)' : ''}`
            : 'N/A'}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>État des modèles</Text>
        <Text>
          Isolation Forest / One-Class SVM :{' '}
          {risk.ml.score !== undefined ? `actifs (${risk.ml.training_windows} min d'historique)` : risk.ml.status}
        </Text>
        <Text>
          Référence adaptative : {risk.baseline.score !== undefined ? 'active' : risk.baseline.status}
        </Text>
        <Text>Classifieur de domaines : {risk.domain_model}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { fontSize: 16, fontWeight: 'bold', marginBottom: 8, textAlign: 'center' },
  card: { backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 12, elevation: 2 },
  scoreCard: { borderRadius: 8, padding: 20, marginBottom: 12, alignItems: 'center', elevation: 2 },
  scoreValue: { fontSize: 56, fontWeight: 'bold', color: '#fff' },
  scoreMax: { fontSize: 16, color: '#fff', marginTop: -8 },
  scoreClass: { fontSize: 22, fontWeight: 'bold', color: '#fff', marginTop: 8 },
  scoreTime: { fontSize: 12, color: '#fff', marginTop: 4 },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  component: { marginBottom: 10 },
  barBackground: { height: 8, backgroundColor: '#ecf0f1', borderRadius: 4, marginTop: 4 },
  bar: { height: 8, borderRadius: 4 },
  bold: { fontWeight: 'bold' },
  small: { fontSize: 12, color: '#666', textAlign: 'center' },
  alert: { color: '#c0392b', marginBottom: 4 },
  ok: { color: '#27ae60' },
  domain: { marginBottom: 8 },
  error: { color: 'red', marginBottom: 8 },
  button: { backgroundColor: '#1e5aa0', padding: 10, borderRadius: 6, alignItems: 'center', marginBottom: 12 },
  disabled: { backgroundColor: '#8aa8c8' },
  buttonText: { color: '#fff', fontWeight: 'bold' },
});