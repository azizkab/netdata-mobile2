import { NativeModules, DeviceEventEmitter, EmitterSubscription } from 'react-native';

export interface LocationPoint {
  latitude: number;
  longitude: number;
  altitude: number | null;
  speed: number | null;    // m/s
  bearing: number | null;  // degrés
  accuracy: number | null; // m
  timestamp: number;
  provider: string;
}

interface LocationTrackerInterface {
  start(intervalMs: number): Promise<void>;
  stop(): Promise<void>;
}

export const onLocation = (callback: (point: LocationPoint) => void): EmitterSubscription =>
  DeviceEventEmitter.addListener('onLocation', callback);

export default NativeModules.LocationTracker as LocationTrackerInterface;