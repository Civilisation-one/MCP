/**
 * Read-only fetcher for public data APIs.
 *
 * Boundary rules (all fail closed):
 * - Off unless the host enables it (CIV1_PUBLIC_DATA_ENABLED=1 or the `enabled` option).
 * - HTTPS on port 443 only; no userinfo, no IP literals, no localhost.
 * - Exact host match against an allowlist, plus a path prefix per host. No subdomain wildcards.
 * - GET only, no cookies or credentials, only Accept and User-Agent headers are sent.
 * - Redirects are not followed: a 3xx is an error, so a listed host cannot bounce the request elsewhere.
 * - Response size and time are capped; the body must be JSON.
 * - A per-host hourly budget (OECD allows 60 downloads an hour, so its default is lower).
 * - URLs that look like they carry a secret are refused, so a caller cannot smuggle one out in a query.
 *
 * The fetcher proves only that these bytes came from that URL at that time. It says nothing about
 * whether the data are true.
 */
import { createHash } from "node:crypto";

export type BodyFormat = "json" | "csv";

export interface AllowedEndpoint {
  host: string;
  /** Path must start with this (case-insensitive). */
  pathPrefix: string;
  /** Requests per rolling hour. */
  hourlyLimit: number;
  label: string;
  /** Response formats accepted from this endpoint. Default: JSON only. */
  formats?: BodyFormat[];
}

export const DEFAULT_ENDPOINTS: readonly AllowedEndpoint[] = Object.freeze([
  { host: "api.worldbank.org", pathPrefix: "/v2/", hourlyLimit: 120, label: "World Bank Indicators API" },
  { host: "sdmx.oecd.org", pathPrefix: "/public/rest/data/", hourlyLimit: 50, label: "OECD Data Explorer (SDMX)" },
  { host: "ec.europa.eu", pathPrefix: "/eurostat/api/dissemination/statistics/1.0/data/", hourlyLimit: 120, label: "Eurostat Statistics API (JSON-stat)" },
  { host: "unstats.un.org", pathPrefix: "/sdgapi/v1/sdg/", hourlyLimit: 120, label: "UN SDG API" },
  // Scientific archives. Metadata and tables only; bulk files (FITS, ROOT) are recorded by reference, never fetched.
  { host: "opendata.cern.ch", pathPrefix: "/api/records", hourlyLimit: 120, label: "CERN Open Data portal" },
  { host: "www.hepdata.net", pathPrefix: "/record/", hourlyLimit: 120, label: "HEPData" },
  { host: "inspirehep.net", pathPrefix: "/api/literature", hourlyLimit: 300, label: "INSPIRE-HEP" },
  { host: "zenodo.org", pathPrefix: "/api/records", hourlyLimit: 100, label: "Zenodo" },
  { host: "datalab.noirlab.edu", pathPrefix: "/tap/sync", hourlyLimit: 120, label: "NOIRLab Astro Data Lab TAP (DESI)", formats: ["csv"] },
  { host: "irsa.ipac.caltech.edu", pathPrefix: "/tap/sync", hourlyLimit: 120, label: "NASA/IPAC IRSA TAP (Planck catalogues)", formats: ["csv"] },
  { host: "gea.esac.esa.int", pathPrefix: "/tap-server/tap/sync", hourlyLimit: 120, label: "ESA Gaia Archive TAP", formats: ["csv"] },
]);

export interface FetchedBody {
  url: string;
  host: string;
  endpointLabel: string;
  retrievedAt: string;
  httpStatus: number;
  contentType: string;
  bytes: number;
  sha256: string;
  format: BodyFormat;
  /** Parsed JSON when format is json; the decoded text when format is csv. */
  json: unknown;
  text?: string;
}
export type FetchedJson = FetchedBody;

export class PublicDataError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "PublicDataError"; }
}

export interface PublicDataFetcherOptions {
  enabled?: boolean;
  /** Extra operator-configured endpoints (the generic allowlist). */
  extraEndpoints?: AllowedEndpoint[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => number;
}

const SECRET_LIKE = /(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{15,}|[?&](api[_-]?key|key|token|access_token|secret|password|auth)=)/i;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Parses CIV1_PUBLIC_DATA_ALLOWLIST: comma-separated `host/path/prefix/` entries, e.g.
 *  `data.example.org/api/v1/`. Entries that are not plain public hostnames are rejected. */
export function parseAllowlist(value: string | undefined, hourlyLimit = 60): AllowedEndpoint[] {
  if (!value?.trim()) return [];
  return value.split(",").map((raw) => raw.trim()).filter(Boolean).map((entry) => {
    const slash = entry.indexOf("/");
    const host = (slash === -1 ? entry : entry.slice(0, slash)).toLowerCase();
    const pathPrefix = slash === -1 ? "/" : entry.slice(slash);
    assertPublicHostname(host);
    if (!pathPrefix.startsWith("/") || pathPrefix.includes("..")) {
      throw new PublicDataError("ALLOWLIST_INVALID", `allowlist entry ${JSON.stringify(entry)} has an invalid path`);
    }
    return { host, pathPrefix, hourlyLimit, label: `Allowlisted JSON (${host})` };
  });
}

export function assertPublicHostname(host: string): void {
  if (!HOSTNAME.test(host) || /^\d+(\.\d+){3}$/.test(host) || host === "localhost" || host.endsWith(".localhost")
      || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new PublicDataError("ALLOWLIST_INVALID", `${JSON.stringify(host)} is not a public hostname`);
  }
}

export class PublicDataFetcher {
  readonly enabled: boolean;
  readonly endpoints: readonly AllowedEndpoint[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly calls = new Map<string, number[]>();

  constructor(options: PublicDataFetcherOptions = {}) {
    this.enabled = options.enabled ?? process.env.CIV1_PUBLIC_DATA_ENABLED === "1";
    const extra = options.extraEndpoints ?? parseAllowlist(process.env.CIV1_PUBLIC_DATA_ALLOWLIST);
    this.endpoints = Object.freeze([...DEFAULT_ENDPOINTS, ...extra]);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.now = options.now ?? Date.now;
  }

  /** Returns the endpoint that permits this URL, or throws. Exposed for tests and for the status tool. */
  check(rawUrl: string): { url: URL; endpoint: AllowedEndpoint } {
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new PublicDataError("URL_INVALID", "not a valid URL"); }
    if (url.protocol !== "https:") throw new PublicDataError("HTTPS_REQUIRED", "only https URLs are allowed");
    if (url.username || url.password) throw new PublicDataError("URL_INVALID", "URLs with credentials are refused");
    if (url.port && url.port !== "443") throw new PublicDataError("URL_INVALID", "only port 443 is allowed");
    if (url.hash) url.hash = "";
    if (rawUrl.length > 2000) throw new PublicDataError("URL_INVALID", "URL is too long");
    if (SECRET_LIKE.test(decodeURIComponentSafe(url.href))) {
      throw new PublicDataError("URL_LOOKS_SECRET", "URL looks like it carries a credential; refused");
    }
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const endpoint = this.endpoints.find((e) => e.host === host && path.startsWith(e.pathPrefix.toLowerCase()));
    if (!endpoint) throw new PublicDataError("HOST_NOT_ALLOWED", `${host}${url.pathname} is not on the public data allowlist`);
    return { url, endpoint };
  }

  async getJson(rawUrl: string, signal?: AbortSignal): Promise<FetchedBody> {
    return this.get(rawUrl, "json", signal);
  }

  async get(rawUrl: string, expect: BodyFormat, signal?: AbortSignal): Promise<FetchedBody> {
    if (!this.enabled) throw new PublicDataError("PUBLIC_DATA_DISABLED", "public data access is off; the host sets CIV1_PUBLIC_DATA_ENABLED=1 to enable it");
    const { url, endpoint } = this.check(rawUrl);
    if (!(endpoint.formats ?? ["json"]).includes(expect)) {
      throw new PublicDataError("FORMAT_NOT_ALLOWED", `${endpoint.label} is allowed for ${(endpoint.formats ?? ["json"]).join("/")} only`);
    }
    this.consumeBudget(endpoint);

    const ctrl = new AbortController();
    const onOuter = () => ctrl.abort();
    signal?.addEventListener("abort", onOuter, { once: true });
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const retrievedAt = new Date(this.now()).toISOString();
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url.href, {
          method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", signal: ctrl.signal,
          headers: { Accept: expect === "csv" ? "text/csv, application/csv;q=0.9, text/plain;q=0.5" : "application/json", "User-Agent": "civilisation-one-mcp/0.1 (public-data; read-only)" },
        });
      } catch (e) {
        if (ctrl.signal.aborted) throw new PublicDataError("TIMEOUT", `${endpoint.label} did not answer within ${this.timeoutMs} ms`);
        throw new PublicDataError("NETWORK_ERROR", `could not reach ${endpoint.label}: ${(e as Error).message}`);
      }
      if (res.status >= 300 && res.status < 400) {
        throw new PublicDataError("REDIRECT_REFUSED", `${endpoint.label} answered with a redirect (HTTP ${res.status}); redirects are not followed`);
      }
      if (res.status === 429) throw new PublicDataError("UPSTREAM_RATE_LIMITED", `${endpoint.label} is rate limiting (HTTP 429)`);
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > this.maxBytes) throw new PublicDataError("RESPONSE_TOO_LARGE", `response is ${declared} bytes; the limit is ${this.maxBytes}`);
      const body = await readCapped(res, this.maxBytes);
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
      // TAP services report query errors as a VOTable with QUERY_STATUS=ERROR, often with HTTP 400.
      const tapError = /xml/.test(contentType) ? votableError(text) : undefined;
      if (tapError) throw new PublicDataError("SOURCE_QUERY_ERROR", `${endpoint.label}: ${tapError}`);
      if (!res.ok) throw new PublicDataError("UPSTREAM_HTTP_ERROR", `${endpoint.label} returned HTTP ${res.status}`);
      const base = {
        url: url.href, host: url.hostname, endpointLabel: endpoint.label, retrievedAt, httpStatus: res.status, contentType,
        bytes: body.byteLength, sha256: createHash("sha256").update(body).digest("hex"),
      };
      if (expect === "csv") {
        if (!/(csv|text\/plain)/.test(contentType)) throw new PublicDataError("NOT_CSV", `expected CSV, got ${contentType || "no content type"}`);
        return { ...base, format: "csv", json: null, text };
      }
      if (!/json/.test(contentType)) throw new PublicDataError("NOT_JSON", `expected JSON, got ${contentType || "no content type"}`);
      let json: unknown;
      try { json = JSON.parse(text); }
      catch { throw new PublicDataError("NOT_JSON", "response body is not valid JSON"); }
      return { ...base, format: "json", json };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuter);
    }
  }

  private consumeBudget(endpoint: AllowedEndpoint): void {
    const key = `${endpoint.host}${endpoint.pathPrefix}`;
    const now = this.now();
    const recent = (this.calls.get(key) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= endpoint.hourlyLimit) {
      throw new PublicDataError("LOCAL_RATE_LIMIT", `${endpoint.label}: ${endpoint.hourlyLimit} requests in the last hour; try later`);
    }
    recent.push(now);
    this.calls.set(key, recent);
  }
}

function votableError(xml: string): string | undefined {
  const m = /<INFO[^>]*name\s*=\s*"QUERY_STATUS"[^>]*value\s*=\s*"ERROR"[^>]*>([\s\S]*?)<\/INFO>/i.exec(xml)
    ?? /<INFO[^>]*value\s*=\s*"ERROR"[^>]*name\s*=\s*"QUERY_STATUS"[^>]*>([\s\S]*?)<\/INFO>/i.exec(xml);
  return m ? m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 300) || "query failed" : undefined;
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PublicDataError("RESPONSE_TOO_LARGE", `response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}
