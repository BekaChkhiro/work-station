import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Pick the right fetch implementation for the current runtime.
 *
 * The browser webview enforces CORS on cross-origin requests. Most of the
 * services we integrate with (PlanFlow, GitHub, etc.) don't echo the Tauri
 * origin in `Access-Control-Allow-Origin`, so a plain `fetch()` from the
 * renderer fails with a `TypeError` and we report "Couldn't reach …".
 *
 * `@tauri-apps/plugin-http` proxies the request through the Rust backend,
 * which doesn't observe CORS, and returns a `Response` shaped exactly like
 * the browser one. We default to that in the packaged app and fall back to
 * the platform `fetch` when running in a plain browser (vitest, vite preview)
 * so unit tests can still inject their own mocks. */
function defaultFetchImpl(): typeof fetch {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return tauriFetch as unknown as typeof fetch;
  }
  return fetch;
}

export type ResponseType = "json" | "text" | "arrayBuffer" | "void";

export interface CacheEntry {
  expiresAt: number;
  /** T11.9 — wall-clock time the entry was written. Used to render
   *  "(cached, X min ago)" annotations when reads fall back to stale
   *  cache because the network is unreachable. Distinct from
   *  `expiresAt` so the UI can distinguish "30s old, fresh" from
   *  "2h old, stale". */
  cachedAt: number;
  status: number;
  headers: Record<string, string>;
  body: string;
  responseType: Exclude<ResponseType, "arrayBuffer" | "void">;
}

export interface IntegrationCacheStore {
  get(key: string): CacheEntry | Promise<CacheEntry | null> | null;
  set(key: string, entry: CacheEntry): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

export interface RetryOptions {
  attempts?: number;
  backoffMs?: number;
}

export interface IntegrationRequestOptions<T> {
  method?: HttpMethod;
  headers?: HeadersInit;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: BodyInit;
  json?: unknown;
  cacheTtlMs?: number;
  cacheKey?: string;
  timeoutMs?: number;
  retry?: RetryOptions;
  responseType?: ResponseType;
  parse?: (value: unknown) => T;
  /** T11.9 — non-GET requests are queued for replay on reconnect when
   *  offline. Defaults to `true` for non-GET; ignored for GET. Pass
   *  `false` for one-shot operations that shouldn't survive a restart
   *  (e.g. interactive Verify, telemetry). */
  offlineQueueable?: boolean;
}

/** T11.9 — discriminated result returned by [`requestWithMeta`] so the
 *  caller can distinguish a fresh network response, a fresh-cache hit, a
 *  stale-cache fallback (used when the network is unreachable), and a
 *  write that was queued for replay. The existing [`request`] method
 *  keeps returning `T` directly for backward compatibility. */
export type IntegrationFetchSource = "network" | "cache-fresh" | "cache-stale" | "queued";

export type IntegrationFetchResult<T> =
  | { source: "network"; value: T }
  | { source: "cache-fresh"; value: T; cachedAt: number }
  | { source: "cache-stale"; value: T; cachedAt: number }
  | { source: "queued"; value: null; queuedId: number; evicted: boolean };

/** T11.9 — pluggable hooks the offline subsystem injects. The HTTP
 *  client itself never imports `offline.ts` or `writeQueue.ts`; the
 *  wiring happens in `createOfflineAwareClient.ts` so callers that
 *  don't need offline behavior (verifiers, the bare PlanFlow client)
 *  pay nothing for it. */
export interface OfflineHooks {
  /** Returns `false` when the app considers itself offline for this
   *  service — either `navigator.onLine === false` or the per-service
   *  consecutive-error counter has tripped. */
  isOnline(): boolean;
  /** Called when a request raises `IntegrationNetworkError` /
   *  `IntegrationTimeoutError`. Feeds the per-service offline detector. */
  reportError(error: unknown): void;
  /** Called on a successful response. Resets the per-service consecutive
   *  error counter. */
  reportSuccess(): void;
  /** Persists a non-GET request to the offline write queue. Returns the
   *  new queue id and whether the cap eviction kicked in. */
  enqueueWrite(write: {
    service: string;
    method: Exclude<HttpMethod, "GET">;
    url: string;
    headers: Record<string, string>;
    body: Uint8Array | null;
  }): Promise<{ id: number; evicted: boolean }>;
}

export interface IntegrationHttpClientOptions {
  service: string;
  baseUrl?: string;
  defaultHeaders?: HeadersInit;
  defaultTimeoutMs?: number;
  defaultRetry?: RetryOptions;
  getAuthToken?: () => string | null | Promise<string | null>;
  fetchImpl?: typeof fetch;
  cacheStore?: IntegrationCacheStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** T11.8 — invoked when a request resolves with a 401/403. Lets the
   *  owning integration mark itself as `needs_reauth` and surface the
   *  Reconnect banner. The hook fires before the error propagates to
   *  the caller — async work is awaited so the consumer can persist
   *  state synchronously with the failure. Verify clients pass nothing
   *  here so a bad token never flips an integration into reauth mode. */
  onAuthFailure?: (info: { status: number }) => void | Promise<void>;
  /** T11.9 — opt-in offline behavior. When provided, GET reads fall
   *  back to stale cache on network failure and non-GET requests are
   *  queued for replay on reconnect. Wiring lives in
   *  `createOfflineAwareClient.ts`. */
  offline?: OfflineHooks;
}

export interface RateLimitDetails {
  retryAfterMs: number | null;
  limit: string | null;
  remaining: string | null;
  resetAt: Date | null;
}

export class IntegrationNetworkError extends Error {
  readonly causeValue: unknown;

  constructor(message: string, causeValue: unknown) {
    super(message);
    this.name = "IntegrationNetworkError";
    this.causeValue = causeValue;
  }
}

export class IntegrationTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "IntegrationTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class IntegrationHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;
  readonly headers: Record<string, string>;

  constructor(response: Response, body: string, message?: string) {
    super(message ?? `HTTP ${response.status} ${response.statusText}`);
    this.name = "IntegrationHttpError";
    this.status = response.status;
    this.statusText = response.statusText;
    this.body = body;
    this.headers = headersToRecord(response.headers);
  }
}

export class IntegrationRateLimitError extends IntegrationHttpError {
  readonly rateLimit: RateLimitDetails;

  constructor(response: Response, body: string) {
    super(response, body, "Rate limit exceeded");
    this.name = "IntegrationRateLimitError";
    this.rateLimit = rateLimitDetails(response.headers);
  }
}

export class MemoryCacheStore implements IntegrationCacheStore {
  readonly #entries = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | null {
    return this.#entries.get(key) ?? null;
  }

  set(key: string, entry: CacheEntry): void {
    this.#entries.set(key, entry);
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }
}

export class LocalStorageCacheStore implements IntegrationCacheStore {
  readonly #prefix: string;

  constructor(prefix = "work-station.integration-cache") {
    this.#prefix = prefix;
  }

  get(key: string): CacheEntry | null {
    const storage = localStorageOrNull();
    if (storage == null) return null;
    const raw = storage.getItem(this.#storageKey(key));
    if (raw == null) return null;
    try {
      return parseCacheEntry(JSON.parse(raw));
    } catch {
      storage.removeItem(this.#storageKey(key));
      return null;
    }
  }

  set(key: string, entry: CacheEntry): void {
    const storage = localStorageOrNull();
    if (storage == null) return;
    storage.setItem(this.#storageKey(key), JSON.stringify(entry));
  }

  delete(key: string): void {
    localStorageOrNull()?.removeItem(this.#storageKey(key));
  }

  #storageKey(key: string): string {
    return `${this.#prefix}.${key}`;
  }
}

export class LayeredCacheStore implements IntegrationCacheStore {
  readonly #primary: IntegrationCacheStore;
  readonly #secondary: IntegrationCacheStore;

  constructor(primary: IntegrationCacheStore, secondary: IntegrationCacheStore) {
    this.#primary = primary;
    this.#secondary = secondary;
  }

  async get(key: string): Promise<CacheEntry | null> {
    const primaryEntry = await this.#primary.get(key);
    if (primaryEntry != null) return primaryEntry;
    const secondaryEntry = await this.#secondary.get(key);
    if (secondaryEntry != null) await this.#primary.set(key, secondaryEntry);
    return secondaryEntry;
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    await Promise.all([this.#primary.set(key, entry), this.#secondary.set(key, entry)]);
  }

  async delete(key: string): Promise<void> {
    await Promise.all([this.#primary.delete(key), this.#secondary.delete(key)]);
  }
}

export class IntegrationHttpClient {
  readonly #service: string;
  readonly #baseUrl: string;
  readonly #defaultHeaders: HeadersInit;
  readonly #defaultTimeoutMs: number;
  readonly #defaultRetry: Required<RetryOptions>;
  readonly #getAuthToken?: () => string | null | Promise<string | null>;
  readonly #fetchImpl: typeof fetch;
  readonly #cacheStore: IntegrationCacheStore;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onAuthFailure?: (info: { status: number }) => void | Promise<void>;
  readonly #offline?: OfflineHooks;

  constructor(options: IntegrationHttpClientOptions) {
    this.#service = options.service;
    this.#baseUrl = options.baseUrl ?? "";
    this.#defaultHeaders = options.defaultHeaders ?? {};
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    this.#defaultRetry = normalizeRetry(options.defaultRetry);
    this.#getAuthToken = options.getAuthToken;
    this.#fetchImpl = options.fetchImpl ?? defaultFetchImpl();
    this.#cacheStore =
      options.cacheStore ??
      new LayeredCacheStore(new MemoryCacheStore(), new LocalStorageCacheStore());
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#onAuthFailure = options.onAuthFailure;
    this.#offline = options.offline;
  }

  async request<T = unknown>(path: string, options: IntegrationRequestOptions<T> = {}): Promise<T> {
    const method =
      options.method ?? (options.json == null && options.body == null ? "GET" : "POST");
    const responseType = options.responseType ?? "json";
    const url = buildUrl(this.#baseUrl, path, options.query);
    const cacheKey = this.#cacheKey(method, url, options.cacheKey);
    const canCache =
      method === "GET" && options.cacheTtlMs != null && responseType !== "arrayBuffer";

    if (canCache) {
      const cached = await this.#readCached<T>(cacheKey, responseType, options.parse);
      if (cached.hit) return cached.value;
    }

    const retry = normalizeRetry(options.retry ?? this.#defaultRetry);
    const headers = await this.#headers(options.headers, options.json != null);
    const init: RequestInit = {
      method,
      headers,
      body: options.json == null ? options.body : JSON.stringify(options.json),
    };
    const response = await this.#fetchWithRetry(url, init, options.timeoutMs, retry);
    const value = await parseResponse(response, responseType, options.parse);

    if (canCache) {
      await this.#writeCached(cacheKey, response, responseType, value, options.cacheTtlMs);
    }

    return value;
  }

  async get<T = unknown>(
    path: string,
    options: Omit<IntegrationRequestOptions<T>, "method" | "body" | "json"> = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: "GET" });
  }

  async post<T = unknown>(
    path: string,
    options: Omit<IntegrationRequestOptions<T>, "method"> = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: "POST" });
  }

  /** T11.9 — variant of [`request`] that returns a discriminated
   *  `IntegrationFetchResult<T>` instead of throwing on the offline /
   *  stale-cache branches. Behaviour:
   *
   *    GET, online:  network → cache write (when ttl set) → "network"
   *                  (or "cache-fresh" if a fresh entry was already there)
   *    GET, offline / network failed: peek cache ignoring TTL →
   *                  "cache-stale" if hit, else throw the network error
   *    Non-GET, offline + offlineQueueable !== false: enqueue → "queued"
   *    Non-GET, online: network → "network" (auth failures still throw)
   *
   *  Existing callers using `request<T>()` are unaffected — that method
   *  keeps its old throw-on-network-failure semantics. */
  async requestWithMeta<T = unknown>(
    path: string,
    options: IntegrationRequestOptions<T> = {},
  ): Promise<IntegrationFetchResult<T>> {
    const method =
      options.method ?? (options.json == null && options.body == null ? "GET" : "POST");
    const responseType = options.responseType ?? "json";
    const url = buildUrl(this.#baseUrl, path, options.query);
    const cacheKey = this.#cacheKey(method, url, options.cacheKey);
    const canCache =
      method === "GET" && options.cacheTtlMs != null && responseType !== "arrayBuffer";

    if (canCache) {
      const fresh = await this.#readCached<T>(cacheKey, responseType, options.parse);
      if (fresh.hit) {
        return { source: "cache-fresh", value: fresh.value, cachedAt: fresh.cachedAt };
      }
    }

    // Non-GET fast-path: when the offline detector says we're offline
    // and the caller hasn't opted out, enqueue without touching the
    // network. We pre-check rather than try-then-enqueue so the user
    // isn't blocked on a TCP timeout when wifi is plainly off.
    if (method !== "GET" && this.#offline != null && !this.#offline.isOnline()) {
      const queueable = options.offlineQueueable !== false;
      if (queueable) {
        const queued = await this.#enqueueOffline(method, url, options);
        return { source: "queued", value: null, queuedId: queued.id, evicted: queued.evicted };
      }
    }

    const retry = normalizeRetry(options.retry ?? this.#defaultRetry);
    const headers = await this.#headers(options.headers, options.json != null);
    const init: RequestInit = {
      method,
      headers,
      body: options.json == null ? options.body : JSON.stringify(options.json),
    };

    try {
      const response = await this.#fetchWithRetry(url, init, options.timeoutMs, retry);
      const value = await parseResponse(response, responseType, options.parse);
      this.#offline?.reportSuccess();
      if (canCache) {
        await this.#writeCached(cacheKey, response, responseType, value, options.cacheTtlMs);
      }
      return { source: "network", value };
    } catch (error) {
      const isTransport =
        error instanceof IntegrationNetworkError || error instanceof IntegrationTimeoutError;
      if (isTransport) {
        this.#offline?.reportError(error);
        // GET stale-fallback: any cache entry, regardless of TTL.
        if (method === "GET") {
          const stale = await this.#readStale<T>(cacheKey, responseType, options.parse);
          if (stale.hit) {
            return { source: "cache-stale", value: stale.value, cachedAt: stale.cachedAt };
          }
        }
        // Non-GET + offline-aware + queueable: enqueue the failed write
        // so a network-flake during the request still survives reconnect.
        if (method !== "GET" && this.#offline != null && options.offlineQueueable !== false) {
          const queued = await this.#enqueueOffline(method, url, options);
          return { source: "queued", value: null, queuedId: queued.id, evicted: queued.evicted };
        }
      }
      throw error;
    }
  }

  async #headers(extraHeaders: HeadersInit | undefined, hasJsonBody: boolean): Promise<Headers> {
    const headers = new Headers(this.#defaultHeaders);
    mergeHeaders(headers, extraHeaders);
    if (hasJsonBody && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const token = await this.#getAuthToken?.();
    if (token != null && token.length > 0 && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    return headers;
  }

  async #fetchWithRetry(
    url: string,
    init: RequestInit,
    timeoutMs: number | undefined,
    retry: Required<RetryOptions>,
  ): Promise<Response> {
    let attempt = 0;
    let lastNetworkError: unknown = null;
    const maxAttempts = retry.attempts + 1;

    while (attempt < maxAttempts) {
      try {
        const response = await this.#fetchWithTimeout(
          url,
          init,
          timeoutMs ?? this.#defaultTimeoutMs,
        );
        if (response.status === 429) {
          throw new IntegrationRateLimitError(response, await response.text());
        }
        if (!response.ok && !isRetryableStatus(response.status)) {
          const body = await response.text();
          await this.#notifyAuthFailure(response.status);
          throw new IntegrationHttpError(response, body);
        }
        if (response.ok || attempt === maxAttempts - 1) {
          if (!response.ok) {
            const body = await response.text();
            await this.#notifyAuthFailure(response.status);
            throw new IntegrationHttpError(response, body);
          }
          return response;
        }
      } catch (error) {
        if (error instanceof IntegrationHttpError) throw error;
        if (error instanceof IntegrationTimeoutError) throw error;
        if (attempt === maxAttempts - 1) {
          throw new IntegrationNetworkError("Network request failed", error);
        }
        lastNetworkError = error;
      }

      attempt += 1;
      await this.#sleep(retry.backoffMs * attempt);
    }

    throw new IntegrationNetworkError("Network request failed", lastNetworkError);
  }

  async #notifyAuthFailure(status: number): Promise<void> {
    if (status !== 401 && status !== 403) return;
    if (this.#onAuthFailure == null) return;
    try {
      await this.#onAuthFailure({ status });
    } catch {
      // A failing reauth hook must not mask the original HTTP error
      // (and must not be retried by the request loop). Swallow.
    }
  }

  async #fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.#fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (isAbortError(error)) throw new IntegrationTimeoutError(timeoutMs);
      throw error;
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  async #readCached<T>(
    key: string,
    responseType: ResponseType,
    parse: ((value: unknown) => T) | undefined,
  ): Promise<{ hit: true; value: T; cachedAt: number } | { hit: false }> {
    const entry = await this.#cacheStore.get(key);
    if (entry == null) return { hit: false };
    if (entry.expiresAt <= this.#now()) {
      await this.#cacheStore.delete(key);
      return { hit: false };
    }
    if (responseType !== entry.responseType) return { hit: false };
    const value = parseCachedBody(entry, parse);
    return { hit: true, value, cachedAt: entry.cachedAt };
  }

  /** T11.9 — read a cache entry **without** the TTL check. Used by
   *  `requestWithMeta` to fall back to stale data when the network is
   *  unreachable. The entry is intentionally NOT deleted — a later
   *  online retry should still see it as stale (vs. cold) so subsequent
   *  offline windows don't lose the same data twice. */
  async #readStale<T>(
    key: string,
    responseType: ResponseType,
    parse: ((value: unknown) => T) | undefined,
  ): Promise<{ hit: true; value: T; cachedAt: number } | { hit: false }> {
    const entry = await this.#cacheStore.get(key);
    if (entry == null) return { hit: false };
    if (responseType !== entry.responseType) return { hit: false };
    const value = parseCachedBody(entry, parse);
    return { hit: true, value, cachedAt: entry.cachedAt };
  }

  async #enqueueOffline<T>(
    method: Exclude<HttpMethod, "GET">,
    url: string,
    options: IntegrationRequestOptions<T>,
  ): Promise<{ id: number; evicted: boolean }> {
    if (this.#offline == null) {
      throw new Error("offline hooks not configured");
    }
    // Re-render headers WITHOUT auth — replay re-resolves the token via
    // the per-service auth provider so a token rotation between enqueue
    // and replay doesn't replay a stale Authorization header.
    const fullHeaders = await this.#headers(options.headers, options.json != null);
    const headersOut: Record<string, string> = {};
    fullHeaders.forEach((value, key) => {
      if (key.toLowerCase() === "authorization") return;
      headersOut[key] = value;
    });
    const body = serializeBodyForQueue(options);
    return this.#offline.enqueueWrite({
      service: this.#service,
      method,
      url,
      headers: headersOut,
      body,
    });
  }

  async #writeCached<T>(
    key: string,
    response: Response,
    responseType: ResponseType,
    value: T,
    ttlMs: number | undefined,
  ): Promise<void> {
    if (ttlMs == null || ttlMs <= 0) return;
    if (responseType !== "json" && responseType !== "text") return;
    const body = responseType === "json" ? JSON.stringify(value) : String(value);
    const now = this.#now();
    await this.#cacheStore.set(key, {
      expiresAt: now + ttlMs,
      cachedAt: now,
      status: response.status,
      headers: headersToRecord(response.headers),
      body,
      responseType,
    });
  }

  #cacheKey(method: HttpMethod, url: string, override: string | undefined): string {
    return override ?? `${this.#service}:${method}:${url}`;
  }
}

export function createIntegrationHttpClient(
  options: IntegrationHttpClientOptions,
): IntegrationHttpClient {
  return new IntegrationHttpClient(options);
}

function normalizeRetry(options: RetryOptions | undefined): Required<RetryOptions> {
  return {
    attempts: options?.attempts ?? 3,
    backoffMs: options?.backoffMs ?? 250,
  };
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: IntegrationRequestOptions<unknown>["query"],
): string {
  const url = new URL(path, baseUrl.length > 0 ? baseUrl : window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  return baseUrl.length > 0 ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

function mergeHeaders(target: Headers, source: HeadersInit | undefined): void {
  if (source == null) return;
  new Headers(source).forEach((value, key) => target.set(key, value));
}

async function parseResponse<T>(
  response: Response,
  responseType: ResponseType,
  parse: ((value: unknown) => T) | undefined,
): Promise<T> {
  switch (responseType) {
    case "json": {
      const value = (await response.json()) as unknown;
      return parse == null ? (value as T) : parse(value);
    }
    case "text":
      return (await response.text()) as T;
    case "arrayBuffer":
      return (await response.arrayBuffer()) as T;
    case "void":
      return undefined as T;
  }
}

function parseCachedBody<T>(entry: CacheEntry, parse: ((value: unknown) => T) | undefined): T {
  if (entry.responseType === "text") return entry.body as T;
  const value = JSON.parse(entry.body) as unknown;
  return parse == null ? (value as T) : parse(value);
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function rateLimitDetails(headers: Headers): RateLimitDetails {
  return {
    retryAfterMs: parseRetryAfter(headers.get("retry-after")),
    limit: headers.get("x-ratelimit-limit"),
    remaining: headers.get("x-ratelimit-remaining"),
    resetAt: parseResetAt(headers.get("x-ratelimit-reset")),
  };
}

function parseRetryAfter(value: string | null): number | null {
  if (value == null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - Date.now());
}

function parseResetAt(value: string | null): Date | null {
  if (value == null) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1_000);
}

function parseCacheEntry(value: unknown): CacheEntry | null {
  if (typeof value !== "object" || value == null) return null;
  const entry = value as Partial<CacheEntry>;
  if (typeof entry.expiresAt !== "number") return null;
  if (typeof entry.status !== "number") return null;
  if (typeof entry.body !== "string") return null;
  if (entry.responseType !== "json" && entry.responseType !== "text") return null;
  if (typeof entry.headers !== "object" || entry.headers == null) return null;
  // T11.9 — `cachedAt` was added in this task. Pre-T11.9 entries lack
  // the field; default to "now" so stale-fallback shows a benign
  // "cached, just now" rather than "cached, decades ago" until the
  // entry refreshes.
  const cachedAt = typeof entry.cachedAt === "number" ? entry.cachedAt : Date.now();
  return {
    expiresAt: entry.expiresAt,
    cachedAt,
    status: entry.status,
    headers: normalizeHeaderRecord(entry.headers),
    body: entry.body,
    responseType: entry.responseType,
  };
}

function serializeBodyForQueue<T>(options: IntegrationRequestOptions<T>): Uint8Array | null {
  if (options.json != null) {
    return new TextEncoder().encode(JSON.stringify(options.json));
  }
  if (options.body == null) return null;
  if (typeof options.body === "string") {
    return new TextEncoder().encode(options.body);
  }
  if (options.body instanceof Uint8Array) {
    return options.body;
  }
  if (options.body instanceof ArrayBuffer) {
    return new Uint8Array(options.body);
  }
  // Blobs/FormData/streams aren't queue-friendly — bail and let the
  // caller decide. We could in theory await Blob.arrayBuffer() but
  // that hides large uploads from the 50-row cap accounting.
  throw new Error(
    "Unsupported body type for offline queue: pass json, string, ArrayBuffer, or Uint8Array.",
  );
}

function normalizeHeaderRecord(value: object): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string") record[key] = headerValue;
  }
  return record;
}

function localStorageOrNull(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
