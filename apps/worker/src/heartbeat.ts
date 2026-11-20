export interface HeartbeatService {
  ping(): Promise<void>;
}

export function createHealthchecksHeartbeat(url: string): HeartbeatService {
  return {
    async ping() {
      try {
        await fetch(url);
      } catch {
        // Fire-and-forget: a ping failure must not break the tick loop.
      }
    },
  };
}

export function createNoopHeartbeat(): HeartbeatService {
  return { ping: async () => {} };
}
