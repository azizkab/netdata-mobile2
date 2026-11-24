import { NativeModules } from 'react-native';

export interface DnsEvent {
  timestamp: number;
  domain: string;
  query_type: string;
  dns_time: number;   // ms
  rcode: number;      // 0 = succès, -1 = pas de réponse
  success: boolean;
  resolved_ips: string[];
  app: string | null;
}

export interface AppTraffic {
  uid: number;
  app: string;
  wifi_rx_bytes: number;
  wifi_tx_bytes: number;
  mobile_rx_bytes: number;
  mobile_tx_bytes: number;
}

interface FlowMonitorInterface {
  startVpn(): Promise<boolean>;
  stopVpn(): Promise<void>;
  isVpnRunning(): Promise<boolean>;
  getDnsEvents(): Promise<DnsEvent[]>;
  hasUsageAccess(): Promise<boolean>;
  openUsageAccessSettings(): Promise<void>;
  getAppTraffic(startMs: number, endMs: number): Promise<AppTraffic[]>;
}

export default NativeModules.FlowMonitor as FlowMonitorInterface;