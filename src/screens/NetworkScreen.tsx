import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, View, Text, StyleSheet, PermissionsAndroid, TouchableOpacity } from 'react-native';
import NetworkMetrics, { ConnectionInfo, WifiInfo, MobileInfo } from '../native/NetworkMetrics';
import NetworkTests, { DnsResult, TcpResult, HttpResult, ThroughputResult } from '../native/NetworkTests';
import { insert, getRecent } from '../database/db';
import SignalingMonitor, { SignalingEvent, CellSnapshot, RadioSnapshot, RadioCell } from '../native/SignalingMonitor';

const REFRESH_MS = 2000;

// URLs et serveurs de référence pour les tests actifs
const DNS_DOMAIN = 'google.com';
const DNS_SERVERS = ['system', '8.8.8.8', '1.1.1.1', '9.9.9.9'];
const DNS_ATTEMPTS = 5;
const TCP_HOST = '1.1.1.1';
const TCP_PORT = 443;
const TCP_ATTEMPTS = 10;
const HTTP_URLS = ['https://www.google.com', 'https://www.cloudflare.com', 'https://fr.wikipedia.org'];
const DOWNLOAD_URL = 'https://speed.cloudflare.com/__down?bytes=5000000';
const UPLOAD_URL = 'https://speed.cloudflare.com/__up';
const UPLOAD_SIZE = 2000000;

const formatRate = (bytesPerSec: number) =>
  bytesPerSec >= 1024 * 1024
    ? (bytesPerSec / 1024 / 1024).toFixed(2) + ' Mo/s'
    : (bytesPerSec / 1024).toFixed(1) + ' Ko/s';

const formatKbps = (kbps: number) =>
  kbps < 0 ? 'N/A' : kbps >= 1000 ? (kbps / 1000).toFixed(1) + ' Mbit/s' : kbps + ' kbit/s';

const show = (v: number | null, unit = '') => (v === null ? 'N/A' : `${v}${unit}`);

const showMs = (v: number) => (v < 0 ? 'N/A' : v.toFixed(0) + ' ms');

const errorText = (e: any) => e?.message ?? String(e);

// Enregistre un résultat de test dans la table network_metrics
const saveTest = (kind: string, data: object) =>
  insert('network_metrics', data, kind).catch(e => console.warn('Enregistrement test :', e));

const cellText = (c?: CellSnapshot) => (c ? `${c.tech} ${c.cell_id ?? '?'} (PCI ${c.pci ?? '?'})` : '?');

const STATE_LABELS: Record<string, string> = {
  in_service: 'en service',
  out_of_service: 'hors service',
  emergency_only: 'urgences uniquement',
  power_off: 'radio coupée',
};

const eventText = (e: SignalingEvent) => {
  if (e.event === 'cell_change') {
    return `${e.change_type === 'handover' ? 'Handover' : 'Resélection'} : ${cellText(e.from_cell)} → ${cellText(e.to_cell)}`;
  }
  if (e.event === 'technology_change') {
    return `Technologie : ${e.from_tech} → ${e.to_tech}${e.downgrade ? ' (rétrogradation)' : ''}`;
  }
  if (e.event === 'registration') {
    const cause = e.reject_cause ? ` (cause de rejet ${e.reject_cause})` : '';
    return `Enregistrement : ${REGISTRATION_LABELS[e.from_registration ?? ''] ?? e.from_registration} → ${REGISTRATION_LABELS[e.to_registration ?? ''] ?? e.to_registration}${cause}`;
  }
  if (e.event === 'nr_state') {
    return `5G NSA : ${NR_LABELS[e.from_nr_state ?? ''] ?? e.from_nr_state} → ${NR_LABELS[e.to_nr_state ?? ''] ?? e.to_nr_state}`;
  }
  return `Service : ${STATE_LABELS[e.from_state ?? ''] ?? e.from_state} → ${STATE_LABELS[e.to_state ?? ''] ?? e.to_state}`;
};

const isWarning = (e: SignalingEvent) =>
  (e.event === 'technology_change' && (e.downgrade || e.to_tech === '2G')) ||
  (e.event === 'service_state' && e.to_state !== 'in_service') ||
  (e.event === 'registration' && (e.to_registration === 'denied' || e.to_registration === 'searching'));

const REGISTRATION_LABELS: Record<string, string> = {
  registered: 'enregistré',
  registered_roaming: 'enregistré (itinérance)',
  searching: 'recherche de réseau',
  denied: 'refusé',
  not_registered: 'non enregistré',
};

const NR_LABELS: Record<string, string> = {
  NONE: 'non disponible',
  RESTRICTED: 'restreinte',
  NOT_RESTRICTED: 'disponible',
  CONNECTED: 'connectée',
};

const val = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? 'N/A' : `${v}${unit}`);

const cellMeasures = (c: RadioCell) =>
  c.tech === 'LTE' || c.tech === 'NR'
    ? `RSRP ${val(c.rsrp, ' dBm')} · RSRQ ${val(c.rsrq, ' dB')} · SINR ${val(c.sinr, ' dB')}`
    : `Signal ${val(c.dbm, ' dBm')}`;

export default function NetworkScreen() {
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [wifi, setWifi] = useState<WifiInfo | null>(null);
  const [mobile, setMobile] = useState<MobileInfo | null>(null);
  const [rates, setRates] = useState<{ down: number; up: number } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const previous = useRef<{ rx: number; tx: number; time: number } | null>(null);

  const [testing, setTesting] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [dnsResults, setDnsResults] = useState<DnsResult[]>([]);
  const [tcpResult, setTcpResult] = useState<TcpResult | null>(null);
  const [httpResults, setHttpResults] = useState<HttpResult[]>([]);
  const [download, setDownload] = useState<ThroughputResult | null>(null);
  const [upload, setUpload] = useState<ThroughputResult | null>(null);
  const [testErrors, setTestErrors] = useState<string[]>([]);
  const [signaling, setSignaling] = useState<SignalingEvent[]>([]);
  const [radio, setRadio] = useState<RadioSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    let id: ReturnType<typeof setInterval> | undefined;

    const load = async () => {
      const errs: string[] = [];

      try {
        const c = await NetworkMetrics.getConnectionInfo();
        setConnection(c);
        const now = Date.now();
        if (previous.current) {
          const dt = (now - previous.current.time) / 1000;
          setRates({
            down: (c.rxBytes - previous.current.rx) / dt,
            up: (c.txBytes - previous.current.tx) / dt,
          });
        }
        previous.current = { rx: c.rxBytes, tx: c.txBytes, time: now };
      } catch (e: any) {
        errs.push('Connexion : ' + errorText(e));
      }

      try {
        setWifi(await NetworkMetrics.getWifiInfo());
      } catch (e: any) {
        errs.push('Wi-Fi : ' + errorText(e));
      }

      try {
        setMobile(await NetworkMetrics.getMobileInfo());
      } catch (e: any) {
        errs.push('Mobile : ' + errorText(e));
      }

      try {
        setSignaling((await getRecent<SignalingEvent>('rrc_messages', 10, 'android_event')).reverse());
      } catch (e: any) {
        errs.push('Signalisation : ' + errorText(e));
      }

      try {
        setRadio(await SignalingMonitor.getRadioSnapshot());
      } catch (e: any) {
        errs.push('Mesures radio : ' + errorText(e));
      }

      setErrors(errs);
    };

    const start = async () => {
      await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
      ]);
      if (cancelled) return;
      load();
      id = setInterval(load, REFRESH_MS);
    };

    start();
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
  }, []);

  // Tests exécutés un par un pour qu'ils ne se perturbent pas entre eux
  const runTests = async () => {
    setTesting(true);
    const errs: string[] = [];

    const dns: DnsResult[] = [];
    for (const server of DNS_SERVERS) {
      try {
        const r = await NetworkTests.dnsTest(DNS_DOMAIN, server, DNS_ATTEMPTS);
        dns.push(r);
        saveTest('dns', r);
      } catch (e: any) {
        errs.push(`DNS ${server} : ${errorText(e)}`);
      }
    }
    setDnsResults(dns);

    try {
      const r = await NetworkTests.tcpTest(TCP_HOST, TCP_PORT, TCP_ATTEMPTS);
      setTcpResult(r);
      saveTest('tcp', r);
    } catch (e: any) {
      errs.push('TCP : ' + errorText(e));
    }

    const http: HttpResult[] = [];
    for (const url of HTTP_URLS) {
      try {
        const r = await NetworkTests.httpTest(url);
        http.push(r);
        saveTest('http', r);
      } catch (e: any) {
        errs.push(`HTTP ${url} : ${errorText(e)}`);
      }
    }
    setHttpResults(http);

    try {
      const r = await NetworkTests.downloadTest(DOWNLOAD_URL);
      setDownload(r);
      saveTest('download', r);
    } catch (e: any) {
      errs.push('Débit descendant : ' + errorText(e));
    }

    try {
      const r = await NetworkTests.uploadTest(UPLOAD_URL, UPLOAD_SIZE);
      setUpload(r);
      saveTest('upload', r);
    } catch (e: any) {
      errs.push('Débit montant : ' + errorText(e));
    }

    setTestErrors(errs);
    setLastRun(new Date().toLocaleTimeString());
    setTesting(false);
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {errors.map(err => (
        <Text key={err} style={styles.error}>{err}</Text>
      ))}

      <View style={styles.card}>
        <Text style={styles.title}>Connexion active</Text>
        {connection ? (
          <>
            <Text>Type : {connection.transport}</Text>
            <Text>Adresse IP : {connection.ipAddress}</Text>
            <Text>Débit réel descendant : {rates ? formatRate(rates.down) : 'Mesure...'}</Text>
            <Text>Débit réel montant : {rates ? formatRate(rates.up) : 'Mesure...'}</Text>
            <Text>Débit estimé descendant : {formatKbps(connection.downstreamKbps)}</Text>
            <Text>Débit estimé montant : {formatKbps(connection.upstreamKbps)}</Text>
          </>
        ) : <Text>Chargement...</Text>}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Wi-Fi</Text>
        {wifi ? (
          <>
            <Text>SSID : {wifi.ssid}</Text>
            <Text>BSSID : {wifi.bssid}</Text>
            <Text>RSSI : {wifi.rssi} dBm (niveau {wifi.signalLevel}/4)</Text>
            <Text>Bande : {wifi.band} ({wifi.frequency} MHz)</Text>
            <Text>Débit de liaison : {wifi.linkSpeedMbps} Mbit/s</Text>
          </>
        ) : <Text>Non connecté au Wi-Fi</Text>}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Réseau mobile</Text>
        {mobile ? (
          <>
            <Text>Opérateur : {mobile.operator || 'N/A'}</Text>
            <Text>Type : {mobile.networkType}</Text>
            <Text>Signal : {show(mobile.signalDbm, ' dBm')} (niveau {mobile.signalLevel}/4)</Text>
            <Text>Cell ID : {show(mobile.cellId)}</Text>
            <Text>PCI : {show(mobile.pci)}</Text>
            <Text>TAC : {show(mobile.tac)}</Text>
            <Text>Bande : {mobile.band}</Text>
          </>
        ) : <Text>Chargement...</Text>}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Cellule servante (mesures radio)</Text>
        <Text style={styles.small}>Signalisation via API Android (sans root)</Text>
        {radio && radio.serving.length > 0 ? (
          radio.serving.map(c => (
            <View key={`${c.tech}-${c.cell_id}-${c.pci}`} style={styles.block}>
              <Text style={styles.bold}>
                {c.tech} · Cell ID {val(c.cell_id)} · PCI {val(c.pci)} · TAC {val(c.tac)}
              </Text>
              <Text>{cellMeasures(c)}</Text>
              <Text>
                PLMN {c.mcc ?? '?'}-{c.mnc ?? '?'} · ARFCN {val(c.arfcn)}
                {c.bands && c.bands.length > 0 ? ` · Bande ${c.bands.join(',')}` : ''}
                {c.bandwidth_khz ? ` · ${c.bandwidth_khz / 1000} MHz` : ''}
              </Text>
              {(c.cqi !== undefined || c.timing_advance !== undefined) && (
                <Text>CQI {val(c.cqi)} · Timing advance {val(c.timing_advance)}</Text>
              )}
            </View>
          ))
        ) : (
          <Text>Aucune cellule servante (localisation activée ?)</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Enregistrement réseau</Text>
        {radio?.registration ? (
          <>
            <Text>Opérateur : {radio.registration.operator ?? 'N/A'}</Text>
            <Text>
              État : {REGISTRATION_LABELS[radio.registration.registration ?? ''] ?? radio.registration.registration ?? 'N/A'}
              {radio.registration.roaming ? ' (itinérance)' : ''}
            </Text>
            <Text>Technologie d'accès : {radio.registration.access_tech ?? 'N/A'} · Affichée : {radio.technology ?? 'N/A'}</Text>
            <Text>5G NSA : {NR_LABELS[radio.registration.nr_state ?? ''] ?? radio.registration.nr_state ?? 'N/A'}</Text>
            <Text>
              Duplex : {radio.registration.duplex ?? 'N/A'} · Porteuses :{' '}
              {radio.registration.cell_bandwidths_khz.length > 0
                ? radio.registration.cell_bandwidths_khz.map(b => `${b / 1000} MHz`).join(' + ')
                : 'N/A'}
              {radio.registration.cell_bandwidths_khz.length > 1 ? ' (agrégation)' : ''}
            </Text>
            {radio.registration.reject_cause !== null && (
              <Text style={styles.warning}>Cause de rejet : {radio.registration.reject_cause}</Text>
            )}
          </>
        ) : (
          <Text>N/A</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Cellules voisines ({radio?.neighbors.length ?? 0})</Text>
        {radio && radio.neighbors.length > 0 ? (
          radio.neighbors.map((c, i) => (
            <Text key={`${i}-${c.tech}-${c.pci}-${c.arfcn}`}>
              {c.tech} · PCI {val(c.pci)} · ARFCN {val(c.arfcn)} · {cellMeasures(c)}
            </Text>
          ))
        ) : (
          <Text>Aucune cellule voisine mesurée</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Signalisation (temps réel)</Text>
        {signaling.length === 0 ? (
          <Text>Aucun événement pour l'instant (changement de cellule ou de technologie)</Text>
        ) : (
          signaling.map(e => (
            <View key={`${e.timestamp}-${e.event}`} style={styles.block}>
              <Text style={styles.small}>{new Date(e.timestamp).toLocaleTimeString()}</Text>
              <Text style={isWarning(e) ? styles.warning : undefined}>{eventText(e)}</Text>
            </View>
          ))
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Tests réseau actifs</Text>
        <TouchableOpacity
          style={[styles.button, testing && styles.buttonDisabled]}
          disabled={testing}
          onPress={runTests}>
          <Text style={styles.buttonText}>{testing ? 'Tests en cours...' : 'Lancer les tests'}</Text>
        </TouchableOpacity>
        {lastRun && <Text style={styles.small}>Dernière exécution : {lastRun}</Text>}
        {testErrors.map(err => (
          <Text key={err} style={styles.error}>{err}</Text>
        ))}

        {dnsResults.length > 0 && (
          <>
            <Text style={styles.subtitle}>DNS ({DNS_DOMAIN})</Text>
            {dnsResults.map(r => (
              <Text key={r.server}>
                {r.server === 'system' ? 'DNS système' : r.server} : {showMs(r.avgMs)} — échecs {r.failureRate.toFixed(0)} %
              </Text>
            ))}
          </>
        )}

        {tcpResult && (
          <>
            <Text style={styles.subtitle}>TCP ({tcpResult.host}:{tcpResult.port})</Text>
            <Text>Latence moyenne : {showMs(tcpResult.avgMs)}</Text>
            <Text>Min / Max : {showMs(tcpResult.minMs)} / {showMs(tcpResult.maxMs)}</Text>
            <Text>Jitter : {tcpResult.jitterMs.toFixed(1)} ms</Text>
            <Text>Perte : {tcpResult.lossPercent.toFixed(0)} %</Text>
          </>
        )}

        {httpResults.length > 0 && (
          <>
            <Text style={styles.subtitle}>HTTP/HTTPS</Text>
            {httpResults.map(r => (
              <View key={r.url} style={styles.block}>
                <Text style={styles.bold}>{r.url} (code {r.statusCode})</Text>
                <Text>DNS {showMs(r.dnsMs)} · TCP {showMs(r.tcpMs)} · TLS {showMs(r.tlsMs)}</Text>
                <Text>Réponse {showMs(r.responseMs)} · Total {showMs(r.totalMs)}</Text>
              </View>
            ))}
          </>
        )}

        {(download || upload) && (
          <>
            <Text style={styles.subtitle}>Débit</Text>
            {download && <Text>Descendant : {download.mbps.toFixed(2)} Mbit/s</Text>}
            {upload && <Text>Montant : {upload.mbps.toFixed(2)} Mbit/s</Text>}
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  card: { backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 12, elevation: 2 },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 8 },
  subtitle: { fontSize: 16, fontWeight: 'bold', marginTop: 12, marginBottom: 4 },
  error: { color: 'red', marginBottom: 4 },
  small: { fontSize: 12, color: '#666', marginTop: 6 },
  bold: { fontWeight: 'bold' },
  warning: { color: '#c0392b', fontWeight: 'bold' },
  block: { marginBottom: 6 },
  button: { backgroundColor: '#1e5aa0', padding: 10, borderRadius: 6, alignItems: 'center' },
  buttonDisabled: { backgroundColor: '#8aa8c8' },
  buttonText: { color: '#fff', fontWeight: 'bold' },
});