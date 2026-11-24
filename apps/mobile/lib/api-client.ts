import type { ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('Network request failed');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export type ApiClientConfig = {
  baseUrl: string;
  getToken: () => string | null;
  setToken: (token: string, expiresAt?: string) => void;
  signOut: () => void;
};

export type FetchOptions = {
  method?: string;
  json?: unknown;
  headers?: Record<string, string>;
  /** In __DEV__, validate the response body against this schema. */
  schema?: ZodType;
  /** Skip the Authorization header (for public endpoints). */
  public?: boolean;
};

export type ApiClient = {
  apiFetch: <T = unknown>(path: string, options?: FetchOptions) => Promise<T>;
  refreshToken: () => Promise<boolean>;
};

export function createApiClient(config: ApiClientConfig): ApiClient {
  const { baseUrl, getToken, setToken, signOut } = config;

  let refreshPromise: Promise<boolean> | null = null;

  async function rawFetch(path: string, options: FetchOptions = {}): Promise<Response> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = { ...options.headers };

    if (!options.public) {
      const token = getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }

    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      return await fetch(url, {
        method: options.method ?? (options.json !== undefined ? 'POST' : 'GET'),
        headers,
        body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
      });
    } catch (err) {
      throw new NetworkError(err);
    }
  }

  async function tryRefresh(): Promise<boolean> {
    try {
      const res = await rawFetch('/v1/auth/refresh', { method: 'POST' });
      if (!res.ok) return false;
      const body = (await res.json()) as { token: string; expiresAt: string };
      setToken(body.token, body.expiresAt);
      return true;
    } catch {
      return false;
    }
  }

  async function refreshToken(): Promise<boolean> {
    if (!refreshPromise) {
      refreshPromise = tryRefresh().finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  async function apiFetch<T = unknown>(path: string, options: FetchOptions = {}): Promise<T> {
    let res = await rawFetch(path, options);

    if (res.status === 401 && !options.public) {
      const refreshed = await refreshToken();
      if (refreshed) {
        res = await rawFetch(path, options);
      } else {
        signOut();
        throw new ApiError(401, 'unauthenticated', 'Session expired');
      }
    }

    if (!res.ok) {
      let code = 'unknown';
      let message = `HTTP ${res.status}`;
      let details: unknown;
      try {
        const body = (await res.json()) as {
          error?: { code?: string; message?: string; details?: unknown };
        };
        if (body.error) {
          code = body.error.code ?? code;
          message = body.error.message ?? message;
          details = body.error.details;
        }
      } catch {
        // non-JSON error body — use defaults
      }
      throw new ApiError(res.status, code, message, details);
    }

    if (res.status === 204 || res.status === 202 || res.headers.get('content-length') === '0') {
      return undefined as T;
    }

    const body = await res.json();

    if (__DEV__ && options.schema) {
      options.schema.parse(body);
    }

    return body as T;
  }

  return { apiFetch, refreshToken };
}
