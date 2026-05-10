export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ResponseType = "json" | "text" | "arrayBuffer" | "void";

export interface CacheEntry {
  expiresAt: number;
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

  constructor(options: IntegrationHttpClientOptions) {
    this.#service = options.service;
    this.#baseUrl = options.baseUrl ?? "";
    this.#defaultHeaders = options.defaultHeaders ?? {};
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    this.#defaultRetry = normalizeRetry(options.defaultRetry);
    this.#getAuthToken = options.getAuthToken;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#cacheStore =
      options.cacheStore ??
      new LayeredCacheStore(new MemoryCacheStore(), new LocalStorageCacheStore());
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
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
          throw new IntegrationHttpError(response, await response.text());
        }
        if (response.ok || attempt === maxAttempts - 1) {
          if (!response.ok) throw new IntegrationHttpError(response, await response.text());
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
  ): Promise<{ hit: true; value: T } | { hit: false }> {
    const entry = await this.#cacheStore.get(key);
    if (entry == null) return { hit: false };
    if (entry.expiresAt <= this.#now()) {
      await this.#cacheStore.delete(key);
      return { hit: false };
    }
    if (responseType !== entry.responseType) return { hit: false };
    const value = parseCachedBody(entry, parse);
    return { hit: true, value };
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
    await this.#cacheStore.set(key, {
      expiresAt: this.#now() + ttlMs,
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
  return {
    expiresAt: entry.expiresAt,
    status: entry.status,
    headers: normalizeHeaderRecord(entry.headers),
    body: entry.body,
    responseType: entry.responseType,
  };
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
