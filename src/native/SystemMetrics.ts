import { NativeModules } from 'react-native';

export interface MemoryInfo {
  total: number;
  available: number;
  used: number;
  usagePercent: number;
}

export interface StorageInfo {
  total: number;
  free: number;
  used: number;
  usagePercent: number;
}

export interface BatteryInfo {
  level: number;
  isCharging: boolean;
  health: string;
  temperature: number;
  voltage: number;
  currentNow: number;
  chargeTimeRemaining: number;
}

export interface CoreInfo {
  id: number;
  curFreqMHz: number;
  maxFreqMHz: number;
  load: number;
}

export interface CpuInfo {
  cores: number;
  usagePercent: number;
  loadAverage: number;
  perCore: CoreInfo[];
}

export interface ThermalZone {
  type: string;
  temp: number;
}

interface SystemMetricsInterface {
  getMemoryInfo(): Promise<MemoryInfo>;
  getStorageInfo(): Promise<StorageInfo>;
  getBatteryInfo(): Promise<BatteryInfo>;
  getCpuInfo(): Promise<CpuInfo>;
  getThermalInfo(): Promise<ThermalZone[]>;
}

export default NativeModules.SystemMetrics as SystemMetricsInterface;