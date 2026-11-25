import type { Civ1Domain } from "../domain.js";
import { PublicDataError, type PublicDataFetcher } from "./fetcher.js";
import { SourceParseError } from "./sources.js";
import {
  TAP_SERVICES, cernUrl, hepdataUrl, inspireUrl, parseCern, parseCsvTable, parseHepData, parseInspire, parseZenodo, tapUrl, zenodoUrl,
  type CernQuery, type HepDataQuery, type InspireQuery, type ScienceParsed, type ScienceSourceId, type TapQuery, type ZenodoQuery,
} from "./science.js";

export interface ScienceDataRequest {
  missionId: string;
  source: ScienceSourceId;
  cern_opendata?: CernQuery;
  hepdata?: HepDataQuery;
  inspire?: InspireQuery;
  zenodo?: ZenodoQuery;
  tap?: TapQuery;
  /** Rows, records or points returned to the caller (all are counted and hashed). */
  limit?: number;
}

export interface ScienceDataResult {
  missionId: string;
  evidenceId: string;
  trust: "UNVERIFIED";
  dataClass: "source_reported";
  provenance: { url: string; endpoint: string; retrievedAt: string; httpStatus: number; bytes: number; sha256: string };
  source: ScienceSourceId;
  dataset: string;
  result: ScienceParsed | { kind: "raw"; reason: string; json?: unknown };
  count: number;
  returnedTruncated: boolean;
  notes: string[];
}

const MAX_INLINE_RAW = 200_000;

function plan(req: ScienceDataRequest): { url: string; dataset: string; format: "json" | "csv" } {
  const need = <T>(v: T | undefined, name: string): T => {
    if (!v) throw new SourceParseError("QUERY_INVALID", `source "${req.source}" needs the "${name}" query`);
    return v;
  };
  switch (req.source) {
    case "cern_opendata": { const q = need(req.cern_opendata, "cern_opendata"); return { url: cernUrl(q), dataset: q.recid !== undefined ? `record/${q.recid}` : `search:${q.search}`, format: "json" }; }
    case "hepdata": { const q = need(req.hepdata, "hepdata"); return { url: hepdataUrl(q), dataset: `ins${q.inspireId}${q.table ? `/${q.table}` : ""}${q.version ? `@v${q.version}` : ""}`, format: "json" }; }
    case "inspire": { const q = need(req.inspire, "inspire"); return { url: inspireUrl(q), dataset: `literature:${q.search}`, format: "json" }; }
    case "zenodo": { const q = need(req.zenodo, "zenodo"); return { url: zenodoUrl(q), dataset: q.recordId !== undefined ? `record/${q.recordId}` : `search:${q.search}`, format: "json" }; }
    case "tap": { const q = need(req.tap, "tap"); return { url: tapUrl(q), dataset: `${q.service}:${q.query.replace(/\s+/g, " ").slice(0, 200)}`, format: "csv" }; }
  }
}

function count(p: ScienceParsed): number {
  return p.kind === "records" ? p.records.length : p.kind === "table" ? p.rows.length : p.kind === "measurements" ? p.measurements.length : 0;
}
function cap(p: ScienceParsed, limit: number): { out: ScienceParsed; cut: boolean } {
  if (p.kind === "records") return { out: { ...p, records: p.records.slice(0, limit) }, cut: p.records.length > limit };
  if (p.kind === "table") return { out: { ...p, rows: p.rows.slice(0, limit) }, cut: p.rows.length > limit };
  if (p.kind === "measurements") return { out: { ...p, measurements: p.measurements.slice(0, limit) }, cut: p.measurements.length > limit };
  return { out: p, cut: false };
}

/** Fetch → parse → record one evidence item. Any failure throws before anything is recorded. */
export async function fetchScienceData(domain: Civ1Domain, fetcher: PublicDataFetcher, req: ScienceDataRequest,
  signal?: AbortSignal): Promise<ScienceDataResult> {
  const mission = domain.getMission(req.missionId);
  if (!mission) throw new PublicDataError("MISSION_NOT_FOUND", `mission ${req.missionId} not found`);
  if (mission.status !== "OPEN") throw new PublicDataError("MISSION_CLOSED", `mission ${req.missionId} is closed`);
  const { url, dataset, format } = plan(req);
  const fetched = await fetcher.get(url, format, signal);
  const maxRows = req.tap?.maxRows ?? 1000;
  let parsed: ScienceParsed;
  switch (req.source) {
    case "tap": parsed = { kind: "table", ...parseCsvTable(fetched.text ?? "", maxRows) }; break;
    case "cern_opendata": parsed = parseCern(fetched.json); break;
    case "hepdata": parsed = parseHepData(fetched.json); break;
    case "inspire": parsed = parseInspire(fetched.json); break;
    case "zenodo": parsed = parseZenodo(fetched.json); break;
  }
  const limit = Math.min(Math.max(req.limit ?? 200, 0), 5000);
  const notes = [
    "Trust is UNVERIFIED: the hash pins what the archive returned at retrievedAt, not that the result is correct.",
    "Published values carry the collaboration's own systematics and assumptions; cite the source DOI, and check against an independent result before relying on it.",
  ];
  if (parsed.kind === "records" && parsed.records.some((r) => r.files?.length)) {
    notes.push("Files are listed with size and checksum but not downloaded; fetch bulk data (FITS, ROOT) in an analysis environment and verify against the checksum.");
  }
  if (req.source === "tap") notes.push(`Rows were capped with MAXREC=${maxRows}; a full result needs an asynchronous TAP job, which this tool does not run.`);
  if (req.source === "hepdata" && !req.hepdata?.table) notes.push("This is the record view; pass a table name to get data points with uncertainties.");
  let result: ScienceDataResult["result"];
  let cut = false;
  if (parsed.kind === "raw") {
    notes.push(`The response shape was not recognised (${parsed.reason}); it is returned as-is and was not interpreted.`);
    const fits = fetched.json !== null && JSON.stringify(fetched.json).length <= MAX_INLINE_RAW;
    if (!fits) notes.push(`The body is over ${MAX_INLINE_RAW} characters, so only its hash and size are returned.`);
    result = { ...parsed, ...(fits ? { json: fetched.json } : {}) };
  } else {
    if (parsed.truncated) notes.push("The archive had more than was read; narrow the query.");
    const c = cap(parsed, limit);
    result = c.out; cut = c.cut;
  }
  const label = req.source === "tap" ? TAP_SERVICES[req.tap!.service].label : fetched.endpointLabel;
  const evidence = domain.recordScienceData(req.missionId, {
    source: req.source, sourceLabel: label, dataset, kind: parsed.kind, count: count(parsed),
    truncated: parsed.kind === "raw" ? false : parsed.truncated, url: fetched.url, retrievedAt: fetched.retrievedAt,
    sha256: fetched.sha256, bytes: fetched.bytes,
    dois: parsed.kind === "records" ? parsed.records.map((r) => r.doi).filter((d): d is string => !!d).slice(0, 20) : [],
  });
  return {
    missionId: req.missionId, evidenceId: evidence.id, trust: "UNVERIFIED", dataClass: "source_reported",
    provenance: { url: fetched.url, endpoint: label, retrievedAt: fetched.retrievedAt, httpStatus: fetched.httpStatus, bytes: fetched.bytes, sha256: fetched.sha256 },
    source: req.source, dataset, result, count: count(parsed), returnedTruncated: cut, notes,
  };
}
