import { NativeModules } from 'react-native';

export interface CellSnapshot {
  tech: string;            // LTE / NR / WCDMA / GSM
  cell_id: number | null;
  pci: number | null;
  tac: number | null;
  arfcn: number | null;
}

// Cellule avec ses mesures (équivalent Measurement Report)
export interface RadioCell extends CellSnapshot {
  registered: boolean;
  mcc?: string | null;
  mnc?: string | null;
  bandwidth_khz?: number | null;
  bands?: number[];
  rsrp?: number | null;
  rsrq?: number | null;
  sinr?: number | null;
  cqi?: number | null;
  timing_advance?: number | null;
  dbm?: number | null;
}

// Enregistrement réseau (équivalent NAS) et état 5G NSA
export interface RegistrationInfo {
  operator: string | null;
  roaming: boolean;
  registration: string | null;   // registered / registered_roaming / searching / denied / not_registered
  access_tech: string | null;
  nr_state: string | null;       // NONE / RESTRICTED / NOT_RESTRICTED / CONNECTED
  reject_cause: number | null;
  duplex: string | null;
  channel: number | null;
  cell_bandwidths_khz: number[];
}

export interface RadioSnapshot {
  timestamp: number;
  technology: string | null;
  serving: RadioCell[];
  neighbors: RadioCell[];
  registration: RegistrationInfo | null;
}

export interface SignalingEvent {
  timestamp: number;
  event: 'cell_change' | 'technology_change' | 'service_state' | 'registration' | 'nr_state';
  change_type?: 'handover' | 'reselection';
  from_cell?: CellSnapshot;
  to_cell?: CellSnapshot;
  from_tech?: string;
  to_tech?: string;
  downgrade?: boolean;
  from_state?: string;
  to_state?: string;
  from_registration?: string;
  to_registration?: string;
  reject_cause?: number | null;
  from_nr_state?: string;
  to_nr_state?: string;
}

interface SignalingMonitorInterface {
  start(): Promise<boolean>;
  stop(): Promise<void>;
  getEvents(): Promise<SignalingEvent[]>;
  getRadioSnapshot(): Promise<RadioSnapshot>;
}

export default NativeModules.SignalingMonitor as SignalingMonitorInterface;