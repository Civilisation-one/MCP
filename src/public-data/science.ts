/**
 * Scientific archives: CERN Open Data, HEPData, INSPIRE-HEP, Zenodo, and TAP catalogue services
 * (NOIRLab Astro Data Lab for DESI, NASA/IPAC IRSA for Planck catalogues, ESA Gaia).
 *
 * What comes back is one of three shapes:
 * - "records": catalogue entries (id, title, DOI, files with size and checksum). Files are listed, never
 *   downloaded: CERN Open Data alone holds petabytes, and FITS/ROOT products belong in an analysis
 *   environment, not in a tool response.
 * - "table": rows and columns from a TAP (ADQL) query, read as CSV.
 * - "measurements": a HEPData table with independent variables, values and their uncertainties.
 *
 * Shapes the parsers do not recognise come back as "raw" (the JSON as returned, size-capped) rather than
 * being guessed at, so a format change upstream is visible, not silently misread.
 */
import { SourceParseError } from "./sources.js";

export type ScienceSourceId = "cern_opendata" | "hepdata" | "inspire" | "zenodo" | "tap";
export type TapService = "datalab_desi" | "irsa_planck" | "gaia";

export const TAP_SERVICES: Readonly<Record<TapService, { base: string; label: string; hint: string }>> = Object.freeze({
  datalab_desi: { base: "https://datalab.noirlab.edu/tap/sync", label: "NOIRLab Astro Data Lab", hint: "DESI tables such as desi_dr1.zpix" },
  irsa_planck: { base: "https://irsa.ipac.caltech.edu/TAP/sync", label: "NASA/IPAC IRSA", hint: "Planck catalogues such as com_pccs2_100" },
  gaia: { base: "https://gea.esac.esa.int/tap-server/tap/sync", label: "ESA Gaia Archive", hint: "gaiadr3.gaia_source" },
});

export interface ScienceFile { name: string; size?: number; checksum?: string; url?: string }
export interface ScienceRecord {
  id: string; title?: string; doi?: string; date?: string; authors?: string[]; collaboration?: string;
  arxiv?: string; citationCount?: number; type?: string; url?: string; files?: ScienceFile[]; fileCount?: number;
}
export interface Measurement {
  /** Independent variables for this point, e.g. {"PT [GeV]": "20-30"}. */
  x: Record<string, string | number>;
  /** Dependent variable name → value with uncertainties as given. */
  y: Record<string, { value: number | null; raw?: string; errors?: Array<{ label?: string; plus?: number; minus?: number; sym?: number }> }>;
}

export type ScienceParsed =
  | { kind: "records"; title?: string; total?: number; records: ScienceRecord[]; truncated: boolean }
  | { kind: "table"; columns: string[]; rows: Array<Record<string, string | number | null>>; truncated: boolean }
  | { kind: "measurements"; title?: string; description?: string; measurements: Measurement[]; truncated: boolean }
  | { kind: "raw"; reason: string };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 500): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : undefined);
const numOrUndef = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim()) ? Number(v) : undefined);
const first = <T>(v: unknown, f: (x: unknown) => T | undefined): T | undefined => (Array.isArray(v) ? v.map(f).find((x) => x !== undefined) : f(v));
function bad(msg: string): never { throw new SourceParseError("QUERY_INVALID", msg); }

// ---------------------------------------------------------------- ADQL guard
const FORBIDDEN = /\b(insert|update|delete|drop|create|alter|grant|revoke|truncate|copy|merge|call|exec|execute|vacuum|analyze|set|commit|rollback|upload|into)\b/i;

/** Accepts one read-only SELECT. TAP services are read-only by design; this is defence in depth and keeps
 *  queries bounded. Returns the query unchanged; row count is capped separately with MAXREC. */
export function checkAdql(query: string): string {
  const q = query.trim();
  if (!q) bad("query is empty");
  if (q.length > 4000) bad("query is longer than 4000 characters");
  if (!/^select\b/i.test(q)) bad("only SELECT queries are allowed");
  if (/;/.test(q)) bad("one statement only (no ';')");
  if (/--|\/\*|\*\//.test(q)) bad("comments are not allowed in queries");
  // Strip string literals before keyword checks so WHERE name = 'drop' is fine.
  const bare = q.replace(/'(?:[^']|'')*'/g, "''");
  if (FORBIDDEN.test(bare)) bad("the query contains a keyword that is not allowed in a read-only SELECT");
  if (/\btap_upload\./i.test(bare)) bad("table uploads are not allowed");
  return q;
}

export interface TapQuery { service: TapService; query: string; maxRows?: number }

export function tapUrl(q: TapQuery): string {
  const svc = TAP_SERVICES[q.service] ?? bad(`unknown TAP service ${JSON.stringify(q.service)}`);
  const maxRows = q.maxRows ?? 1000;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 5000) bad("maxRows must be 1–5000");
  const u = new URL(svc.base);
  u.searchParams.set("REQUEST", "doQuery");
  u.searchParams.set("LANG", "ADQL");
  u.searchParams.set("FORMAT", "csv");
  u.searchParams.set("MAXREC", String(maxRows));
  u.searchParams.set("QUERY", checkAdql(q.query));
  return u.href;
}

/** RFC 4180 CSV. The first row is the header. Numeric-looking cells become numbers; empty cells null. */
export function parseCsvTable(text: string, maxRows: number): { columns: string[]; rows: Array<Record<string, string | number | null>>; truncated: boolean } {
  const records: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, i = 0;
  const src = text.replace(/^﻿/, "");
  const push = () => { row.push(cell); cell = ""; };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === "") { quoted = true; i++; continue; }
    if (c === ",") { push(); i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { push(); records.push(row); row = []; i++; if (records.length > maxRows + 1) break; continue; }
    cell += c; i++;
  }
  if (cell !== "" || row.length) { push(); records.push(row); }
  if (quoted) throw new SourceParseError("UNEXPECTED_SHAPE", "CSV ends inside a quoted field");
  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0] === ""));
  if (!nonEmpty.length) return { columns: [], rows: [], truncated: false };
  const columns = nonEmpty[0].map((h, n) => h.trim() || `col${n + 1}`);
  const body = nonEmpty.slice(1);
  const rows = body.slice(0, maxRows).map((r) => {
    if (r.length !== columns.length) throw new SourceParseError("UNEXPECTED_SHAPE", `CSV row has ${r.length} fields; the header has ${columns.length}`);
    return Object.fromEntries(columns.map((c, n) => {
      const v = r[n];
      if (v === "") return [c, null];
      const t = v.trim();
      if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return [c, v.slice(0, 2000)];
      // 64-bit IDs (DESI TARGETID, Gaia source_id) exceed 2^53 and would be silently rounded as numbers.
      if (/^-?\d+$/.test(t) && !Number.isSafeInteger(Number(t))) return [c, t];
      return [c, Number(t)];
    }));
  });
  return { columns, rows, truncated: body.length > maxRows };
}

// ---------------------------------------------------------------- CERN Open Data (Invenio)
export interface CernQuery { recid?: number; search?: string; size?: number }

export function cernUrl(q: CernQuery): string {
  if (q.recid !== undefined) {
    if (!Number.isInteger(q.recid) || q.recid < 1) bad("recid must be a positive integer");
    return `https://opendata.cern.ch/api/records/${q.recid}`;
  }
  if (!q.search?.trim()) bad("give recid or search");
  const u = new URL("https://opendata.cern.ch/api/records");
  u.searchParams.set("q", q.search.trim().slice(0, 300));
  u.searchParams.set("size", String(Math.min(Math.max(q.size ?? 10, 1), 50)));
  return u.href;
}

/** All file entries: direct lists (_files / files) plus, for CERN datasets, the files inside each
 *  metadata._file_indices[n].files (large datasets split their ROOT files across several indices). */
function allInvenioFiles(meta: Record<string, unknown>, top: Record<string, unknown>): Record<string, unknown>[] {
  const direct = ([meta._files, meta.files, top.files].find(Array.isArray) as unknown[] | undefined) ?? [];
  const indexed = (Array.isArray(meta._file_indices) ? meta._file_indices : []).filter(isRec)
    .flatMap((ix) => (Array.isArray(ix.files) ? ix.files : []));
  return [...direct, ...indexed].filter(isRec);
}

function invenioFiles(meta: Record<string, unknown>, top: Record<string, unknown>): ScienceFile[] {
  return allInvenioFiles(meta, top).slice(0, 200).map((f) => ({
    name: str(f.key) ?? str(f.filename) ?? "?", size: numOrUndef(f.size), checksum: str(f.checksum, 120),
    url: str(f.uri, 1000) ?? (isRec(f.links) ? str(f.links.self, 1000) : undefined),
  }));
}

function cernRecord(hit: Record<string, unknown>): ScienceRecord {
  const meta = isRec(hit.metadata) ? hit.metadata : hit;
  const files = invenioFiles(meta, hit);
  const id = str(meta.recid) ?? str(hit.id) ?? "?";
  return {
    id, title: str(meta.title) ?? first(meta.titles, (t) => (isRec(t) ? str(t.title) : undefined)),
    doi: str(meta.doi), date: str(meta.date_published) ?? str(meta.date_created),
    collaboration: first(meta.experiment, (e) => str(e)) ?? first(meta.collaboration, (c) => (isRec(c) ? str(c.name) : str(c))),
    type: isRec(meta.type) ? str(meta.type.primary) : str(meta.type),
    url: `https://opendata.cern.ch/record/${id}`, files, fileCount: allInvenioFiles(meta, hit).length,
  };
}

export function parseCern(json: unknown): ScienceParsed {
  if (!isRec(json)) return { kind: "raw", reason: "CERN response is not an object" };
  if (isRec(json.hits) && Array.isArray(json.hits.hits)) {
    const total = numOrUndef(json.hits.total) ?? (isRec(json.hits.total) ? numOrUndef(json.hits.total.value) : undefined);
    const records = json.hits.hits.filter(isRec).map(cernRecord);
    return { kind: "records", total, records, truncated: total !== undefined && total > records.length };
  }
  if (isRec(json.metadata)) return { kind: "records", total: 1, records: [cernRecord(json)], truncated: false };
  return { kind: "raw", reason: "no hits or metadata in the CERN response" };
}

// ---------------------------------------------------------------- HEPData
export interface HepDataQuery { inspireId: number; table?: string; version?: number }

export function hepdataUrl(q: HepDataQuery): string {
  if (!Number.isInteger(q.inspireId) || q.inspireId < 1) bad("inspireId must be a positive integer");
  const u = new URL(`https://www.hepdata.net/record/ins${q.inspireId}`);
  u.searchParams.set("format", "json");
  if (q.table !== undefined) {
    if (!/^[\w .()+\-/:]{1,120}$/.test(q.table)) bad("table name has characters that are not allowed");
    u.searchParams.set("table", q.table);
  } else {
    u.searchParams.set("light", "true");
  }
  if (q.version !== undefined) {
    if (!Number.isInteger(q.version) || q.version < 1 || q.version > 100) bad("version must be 1–100");
    u.searchParams.set("version", String(q.version));
  }
  return u.href;
}

function hepValue(v: unknown): { value: number | null; raw?: string } {
  const n = numOrUndef(v);
  return n !== undefined ? { value: n } : v === undefined || v === null ? { value: null } : { value: null, raw: String(v).slice(0, 50) };
}

/** HEPData tables follow the hepdata-submission layout: independent_variables[] and dependent_variables[],
 *  each {header: {name, units}, values: [...]}; independent values are {value} or {low, high}; dependent
 *  values are {value, errors: [{label, symerror} | {label, asymerror: {plus, minus}}]}. */
export function parseHepData(json: unknown, maxPoints = 5000): ScienceParsed {
  if (!isRec(json)) return { kind: "raw", reason: "HEPData response is not an object" };
  const t = Array.isArray(json.independent_variables) ? json : isRec(json.table) && Array.isArray(json.table.independent_variables) ? json.table : undefined;
  if (!t || !Array.isArray(t.dependent_variables)) {
    // Record view (no table requested): list what we can name, keep the rest raw-free.
    const rec = isRec(json.record) ? json.record : undefined;
    if (rec) {
      return { kind: "records", total: 1, truncated: false, records: [{
        id: str(rec.inspire_id) ?? str(rec.recid) ?? "?", title: str(rec.title), doi: str(rec.hepdata_doi) ?? str(rec.doi),
        collaboration: first(rec.collaborations, (c) => str(c)), arxiv: str(rec.arxiv_id),
        url: str(rec.inspire_id) ? `https://www.hepdata.net/record/ins${str(rec.inspire_id)}` : undefined,
      }] };
    }
    return { kind: "raw", reason: "no independent_variables/dependent_variables (pass a table name to get data points)" };
  }
  const name = (h: unknown) => (isRec(h) ? [str(h.name), h.units ? `[${str(h.units)}]` : undefined].filter(Boolean).join(" ") : "?") || "?";
  const ind = (t.independent_variables as unknown[]).filter(isRec);
  const dep = (t.dependent_variables as unknown[]).filter(isRec);
  const n = Math.max(0, ...ind.map((v) => (Array.isArray(v.values) ? v.values.length : 0)), ...dep.map((v) => (Array.isArray(v.values) ? v.values.length : 0)));
  const measurements: Measurement[] = [];
  for (let i = 0; i < Math.min(n, maxPoints); i++) {
    const x: Measurement["x"] = {};
    for (const v of ind) {
      const p = Array.isArray(v.values) ? v.values[i] : undefined;
      if (!isRec(p)) continue;
      const lo = numOrUndef(p.low), hi = numOrUndef(p.high), val = numOrUndef(p.value);
      x[name(v.header)] = lo !== undefined && hi !== undefined ? `${lo}–${hi}` : val ?? str(p.value) ?? "?";
    }
    const y: Measurement["y"] = {};
    for (const v of dep) {
      const p = Array.isArray(v.values) ? v.values[i] : undefined;
      if (!isRec(p)) continue;
      const errors = (Array.isArray(p.errors) ? p.errors : []).filter(isRec).map((e) => {
        const a = isRec(e.asymerror) ? e.asymerror : undefined;
        return { label: str(e.label), sym: numOrUndef(e.symerror), plus: a ? numOrUndef(a.plus) : undefined, minus: a ? numOrUndef(a.minus) : undefined };
      });
      const qual = Array.isArray(v.qualifiers) ? v.qualifiers.filter(isRec).map((q) => `${str(q.name)}=${str(q.value)}`).join(", ") : "";
      y[name(v.header) + (qual ? ` (${qual.slice(0, 200)})` : "")] = { ...hepValue(p.value), ...(errors.length ? { errors } : {}) };
    }
    measurements.push({ x, y });
  }
  return { kind: "measurements", title: str(t.name), description: str(t.description, 1000), measurements, truncated: n > maxPoints };
}

// ---------------------------------------------------------------- INSPIRE-HEP
export interface InspireQuery { search: string; size?: number; sort?: "mostrecent" | "mostcited" }

export function inspireUrl(q: InspireQuery): string {
  if (!q.search?.trim()) bad("search is required");
  const u = new URL("https://inspirehep.net/api/literature");
  u.searchParams.set("q", q.search.trim().slice(0, 500));
  u.searchParams.set("size", String(Math.min(Math.max(q.size ?? 10, 1), 100)));
  if (q.sort) u.searchParams.set("sort", q.sort);
  u.searchParams.set("fields", "titles,arxiv_eprints,dois,citation_count,earliest_date,authors.full_name,collaborations,control_number");
  return u.href;
}

export function parseInspire(json: unknown): ScienceParsed {
  if (!isRec(json) || !isRec(json.hits) || !Array.isArray(json.hits.hits)) return { kind: "raw", reason: "no hits in the INSPIRE response" };
  const total = numOrUndef(json.hits.total);
  const records = json.hits.hits.filter(isRec).map((h): ScienceRecord => {
    const m = isRec(h.metadata) ? h.metadata : {};
    const id = str(m.control_number) ?? str(h.id) ?? "?";
    const authors = (Array.isArray(m.authors) ? m.authors : []).filter(isRec).slice(0, 10).map((a) => str(a.full_name)).filter((a): a is string => !!a);
    return {
      id, title: first(m.titles, (t) => (isRec(t) ? str(t.title) : undefined)), doi: first(m.dois, (d) => (isRec(d) ? str(d.value) : undefined)),
      arxiv: first(m.arxiv_eprints, (e) => (isRec(e) ? str(e.value) : undefined)), citationCount: numOrUndef(m.citation_count),
      date: str(m.earliest_date), authors, collaboration: first(m.collaborations, (c) => (isRec(c) ? str(c.value) : undefined)),
      url: `https://inspirehep.net/literature/${id}`,
    };
  });
  return { kind: "records", total, records, truncated: total !== undefined && total > records.length };
}

// ---------------------------------------------------------------- Zenodo (InvenioRDM)
export interface ZenodoQuery { recordId?: number; search?: string; size?: number }

export function zenodoUrl(q: ZenodoQuery): string {
  if (q.recordId !== undefined) {
    if (!Number.isInteger(q.recordId) || q.recordId < 1) bad("recordId must be a positive integer");
    return `https://zenodo.org/api/records/${q.recordId}`;
  }
  if (!q.search?.trim()) bad("give recordId or search");
  const u = new URL("https://zenodo.org/api/records");
  u.searchParams.set("q", q.search.trim().slice(0, 300));
  u.searchParams.set("size", String(Math.min(Math.max(q.size ?? 10, 1), 50)));
  return u.href;
}

function zenodoRecord(h: Record<string, unknown>): ScienceRecord {
  const m = isRec(h.metadata) ? h.metadata : {};
  const files = invenioFiles({}, h);
  const id = str(h.id) ?? str(h.recid) ?? "?";
  return {
    id, title: str(m.title), doi: str(h.doi) ?? str(m.doi), date: str(m.publication_date),
    authors: (Array.isArray(m.creators) ? m.creators : []).filter(isRec).slice(0, 10).map((c) => str(c.name)).filter((a): a is string => !!a),
    type: isRec(m.resource_type) ? str(m.resource_type.type) ?? str(m.resource_type.title) : undefined,
    url: `https://zenodo.org/records/${id}`, files, fileCount: files.length,
  };
}

export function parseZenodo(json: unknown): ScienceParsed {
  if (!isRec(json)) return { kind: "raw", reason: "Zenodo response is not an object" };
  if (isRec(json.hits) && Array.isArray(json.hits.hits)) {
    const total = numOrUndef(json.hits.total) ?? (isRec(json.hits.total) ? numOrUndef(json.hits.total.value) : undefined);
    const records = json.hits.hits.filter(isRec).map(zenodoRecord);
    return { kind: "records", total, records, truncated: total !== undefined && total > records.length };
  }
  if (isRec(json.metadata)) return { kind: "records", total: 1, records: [zenodoRecord(json)], truncated: false };
  return { kind: "raw", reason: "no hits or metadata in the Zenodo response" };
}
