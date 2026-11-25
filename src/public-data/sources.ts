/**
 * Public data sources: each builds a URL from validated codes and parses the response into one shape.
 *
 * Every observation is source-reported. Civilisation.One did not measure it, and a published series may
 * mix measured values, estimates and projections; the source's own flag is kept in `flag` where it has one.
 * Parsers never invent values: anything that is not a finite number becomes `value: null` with `raw` kept.
 */

export type PublicSourceId = "worldbank" | "oecd" | "eurostat" | "unsdg" | "allowlisted_json";

export interface PublicObservation {
  /** Area code as the source gives it (ISO3, M49, NUTS…). */
  area: string;
  areaLabel?: string;
  period: string;
  value: number | null;
  /** The source's value when it was not a finite number (e.g. ">95", "NaN"). */
  raw?: string;
  unit?: string;
  /** Source status flag (World Bank obs_status, Eurostat status, SDG Nature, SDMX OBS_STATUS). */
  flag?: string;
  /** Other dimensions that identify the series (SDMX/JSON-stat), e.g. {MEASURE: "LI"}. */
  dims?: Record<string, string>;
}

export interface ParsedDataset {
  source: PublicSourceId;
  dataset: string;
  title?: string;
  observations: PublicObservation[];
  /** True when the source had more pages or rows than were read. */
  truncated: boolean;
  /** Source-side metadata worth keeping: last updated, source name. */
  sourceUpdated?: string;
  sourceName?: string;
}

export class SourceParseError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SourceParseError"; }
}

const CODE = /^[A-Za-z0-9_.@-]{1,120}$/;
const PERIOD = /^[0-9]{4}(-[0-9]{2}|-Q[1-4]|-S[12]|-W[0-9]{2}|-[0-9]{2}-[0-9]{2})?$/;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function code(label: string, v: string, re = CODE): string {
  if (!re.test(v)) throw new SourceParseError("QUERY_INVALID", `${label} ${JSON.stringify(v)} has characters that are not allowed`);
  return v;
}
function period(label: string, v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (!PERIOD.test(v)) throw new SourceParseError("QUERY_INVALID", `${label} must look like 2020, 2020-03, 2020-Q1 or 2020-03-15`);
  return v;
}
function num(v: unknown): { value: number | null; raw?: string } {
  if (typeof v === "number") return Number.isFinite(v) ? { value: v } : { value: null, raw: String(v) };
  if (v === null || v === undefined || v === "") return { value: null };
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return { value: Number(s) };
  return { value: null, raw: s.slice(0, 50) };
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, 300) : undefined);

// ---------------------------------------------------------------- World Bank Indicators API v2
export interface WorldBankQuery { country: string; indicator: string; startYear?: number; endYear?: number }

export function worldBankUrl(q: WorldBankQuery): string {
  const country = code("country", q.country, /^[A-Za-z0-9]{2,3}(;[A-Za-z0-9]{2,3}){0,19}$|^all$/);
  const indicator = code("indicator", q.indicator, /^[A-Za-z0-9_.]{2,80}$/);
  const u = new URL(`https://api.worldbank.org/v2/country/${country}/indicator/${indicator}`);
  u.searchParams.set("format", "json");
  u.searchParams.set("per_page", "1000");
  if (q.startYear !== undefined || q.endYear !== undefined) {
    const s = q.startYear ?? q.endYear!, e = q.endYear ?? q.startYear!;
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1900 || e > 2200 || s > e) throw new SourceParseError("QUERY_INVALID", "year range is invalid");
    u.searchParams.set("date", `${s}:${e}`);
  }
  return u.href;
}

/** Response: [ {page, pages, per_page, total, lastupdated}, [ {indicator:{id,value}, country:{id,value},
 *  countryiso3code, date, value, unit, obs_status, decimal} ] ], or [ {message:[{id,key,value}]} ] on error. */
export function parseWorldBank(json: unknown, dataset: string): ParsedDataset {
  if (!Array.isArray(json) || !isRec(json[0])) throw new SourceParseError("UNEXPECTED_SHAPE", "World Bank response is not [meta, rows]");
  const meta = json[0];
  if (Array.isArray(meta.message)) {
    const m = meta.message.find(isRec);
    throw new SourceParseError("SOURCE_ERROR", `World Bank: ${str(m?.key) ?? "error"} ${str(m?.value) ?? ""}`.trim());
  }
  const rows = Array.isArray(json[1]) ? json[1] : [];
  const observations: PublicObservation[] = [];
  let title: string | undefined;
  for (const r of rows) {
    if (!isRec(r)) continue;
    const ind = isRec(r.indicator) ? r.indicator : {};
    const ctry = isRec(r.country) ? r.country : {};
    title ??= str(ind.value);
    observations.push({
      area: str(r.countryiso3code) ?? str(ctry.id) ?? "?", areaLabel: str(ctry.value), period: String(r.date ?? "?"),
      ...num(r.value), unit: str(r.unit), flag: str(r.obs_status),
    });
  }
  return {
    source: "worldbank", dataset, title, observations, sourceUpdated: str(meta.lastupdated), sourceName: "World Bank",
    truncated: Number(meta.pages ?? 1) > Number(meta.page ?? 1),
  };
}

// ---------------------------------------------------------------- OECD Data Explorer, SDMX-JSON
export interface OecdQuery { agency: string; dataflow: string; key?: string; startPeriod?: string; endPeriod?: string }

export function oecdUrl(q: OecdQuery): string {
  const agency = code("agency", q.agency, /^[A-Z0-9_.]{2,60}$/);
  const dataflow = code("dataflow", q.dataflow, /^[A-Za-z0-9_@]{2,80}(,[0-9.]{1,10})?$/);
  const key = q.key === undefined || q.key === "" ? "all" : code("key", q.key, /^[A-Za-z0-9_.+]{1,300}$/);
  const u = new URL(`https://sdmx.oecd.org/public/rest/data/${agency},${dataflow}/${key}`);
  u.searchParams.set("dimensionAtObservation", "AllDimensions");
  u.searchParams.set("format", "jsondata");
  const s = period("startPeriod", q.startPeriod), e = period("endPeriod", q.endPeriod);
  if (s) u.searchParams.set("startPeriod", s);
  if (e) u.searchParams.set("endPeriod", e);
  return u.href;
}

interface SdmxDim { id: string; values: Array<{ id: string; name?: string }> }

/** SDMX-JSON (1.0 or 2.0) with dimensionAtObservation=AllDimensions: observations are keyed
 *  "i:j:k…" by index into structure.dimensions.observation[n].values. 2.0 nests under data with a
 *  `structures` array; 1.0 has `structure` (and may not be wrapped in data). */
export function parseSdmxJson(json: unknown, dataset: string, maxObservations = 10_000): ParsedDataset {
  if (!isRec(json)) throw new SourceParseError("UNEXPECTED_SHAPE", "SDMX-JSON response is not an object");
  if (Array.isArray(json.errors) && json.errors.length) {
    const e = json.errors.find(isRec);
    throw new SourceParseError("SOURCE_ERROR", `OECD: ${str(e?.message) ?? str(e?.title) ?? "error"}`);
  }
  const data = isRec(json.data) ? json.data : json;
  const structure = Array.isArray(data.structures) ? data.structures.find(isRec) : isRec(data.structure) ? data.structure : undefined;
  const dataSet = Array.isArray(data.dataSets) ? data.dataSets.find(isRec) : undefined;
  if (!structure || !dataSet) throw new SourceParseError("UNEXPECTED_SHAPE", "SDMX-JSON response has no structure or dataSets");
  const dimsBlock = isRec(structure.dimensions) ? structure.dimensions : {};
  const dims: SdmxDim[] = (Array.isArray(dimsBlock.observation) ? dimsBlock.observation : []).filter(isRec).map((d) => ({
    id: String(d.id), values: (Array.isArray(d.values) ? d.values : []).filter(isRec).map((v) => ({ id: String(v.id), name: str(nameOf(v.name)) })),
  }));
  if (!dims.length) throw new SourceParseError("UNEXPECTED_SHAPE", "SDMX-JSON has no observation dimensions (was dimensionAtObservation=AllDimensions sent?)");
  const attrsBlock = isRec(structure.attributes) ? structure.attributes : {};
  const obsAttrs = (Array.isArray(attrsBlock.observation) ? attrsBlock.observation : []).filter(isRec);
  const statusIdx = obsAttrs.findIndex((a) => a.id === "OBS_STATUS");
  const unitIdx = obsAttrs.findIndex((a) => a.id === "UNIT_MEASURE");
  const attrValue = (i: number, pos: unknown) => {
    if (i < 0 || typeof pos !== "number") return undefined;
    const vals = Array.isArray(obsAttrs[i].values) ? (obsAttrs[i].values as unknown[]) : [];
    const v = vals[pos];
    return isRec(v) ? str(v.id) : undefined;
  };
  const timeIdx = dims.findIndex((d) => d.id === "TIME_PERIOD");
  const areaIdx = dims.findIndex((d) => d.id === "REF_AREA");
  const obs = isRec(dataSet.observations) ? dataSet.observations : {};
  const keys = Object.keys(obs);
  const observations: PublicObservation[] = [];
  for (const k of keys.slice(0, maxObservations)) {
    const idx = k.split(":").map(Number);
    if (idx.length !== dims.length || idx.some((n) => !Number.isInteger(n))) continue;
    const arr = Array.isArray(obs[k]) ? (obs[k] as unknown[]) : [obs[k]];
    const other: Record<string, string> = {};
    dims.forEach((d, n) => { if (n !== timeIdx && n !== areaIdx) other[d.id] = d.values[idx[n]]?.id ?? "?"; });
    // Attribute positions follow the value: arr[1 + attributeIndex].
    observations.push({
      area: areaIdx >= 0 ? dims[areaIdx].values[idx[areaIdx]]?.id ?? "?" : "?",
      areaLabel: areaIdx >= 0 ? dims[areaIdx].values[idx[areaIdx]]?.name : undefined,
      period: timeIdx >= 0 ? dims[timeIdx].values[idx[timeIdx]]?.id ?? "?" : "?",
      ...num(arr[0]), flag: attrValue(statusIdx, arr[1 + statusIdx]), unit: attrValue(unitIdx, arr[1 + unitIdx]), dims: other,
    });
  }
  return { source: "oecd", dataset, title: str(nameOf(structure.name)), observations, truncated: keys.length > maxObservations, sourceName: "OECD" };
}
function nameOf(v: unknown): unknown { return isRec(v) ? (v.en ?? Object.values(v)[0]) : v; }

// ---------------------------------------------------------------- Eurostat Statistics API, JSON-stat 2.0
export interface EurostatQuery { dataset: string; filters?: Record<string, string[]>; lastTimePeriod?: number }

export function eurostatUrl(q: EurostatQuery): string {
  const dataset = code("dataset", q.dataset, /^[A-Za-z0-9_$]{2,60}$/);
  const u = new URL(`https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${dataset}`);
  u.searchParams.set("format", "JSON");
  u.searchParams.set("lang", "EN");
  for (const [dim, values] of Object.entries(q.filters ?? {})) {
    code("filter dimension", dim, /^[A-Za-z_][A-Za-z0-9_]{0,40}$/);
    if (["format", "lang"].includes(dim.toLowerCase())) throw new SourceParseError("QUERY_INVALID", `${dim} cannot be a filter`);
    for (const v of values) u.searchParams.append(dim, code(`filter ${dim}`, v, /^[A-Za-z0-9_.-]{1,40}$/));
  }
  if (q.lastTimePeriod !== undefined) {
    if (!Number.isInteger(q.lastTimePeriod) || q.lastTimePeriod < 1 || q.lastTimePeriod > 100) throw new SourceParseError("QUERY_INVALID", "lastTimePeriod must be 1–100");
    u.searchParams.set("lastTimePeriod", String(q.lastTimePeriod));
  }
  return u.href;
}

/** JSON-stat 2.0 dataset: id[] and size[] give the dimension order; value and status are arrays or
 *  sparse objects keyed by the row-major flat index; category.index is an object {code: position} or an
 *  array of codes. Errors come as {error: [{status, id, label}]} or {error: {...}}. */
export function parseJsonStat(json: unknown, dataset: string, maxObservations = 10_000): ParsedDataset {
  if (!isRec(json)) throw new SourceParseError("UNEXPECTED_SHAPE", "JSON-stat response is not an object");
  if (json.error) {
    const e = Array.isArray(json.error) ? json.error.find(isRec) : isRec(json.error) ? json.error : undefined;
    throw new SourceParseError("SOURCE_ERROR", `Eurostat: ${str(e?.label) ?? "error"}`);
  }
  if (json.class !== "dataset" || !Array.isArray(json.id) || !Array.isArray(json.size) || !isRec(json.dimension)) {
    throw new SourceParseError("UNEXPECTED_SHAPE", "JSON-stat response is not a dataset with id, size and dimension");
  }
  const ids = json.id.map(String), size = json.size.map(Number);
  if (ids.length !== size.length || size.some((n) => !Number.isInteger(n) || n < 0)) throw new SourceParseError("UNEXPECTED_SHAPE", "JSON-stat id and size do not match");
  const dimension = json.dimension;
  const codesByPos = ids.map((id, n) => {
    const d = isRec(dimension[id]) ? dimension[id] : {};
    const cat = isRec(d.category) ? d.category : {};
    const codes: string[] = new Array(size[n]).fill("?");
    if (Array.isArray(cat.index)) cat.index.forEach((c, i) => { codes[i] = String(c); });
    else if (isRec(cat.index)) for (const [c, i] of Object.entries(cat.index)) codes[Number(i)] = c;
    else if (size[n] === 1 && isRec(cat.label)) codes[0] = Object.keys(cat.label)[0] ?? "?";
    const labels = isRec(cat.label) ? cat.label : {};
    const unit = isRec(cat.unit) ? cat.unit : {};
    return { id, codes, labels, unit };
  });
  const total = size.reduce((a, b) => a * b, 1);
  const entries: Array<[number, unknown]> = Array.isArray(json.value)
    ? json.value.map((v, i) => [i, v] as [number, unknown]).filter(([, v]) => v !== null)
    : isRec(json.value) ? Object.entries(json.value).map(([k, v]) => [Number(k), v] as [number, unknown]) : [];
  const statusOf = (i: number) => (Array.isArray(json.status) ? str(json.status[i]) : isRec(json.status) ? str(json.status[String(i)]) : undefined);
  const timeN = ids.findIndex((id) => id.toLowerCase() === "time");
  const geoN = ids.findIndex((id) => id.toLowerCase() === "geo");
  const unitN = ids.findIndex((id) => id.toLowerCase() === "unit");
  const observations: PublicObservation[] = [];
  for (const [flat, v] of entries.filter(([i]) => Number.isInteger(i) && i >= 0 && i < total).slice(0, maxObservations)) {
    let rest = flat;
    const pos = new Array(ids.length).fill(0);
    for (let n = ids.length - 1; n >= 0; n--) { pos[n] = rest % size[n]; rest = Math.floor(rest / size[n]); }
    const other: Record<string, string> = {};
    codesByPos.forEach((d, n) => { if (n !== timeN && n !== geoN) other[d.id] = d.codes[pos[n]]; });
    const geo = geoN >= 0 ? codesByPos[geoN] : undefined;
    observations.push({
      area: geo ? geo.codes[pos[geoN]] : "?", areaLabel: geo ? str(geo.labels[geo.codes[pos[geoN]]]) : undefined,
      period: timeN >= 0 ? codesByPos[timeN].codes[pos[timeN]] : "?", ...num(v), flag: statusOf(flat),
      unit: unitN >= 0 ? codesByPos[unitN].codes[pos[unitN]] : undefined, dims: other,
    });
  }
  return {
    source: "eurostat", dataset, title: str(json.label), observations, truncated: entries.length > maxObservations,
    sourceUpdated: str(json.updated), sourceName: str(json.source) ?? "Eurostat",
  };
}

// ---------------------------------------------------------------- UN SDG API
export interface UnSdgQuery { seriesCode: string; areaCodes: string[]; timePeriods?: number[] }

export function unSdgUrl(q: UnSdgQuery): string {
  const series = code("seriesCode", q.seriesCode, /^[A-Z0-9_]{2,40}$/);
  if (!q.areaCodes.length || q.areaCodes.length > 50) throw new SourceParseError("QUERY_INVALID", "give 1–50 M49 area codes");
  const u = new URL("https://unstats.un.org/SDGAPI/v1/sdg/Series/Data");
  u.searchParams.set("seriesCode", series);
  for (const a of q.areaCodes) u.searchParams.append("areaCode", code("areaCode", a, /^[0-9]{1,3}$/));
  for (const t of q.timePeriods ?? []) {
    if (!Number.isInteger(t) || t < 1900 || t > 2200) throw new SourceParseError("QUERY_INVALID", "timePeriods must be years");
    u.searchParams.append("timePeriod", String(t));
  }
  u.searchParams.set("pageSize", "1000");
  return u.href;
}

/** Response: {totalElements, totalPages, pageNumber, data: [{series, seriesDescription, geoAreaCode,
 *  geoAreaName, timePeriodStart, value (string), attributes: {Units, Nature}, source, dimensions}]}. */
export function parseUnSdg(json: unknown, dataset: string): ParsedDataset {
  if (!isRec(json) || !Array.isArray(json.data)) throw new SourceParseError("UNEXPECTED_SHAPE", "UN SDG response has no data array");
  const observations: PublicObservation[] = [];
  let title: string | undefined;
  for (const r of json.data) {
    if (!isRec(r)) continue;
    title ??= str(r.seriesDescription);
    const attrs = isRec(r.attributes) ? r.attributes : {};
    const dims = isRec(r.dimensions) ? Object.fromEntries(Object.entries(r.dimensions).map(([k, v]) => [k, String(v).slice(0, 80)])) : undefined;
    const t = typeof r.timePeriodStart === "number" ? String(Math.trunc(r.timePeriodStart)) : String(r.timePeriodStart ?? "?");
    observations.push({
      area: String(r.geoAreaCode ?? "?"), areaLabel: str(r.geoAreaName), period: t, ...num(r.value),
      unit: str(attrs.Units), flag: str(attrs.Nature), dims,
    });
  }
  return {
    source: "unsdg", dataset, title, observations, sourceName: "UN Statistics Division (SDG Global Database)",
    truncated: Number(json.totalPages ?? 1) > Number(json.pageNumber ?? 1),
  };
}
