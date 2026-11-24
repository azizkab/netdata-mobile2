import React, { useEffect, useState } from 'react';
import { ScrollView, View, Text, StyleSheet, Dimensions, TouchableOpacity } from 'react-native';
import { LineChart, BarChart, ProgressChart } from 'react-native-chart-kit';
import SystemMetrics, { MemoryInfo, StorageInfo, BatteryInfo, CpuInfo, ThermalZone } from '../native/SystemMetrics';

const toGo = (bytes: number) => (bytes / 1024 ** 3).toFixed(2) + ' Go';

const MAX_POINTS = 20;
const REFRESH_OPTIONS = [1000, 5000, 10000];
const chartWidth = Dimensions.get('window').width - 64;

const chartConfig = {
  backgroundGradientFrom: '#fff',
  backgroundGradientTo: '#fff',
  decimalPlaces: 0,
  color: (opacity = 1) => `rgba(30, 90, 160, ${opacity})`,
  labelColor: (opacity = 1) => `rgba(0, 0, 0, ${opacity})`,
  propsForDots: { r: '2' },
};

// Série invisible pour fixer l'échelle des courbes en pourcentage entre 0 et 100
const SCALE_0_100 = { data: [0, 100], color: () => 'transparent', withDots: false };

const getCpuTemp = (zones: ThermalZone[]) => {
  const cpuZones = zones.filter(z => z.type.toLowerCase().includes('cpu'));
  return cpuZones.length > 0 ? Math.max(...cpuZones.map(z => z.temp)) : null;
};

const pushPoint = (arr: number[], v: number) => [...arr, v].slice(-MAX_POINTS);

export default function DashboardScreen() {
  const [memory, setMemory] = useState<MemoryInfo | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [battery, setBattery] = useState<BatteryInfo | null>(null);
  const [cpu, setCpu] = useState<CpuInfo | null>(null);
  const [thermal, setThermal] = useState<ThermalZone[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [refreshMs, setRefreshMs] = useState(5000);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [ramHistory, setRamHistory] = useState<number[]>([]);
  const [tempHistory, setTempHistory] = useState<number[]>([]);

  useEffect(() => {
    const load = async () => {
      try {
        const [m, s, b, c, t] = await Promise.all([
          SystemMetrics.getMemoryInfo(),
          SystemMetrics.getStorageInfo(),
          SystemMetrics.getBatteryInfo(),
          SystemMetrics.getCpuInfo(),
          SystemMetrics.getThermalInfo(),
        ]);
        setMemory(m);
        setStorage(s);
        setBattery(b);
        setCpu(c);
        setThermal(t);
        setError(null);

        setCpuHistory(h => pushPoint(h, Math.max(0, c.usagePercent)));
        setRamHistory(h => pushPoint(h, m.usagePercent));
        const temp = getCpuTemp(t);
        if (temp !== null) {
          setTempHistory(h => pushPoint(h, temp));
        }
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    };

    load();
    const id = setInterval(load, refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);

  const cpuTemp = getCpuTemp(thermal);
  const systemZone = thermal.find(z => z.type === 'xo-therm-usr');

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {error && <Text style={styles.error}>Erreur : {error}</Text>}

      <View style={styles.card}>
        <Text style={styles.title}>Actualisation</Text>
        <View style={styles.row}>
          {REFRESH_OPTIONS.map(ms => (
            <TouchableOpacity
              key={ms}
              style={[styles.button, refreshMs === ms && styles.buttonActive]}
              onPress={() => setRefreshMs(ms)}>
              <Text style={refreshMs === ms ? styles.buttonTextActive : undefined}>{ms / 1000} s</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Jauges</Text>
        {memory && storage && battery ? (
          <ProgressChart
            data={{
              labels: ['RAM', 'Stockage', 'Batterie'],
              data: [memory.usagePercent / 100, storage.usagePercent / 100, battery.level / 100],
            }}
            width={chartWidth}
            height={160}
            strokeWidth={10}
            radius={24}
            chartConfig={chartConfig}
          />
        ) : <Text>Chargement...</Text>}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Historique CPU / RAM (%)</Text>
        {cpuHistory.length >= 2 ? (
          <LineChart
            data={{
              labels: cpuHistory.map(() => ''),
              datasets: [
                { data: cpuHistory, color: (o = 1) => `rgba(220, 60, 60, ${o})` },
                { data: ramHistory, color: (o = 1) => `rgba(30, 90, 160, ${o})` },
                SCALE_0_100,
              ],
              legend: ['CPU', 'RAM'],
            }}
            width={chartWidth}
            height={200}
            yAxisSuffix="%"
            chartConfig={chartConfig}
            bezier
          />
        ) : <Text>Collecte des données...</Text>}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>CPU</Text>
        {cpu ? (
          <>
            <Text>Cœurs : {cpu.cores}</Text>
            <Text>Charge globale (estimée) : {cpu.usagePercent >= 0 ? cpu.usagePercent.toFixed(1) + ' %' : 'N/A'}</Text>
            <Text>Charge moyenne : {cpu.loadAverage >= 0 ? cpu.loadAverage.toFixed(2) : 'N/A'}</Text>
            {cpu.perCore.map(core => (
              <Text key={core.id}>
                Cœur {core.id} : {core.curFreqMHz >= 0
                  ? `${core.curFreqMHz.toFixed(0)} / ${core.maxFreqMHz.toFixed(0)} MHz (${core.load.toFixed(0)} %)`
                  : 'hors ligne'}
              </Text>
            ))}
            <BarChart
              data={{
                labels: cpu.perCore.map(core => 'C' + core.id),
                datasets: [{ data: cpu.perCore.map(core => Math.max(0, core.load)) }],
              }}
              width={chartWidth}
              height={200}
              yAxisLabel=""
              yAxisSuffix="%"
              fromZero
              chartConfig={chartConfig}
              style={styles.chart}
            />
          </>
        ) : <Text>Chargement...</Text>}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Température</Text>
        <Text>CPU : {cpuTemp !== null ? cpuTemp.toFixed(1) + ' °C' : 'N/A'}</Text>
        <Text>Batterie : {battery ? battery.temperature.toFixed(1) + ' °C' : 'N/A'}</Text>
        <Text>Système : {systemZone ? systemZone.temp.toFixed(1) + ' °C' : 'N/A'}</Text>
        <Text>Zones thermiques lisibles : {thermal.length}</Text>
        {tempHistory.length >= 2 && (
          <LineChart
            data={{
              labels: tempHistory.map(() => ''),
              datasets: [{ data: tempHistory, color: (o = 1) => `rgba(230, 120, 30, ${o})` }],
              legend: ['CPU (°C)'],
            }}
            width={chartWidth}
            height={180}
            yAxisSuffix="°"
            chartConfig={chartConfig}
            bezier
            style={styles.chart}
          />
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>RAM</Text>
        {memory ? (
          <>
            <Text>Totale : {toGo(memory.total)}</Text>
            <Text>Utilisée : {toGo(memory.used)}</Text>
            <Text>Disponible : {toGo(memory.available)}</Text>
            <Text>Utilisation : {memory.usagePercent.toFixed(1)} %</Text>
          </>
        ) : <Text>Chargement...</Text>}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Stockage</Text>
        {storage ? (
          <>
            <Text>Total : {toGo(storage.total)}</Text>
            <Text>Utilisé : {toGo(storage.used)}</Text>
            <Text>Libre : {toGo(storage.free)}</Text>
            <Text>Occupation : {storage.usagePercent.toFixed(1)} %</Text>
          </>
        ) : <Text>Chargement...</Text>}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Batterie</Text>
        {battery ? (
          <>
            <Text>Niveau : {battery.level.toFixed(0)} %</Text>
            <Text>En charge : {battery.isCharging ? 'Oui' : 'Non'}</Text>
            <Text>Santé : {battery.health}</Text>
            <Text>Température : {battery.temperature.toFixed(1)} °C</Text>
            <Text>Tension : {battery.voltage.toFixed(2)} V</Text>
            <Text>Intensité : {battery.currentNow.toFixed(0)} mA</Text>
            <Text>
              Temps avant charge complète :{' '}
              {battery.chargeTimeRemaining > 0
                ? Math.round(battery.chargeTimeRemaining / 60000) + ' min'
                : 'N/A'}
            </Text>
          </>
        ) : <Text>Chargement...</Text>}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  card: { backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 12, elevation: 2 },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 8 },
  error: { color: 'red', marginBottom: 12 },
  chart: { marginTop: 8 },
  row: { flexDirection: 'row' },
  button: { paddingVertical: 6, paddingHorizontal: 16, borderRadius: 6, borderWidth: 1, borderColor: '#1e5aa0', marginRight: 8 },
  buttonActive: { backgroundColor: '#1e5aa0' },
  buttonTextActive: { color: '#fff' },
});