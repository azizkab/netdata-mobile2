import { NativeModules } from 'react-native';

export interface DnsResult {
  domain: string;
  server: string;
  avgMs: number;
  failureRate: number;
}

export interface TcpResult {
  host: string;
  port: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  jitterMs: number;
  lossPercent: number;
}

export interface HttpResult {
  url: string;
  dnsMs: number;
  tcpMs: number;
  tlsMs: number;
  responseMs: number;
  totalMs: number;
  statusCode: number;
}

export interface ThroughputResult {
  bytes: number;
  seconds: number;
  mbps: number;
}

interface NetworkTestsInterface {
  dnsTest(domain: string, server: string, attempts: number): Promise<DnsResult>;
  tcpTest(host: string, port: number, attempts: number): Promise<TcpResult>;
  httpTest(url: string): Promise<HttpResult>;
  downloadTest(url: string): Promise<ThroughputResult>;
  uploadTest(url: string, sizeBytes: number): Promise<ThroughputResult>;
}

export default NativeModules.NetworkTests as NetworkTestsInterface;