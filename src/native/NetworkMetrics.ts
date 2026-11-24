import { NativeModules } from 'react-native';

export interface ConnectionInfo {
  transport: string;
  ipAddress: string;
  downstreamKbps: number;
  upstreamKbps: number;
  rxBytes: number;
  txBytes: number;
}

export interface WifiInfo {
  ssid: string;
  bssid: string;
  rssi: number;
  signalLevel: number;
  frequency: number;
  band: string;
  linkSpeedMbps: number;
}

export interface MobileInfo {
  networkType: string;
  operator: string;
  signalLevel: number;
  signalDbm: number | null;
  cellId: number | null;
  pci: number | null;
  tac: number | null;
  band: string;
}

interface NetworkMetricsInterface {
  getConnectionInfo(): Promise<ConnectionInfo>;
  getWifiInfo(): Promise<WifiInfo | null>;
  getMobileInfo(): Promise<MobileInfo>;
}

export default NativeModules.NetworkMetrics as NetworkMetricsInterface;