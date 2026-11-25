import type { Civ1Domain } from "../domain.js";
import { PublicDataError, PublicDataFetcher } from "./fetcher.js";
import {
  SourceParseError, eurostatUrl, oecdUrl, parseJsonStat, parseSdmxJson, parseUnSdg, parseWorldBank, unSdgUrl, worldBankUrl,
  type EurostatQuery, type OecdQuery, type ParsedDataset, type PublicObservation, type PublicSourceId, type UnSdgQuery,
  type WorldBankQuery,
} from "./sources.js";

export interface PublicDataRequest {
  missionId: string;
  source: PublicSourceId;
  worldbank?: WorldBankQuery;
  oecd?: OecdQuery;
  eurostat?: EurostatQuery;
  unsdg?: UnSdgQuery;
  url?: string;
  /** How many observations to return to the caller (all are counted and hashed). */
  limit?: number;
}

export interface PublicDataResult {
  missionId: string;
  evidenceId: string;
  trust: "UNVERIFIED";
  dataClass: "source_reported";
  provenance: { url: string; endpoint: string; retrievedAt: string; httpStatus: number; bytes: number; sha256: string };
  dataset: { source: PublicSourceId; id: string; title?: string; sourceName?: string; sourceUpdated?: string; truncated: boolean };
  observationCount: number;
  observations?: PublicObservation[];
  /** Allowlisted JSON only: the body as returned, when no parser applies. */
  json?: unknown;
  returnedTruncated: boolean;
  notes: string[];
}

export function buildRequestUrl(req: PublicDataRequest): { url: string; dataset: string } {
  const need = <T>(v: T | undefined, name: string): T => {
    if (!v) throw new SourceParseError("QUERY_INVALID", `source "${req.source}" needs the "${name}" query`);
    return v;
  };
  switch (req.source) {
    case "worldbank": { const q = need(req.worldbank, "worldbank"); return { url: worldBankUrl(q), dataset: `${q.indicator}/${q.country}` }; }
    case "oecd": { const q = need(req.oecd, "oecd"); return { url: oecdUrl(q), dataset: `${q.agency},${q.dataflow}/${q.key || "all"}` }; }
    case "eurostat": { const q = need(req.eurostat, "eurostat"); return { url: eurostatUrl(q), dataset: q.dataset }; }
    case "unsdg": { const q = need(req.unsdg, "unsdg"); return { url: unSdgUrl(q), dataset: `${q.seriesCode}/${q.areaCodes.join("+")}` }; }
    case "allowlisted_json": { const u = need(req.url, "url"); return { url: u, dataset: new URL(u).pathname.slice(0, 200) }; }
  }
}

function parse(source: PublicSourceId, json: unknown, dataset: string): ParsedDataset | null {
  switch (source) {
    case "worldbank": return parseWorldBank(json, dataset);
    case "oecd": return parseSdmxJson(json, dataset);
    case "eurostat": return parseJsonStat(json, dataset);
    case "unsdg": return parseUnSdg(json, dataset);
    case "allowlisted_json": return null;
  }
}

/** Fetch → parse → record one evidence item. Any failure throws before anything is recorded. */
export async function fetchPublicData(domain: Civ1Domain, fetcher: PublicDataFetcher, req: PublicDataRequest,
  signal?: AbortSignal): Promise<PublicDataResult> {
  if (!domain.getMission(req.missionId)) throw new PublicDataError("MISSION_NOT_FOUND", `mission ${req.missionId} not found`);
  if (domain.getMission(req.missionId)!.status !== "OPEN") throw new PublicDataError("MISSION_CLOSED", `mission ${req.missionId} is closed`);
  const { url, dataset } = buildRequestUrl(req);
  const fetched = await fetcher.getJson(url, signal);
  const parsed = parse(req.source, fetched.json, dataset);
  const limit = Math.min(Math.max(req.limit ?? 200, 0), 1000);
  const obs = parsed?.observations ?? [];
  const periods = [...new Set(obs.map((o) => o.period))].sort();
  const notes = [
    "Trust is UNVERIFIED: the hash pins what the source said at retrievedAt, not whether it is true.",
    "Do not treat these values as Civilisation.One observations or feed them to CivScore without independent verification.",
  ];
  if (obs.some((o) => o.flag)) notes.push("Some observations carry a source flag (estimate, provisional, break, projection…); keep the flag with the value.");
  if (parsed?.truncated) notes.push("The source had more data than was read (paging or the local cap); narrow the query.");
  if (req.source === "allowlisted_json") notes.push("Allowlisted JSON is returned as-is with no parsing; its structure was not checked.");
  const evidence = domain.recordPublicData(req.missionId, {
    source: req.source, sourceLabel: fetched.endpointLabel, dataset, title: parsed?.title, url: fetched.url,
    retrievedAt: fetched.retrievedAt, sha256: fetched.sha256, bytes: fetched.bytes, observationCount: obs.length,
    areaCount: new Set(obs.map((o) => o.area)).size, periods, truncated: parsed?.truncated ?? false,
  });
  return {
    missionId: req.missionId, evidenceId: evidence.id, trust: "UNVERIFIED", dataClass: "source_reported",
    provenance: { url: fetched.url, endpoint: fetched.endpointLabel, retrievedAt: fetched.retrievedAt, httpStatus: fetched.httpStatus, bytes: fetched.bytes, sha256: fetched.sha256 },
    dataset: { source: req.source, id: dataset, title: parsed?.title, sourceName: parsed?.sourceName, sourceUpdated: parsed?.sourceUpdated, truncated: parsed?.truncated ?? false },
    observationCount: obs.length,
    ...(parsed ? { observations: obs.slice(0, limit) } : jsonBody(fetched.json, notes)),
    returnedTruncated: parsed ? obs.length > limit : jsonBody(fetched.json, []).json === undefined, notes,
  };
}

const MAX_INLINE_JSON = 200_000;
function jsonBody(json: unknown, notes: string[]): { json?: unknown } {
  if (JSON.stringify(json).length <= MAX_INLINE_JSON) return { json };
  notes.push(`The body is over ${MAX_INLINE_JSON} characters, so only its hash and size are returned.`);
  return {};
}
