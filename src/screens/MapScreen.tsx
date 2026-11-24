import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { GpsPoint, onGpsPoint } from '../services/collector';
import { getRecent } from '../database/db';

const MAX_TRACK_POINTS = 500;

const LEAFLET_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>html, body, #map { height: 100%; margin: 0; padding: 0; }</style>
</head>
<body>
  <div id="map"></div>
  <script>
    var map = L.map('map').setView([46.6, 2.4], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    var track = L.polyline([], { color: '#1e5aa0', weight: 4 }).addTo(map);
    var current = null;
    var first = true;

    function value(v) { return v === null || v === undefined ? 'N/A' : v; }

    function popup(p) {
      return '<b>' + new Date(p.timestamp).toLocaleTimeString() + '</b><br>' +
        'Réseau : ' + p.networkType + '<br>' +
        'Cell ID : ' + value(p.cellId) + '<br>' +
        'PCI : ' + value(p.pci) + '<br>' +
        'Bande : ' + p.band;
    }

    function addPoint(p) {
      var ll = [p.latitude, p.longitude];
      track.addLatLng(ll);
      L.circleMarker(ll, { radius: 4, color: '#dc3c3c' }).bindPopup(popup(p)).addTo(map);
      if (!current) {
        current = L.marker(ll).addTo(map);
      } else {
        current.setLatLng(ll);
      }
      current.bindPopup(popup(p));
      if (first) {
        map.setView(ll, 16);
        first = false;
      } else {
        map.panTo(ll);
      }
    }

    // Messages envoyés par l'app React Native (postMessage)
    document.addEventListener('message', function (event) {
      var msg = JSON.parse(event.data);
      if (msg.type === 'init') msg.points.forEach(addPoint);
      if (msg.type === 'point') addPoint(msg.point);
    });

    window.ReactNativeWebView.postMessage('ready');
  </script>
</body>
</html>`;

const show = (v: number | null, unit: string, digits = 0) => (v === null ? 'N/A' : v.toFixed(digits) + unit);

export default function MapScreen() {
  const webViewRef = useRef<WebView>(null);
  const mapReady = useRef(false);
  const [last, setLast] = useState<GpsPoint | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const send = (msg: object) => webViewRef.current?.postMessage(JSON.stringify(msg));

  // Les points sont collectés et enregistrés par le service de collecte ; l'écran ne fait que les afficher
  useEffect(
    () =>
      onGpsPoint(point => {
        setLast(point);
        setCount(c => c + 1);
        if (mapReady.current) send({ type: 'point', point });
      }),
    [],
  );

  const onMessage = async (event: WebViewMessageEvent) => {
    if (event.nativeEvent.data !== 'ready') return;
    try {
      // Recharge le tracé enregistré en base
      const points = await getRecent<GpsPoint>('gps_metrics', MAX_TRACK_POINTS);
      send({ type: 'init', points });
      setCount(points.length);
      if (points.length > 0) {
        setLast(prev => prev ?? points[points.length - 1]);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
    mapReady.current = true;
  };

  return (
    <View style={styles.container}>
      <View style={styles.panel}>
        {error && <Text style={styles.error}>{error}</Text>}
        {last ? (
          <>
            <Text>Lat : {last.latitude.toFixed(6)} · Lon : {last.longitude.toFixed(6)}</Text>
            <Text>
              Altitude : {show(last.altitude, ' m')} · Vitesse :{' '}
              {last.speed !== null ? (last.speed * 3.6).toFixed(1) + ' km/h' : 'N/A'} · Cap : {show(last.bearing, '°')}
            </Text>
            <Text>
              Précision : {show(last.accuracy, ' m')} · Source : {last.provider} · Heure :{' '}
              {new Date(last.timestamp).toLocaleTimeString()}
            </Text>
            <Text>
              {last.networkType} · Cell ID {last.cellId ?? 'N/A'} · PCI {last.pci ?? 'N/A'} · {last.band} · Points : {count}
            </Text>
          </>
        ) : (
          !error && <Text>Recherche de la position... (localisation activée ?)</Text>
        )}
      </View>
      <WebView
        ref={webViewRef}
        source={{ html: LEAFLET_HTML }}
        originWhitelist={['*']}
        onMessage={onMessage}
        style={styles.map}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  panel: { backgroundColor: '#fff', padding: 12, elevation: 2 },
  error: { color: 'red', marginBottom: 4 },
  map: { flex: 1 },
});