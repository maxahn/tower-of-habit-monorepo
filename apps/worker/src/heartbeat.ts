export interface HeartbeatService {
  ping(): Promise<void>;
}

export function createHealthchecksHeartbeat(url: string): HeartbeatService {
  void url;
  throw new Error('not implemented');
}

export function createNoopHeartbeat(): HeartbeatService {
  return { ping: async () => {} };
}
