import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, View, Text, StyleSheet, TouchableOpacity, Alert, Switch, TextInput } from 'react-native';
import { TABLES, TableName, countRows, clearAll, countUnsynced, getSetting } from '../database/db';
import { COLLECT_INTERVAL_MS, startBackground, stopBackground, isBackgroundRunning } from '../services/collector';
import { login, logout, isLoggedIn, pairDevice } from '../services/api';
import { syncOnce, SYNC_INTERVAL_MS } from '../services/sync';
import FlowMonitor from '../native/FlowMonitor';

const errorText = (e: any) => e?.message ?? String(e);

export default function SettingsScreen() {
  const [counts, setCounts] = useState<Record<TableName, number> | null>(null);
  const [background, setBackground] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [serverUrl, setServerUrl] = useState('https://netdata-aziz.duckdns.org');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [accountMode, setAccountMode] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [unsynced, setUnsynced] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [vpn, setVpn] = useState(false);
  const [usageAccess, setUsageAccess] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setCounts(await countRows());
      setBackground(await isBackgroundRunning());
      setLoggedIn(await isLoggedIn());
      setUnsynced(await countUnsynced());
      const last = await getSetting('last_sync');
      setLastSync(last ? new Date(Number(last)).toLocaleString() : null);
      setSyncError(await getSetting('last_sync_error'));
      setVpn(await FlowMonitor.isVpnRunning());
      setUsageAccess(await FlowMonitor.hasUsageAccess());
    } catch (e: any) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    const loadServer = async () => {
      try {
        const url = await getSetting('server_url');
        const user = await getSetting('username');
        if (url) setServerUrl(url);
        if (user) setUsername(user);
      } catch (e: any) {
        setError(errorText(e));
      }
    };
    loadServer();
    refresh();
  }, [refresh]);

  const handleLogin = async () => {
    setBusy(true);
    setInfo(null);
    setError(null);
    try {
      await login(serverUrl, username, password);
      setPassword('');
      setInfo('Connecté au serveur');
    } catch (e: any) {
      setError('Connexion : ' + errorText(e));
    }
    setBusy(false);
    refresh();
  };

  const handlePair = async () => {
    setBusy(true);
    setInfo(null);
    setError(null);
    try {
      await pairDevice(serverUrl, pairingCode);
      setPairingCode('');
      setUsername((await getSetting('username')) ?? username);
      setInfo('Téléphone associé au serveur');
    } catch (e: any) {
      setError('Association : ' + errorText(e));
    }
    setBusy(false);
    refresh();
  };

  const handleLogout = async () => {
    await logout();
    setInfo('Déconnecté');
    refresh();
  };

  const handleSync = async () => {
    setBusy(true);
    setInfo(null);
    setError(null);
    try {
      const sent = await syncOnce();
      setInfo(`${sent} enregistrement(s) envoyé(s)`);
    } catch (e: any) {
      setError('Synchronisation : ' + errorText(e));
    }
    setBusy(false);
    refresh();
  };

  const toggleBackground = async (enabled: boolean) => {
    try {
      if (enabled) {
        await startBackground();
      } else {
        await stopBackground();
      }
      setBackground(enabled);
    } catch (e: any) {
      setError(errorText(e));
    }
  };

  const toggleVpn = async (enabled: boolean) => {
    try {
      if (enabled) {
        const accepted = await FlowMonitor.startVpn();
        if (!accepted) setError('Autorisation VPN refusée');
        setVpn(accepted);
      } else {
        await FlowMonitor.stopVpn();
        setVpn(false);
      }
    } catch (e: any) {
      setError(errorText(e));
    }
  };

  const confirmClear = () => {
    Alert.alert('Vider la base', 'Supprimer toutes les données enregistrées ?', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Supprimer',
        style: 'destructive',
        onPress: async () => {
          try {
            await clearAll();
          } catch (e: any) {
            setError(errorText(e));
          }
          refresh();
        },
      },
    ]);
  };

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      {error && <Text style={styles.error}>Erreur : {error}</Text>}
      {info && <Text style={styles.info}>{info}</Text>}

      <View style={styles.card}>
        <Text style={styles.title}>Serveur</Text>
        {loggedIn ? (
          <>
            <Text>Connecté à {serverUrl} ({username})</Text>
            <Text style={styles.small}>Synchronisation automatique toutes les {SYNC_INTERVAL_MS / 1000} s</Text>
            <Text>Dernière synchronisation : {lastSync ?? 'jamais'}</Text>
            <Text>En attente d'envoi : {unsynced ?? '...'}</Text>
            {syncError && <Text style={styles.error}>Dernière erreur : {syncError}</Text>}

            <TouchableOpacity style={[styles.button, busy && styles.disabled]} disabled={busy} onPress={handleSync}>
              <Text style={styles.buttonText}>{busy ? 'Envoi...' : 'Synchroniser maintenant'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, styles.secondary]} onPress={handleLogout}>
              <Text style={styles.buttonText}>Se déconnecter</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.label}>Adresse du serveur</Text>
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />

            {accountMode ? (
              <>
                <Text style={styles.label}>Utilisateur</Text>
                <TextInput
                  style={styles.input}
                  value={username}
                  onChangeText={setUsername}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={styles.label}>Mot de passe</Text>
                <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry />

                <TouchableOpacity style={[styles.button, busy && styles.disabled]} disabled={busy} onPress={handleLogin}>
                  <Text style={styles.buttonText}>{busy ? 'Connexion...' : 'Se connecter'}</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.label}>Code d'association (6 chiffres)</Text>
                <TextInput
                  style={[styles.input, styles.code]}
                  value={pairingCode}
                  onChangeText={t => setPairingCode(t.replace(/\D/g, '').slice(0, 6))}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="123456"
                />
                <Text style={styles.small}>Code généré par l'administrateur sur le dashboard web (valable 10 min)</Text>

                <TouchableOpacity
                  style={[styles.button, (busy || pairingCode.length !== 6) && styles.disabled]}
                  disabled={busy || pairingCode.length !== 6}
                  onPress={handlePair}>
                  <Text style={styles.buttonText}>{busy ? 'Association...' : 'Associer ce téléphone'}</Text>
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity onPress={() => setAccountMode(!accountMode)}>
              <Text style={styles.link}>
                {accountMode ? 'Associer avec un code' : 'Se connecter avec un compte (administrateur)'}
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Collecte en arrière-plan</Text>
        <View style={styles.row}>
          <Text>Service actif (notification permanente)</Text>
          <Switch value={background} onValueChange={toggleBackground} />
        </View>
        <Text style={styles.small}>
          Quand il est activé, la collecte continue même si l'app est fermée ou l'écran éteint.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Flux réseau (VPN local)</Text>
        <View style={styles.row}>
          <Text>Capture des requêtes DNS</Text>
          <Switch value={vpn} onValueChange={toggleVpn} />
        </View>
        <Text style={styles.small}>
          Seul le DNS passe par le VPN : domaines contactés, temps de réponse et application à l'origine.
        </Text>
        <View style={styles.row}>
          <Text>Volumes par application : {usageAccess ? 'autorisé' : 'non autorisé'}</Text>
        </View>
        {!usageAccess && (
          <TouchableOpacity style={styles.button} onPress={() => FlowMonitor.openUsageAccessSettings()}>
            <Text style={styles.buttonText}>Autoriser l'accès aux statistiques</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Base de données locale</Text>
        <Text style={styles.small}>SQLite chiffrée (SQLCipher AES-256)</Text>
        <Text style={styles.small}>Collecte automatique toutes les {COLLECT_INTERVAL_MS / 1000} s</Text>
        {counts ? (
          TABLES.map(table => (
            <View key={table} style={styles.row}>
              <Text>{table}</Text>
              <Text style={styles.bold}>{counts[table]}</Text>
            </View>
          ))
        ) : (
          <Text>Chargement...</Text>
        )}

        <TouchableOpacity style={styles.button} onPress={refresh}>
          <Text style={styles.buttonText}>Actualiser</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.button, styles.danger]} onPress={confirmClear}>
          <Text style={styles.buttonText}>Vider la base</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  card: { backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 12, elevation: 2 },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  small: { fontSize: 12, color: '#666', marginBottom: 4 },
  label: { marginTop: 8, marginBottom: 4, fontWeight: 'bold' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8 },
  code: { fontSize: 24, letterSpacing: 8, textAlign: 'center' },
  link: { color: '#1e5aa0', textAlign: 'center', marginTop: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  bold: { fontWeight: 'bold' },
  error: { color: 'red', marginBottom: 8 },
  info: { color: 'green', marginBottom: 8 },
  button: { backgroundColor: '#1e5aa0', padding: 10, borderRadius: 6, alignItems: 'center', marginTop: 12 },
  secondary: { backgroundColor: '#6c7a89' },
  danger: { backgroundColor: '#c0392b' },
  disabled: { backgroundColor: '#8aa8c8' },
  buttonText: { color: '#fff', fontWeight: 'bold' },
});



