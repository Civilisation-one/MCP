import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AppendOnlyAudit } from "../src/audit.js";
import { Civ1Domain } from "../src/domain.js";
import { createCiv1McpServer } from "../src/server.js";
import { PublicDataError, PublicDataFetcher, parseAllowlist } from "../src/public-data/fetcher.js";
import {
  eurostatUrl, oecdUrl, parseJsonStat, parseSdmxJson, parseUnSdg, parseWorldBank, unSdgUrl, worldBankUrl,
} from "../src/public-data/sources.js";
import { fetchPublicData } from "../src/public-data/service.js";

// ---------------------------------------------------------------- fixtures (documented response shapes)
const WB = [
  { page: 1, pages: 1, per_page: 1000, total: 2, sourceid: "2", lastupdated: "2026-10-28" },
  [
    { indicator: { id: "SP.POP.TOTL", value: "Population, total" }, country: { id: "GB", value: "United Kingdom" },
      countryiso3code: "GBR", date: "2023", value: 68350000, unit: "", obs_status: "", decimal: 0 },
    { indicator: { id: "SP.POP.TOTL", value: "Population, total" }, country: { id: "GB", value: "United Kingdom" },
      countryiso3code: "GBR", date: "2022", value: null, unit: "", obs_status: "", decimal: 0 },
  ],
];
const WB_ERROR = [{ message: [{ id: "120", key: "Invalid value", value: "The provided parameter value is not valid" }] }];

const SDMX = {
  meta: { schema: "https://raw.githubusercontent.com/sdmx-twg/sdmx-json/master/data-message/tools/schemas/2.0.0/sdmx-json-data-schema.json" },
  data: {
    dataSets: [{ action: "Information", observations: { "0:0:0": [100.2, 0], "0:0:1": [99.8, 1], "1:0:0": ["NaN", 0] } }],
    structures: [{
      name: "Composite leading indicators",
      dimensions: { observation: [
        { id: "REF_AREA", values: [{ id: "GBR", name: "United Kingdom" }, { id: "DEU", name: "Germany" }] },
        { id: "MEASURE", values: [{ id: "LI", name: "Composite leading indicator" }] },
        { id: "TIME_PERIOD", values: [{ id: "2026-01" }, { id: "2026-02" }] },
      ] },
      attributes: { observation: [{ id: "OBS_STATUS", values: [{ id: "A", name: "Normal value" }, { id: "P", name: "Provisional" }] }] },
    }],
  },
};

const JSONSTAT = {
  version: "2.0", class: "dataset", label: "Gross domestic product at market prices", source: "ESTAT", updated: "2026-10-21T23:00:00+0200",
  value: { "0": 520000.5, "1": 540000.1, "3": 4200000 }, status: { "1": "p" },
  id: ["freq", "unit", "na_item", "geo", "time"], size: [1, 1, 1, 2, 2],
  dimension: {
    freq: { label: "Time frequency", category: { index: { A: 0 }, label: { A: "Annual" } } },
    unit: { label: "Unit", category: { index: { CP_MEUR: 0 }, label: { CP_MEUR: "Current prices, million euro" } } },
    na_item: { label: "National accounts indicator", category: { index: { B1GQ: 0 }, label: { B1GQ: "GDP" } } },
    geo: { label: "Geo", category: { index: { BE: 0, DE: 1 }, label: { BE: "Belgium", DE: "Germany" } } },
    time: { label: "Time", category: { index: { "2016": 0, "2017": 1 }, label: { "2016": "2016", "2017": "2017" } } },
  },
};

const SDG = {
  size: 2, totalElements: 2, totalPages: 1, pageNumber: 1,
  data: [
    { goal: ["7"], target: ["7.1"], indicator: ["7.1.1"], series: "EG_ELC_ACCS", seriesDescription: "Proportion of population with access to electricity, by urban/rural (%)",
      geoAreaCode: "4", geoAreaName: "Afghanistan", timePeriodStart: 2021.0, value: "97.7", valueType: "Float",
      attributes: { Nature: "E", Units: "PERCENT" }, dimensions: { Location: "ALLAREA" }, source: "WHO" },
    { goal: ["7"], target: ["7.1"], indicator: ["7.1.1"], series: "EG_ELC_ACCS", seriesDescription: "Proportion of population with access to electricity, by urban/rural (%)",
      geoAreaCode: "4", geoAreaName: "Afghanistan", timePeriodStart: 2022.0, value: ">95", valueType: "Float",
      attributes: { Nature: "M", Units: "PERCENT" }, dimensions: { Location: "ALLAREA" }, source: "WHO" },
  ],
};

// ---------------------------------------------------------------- helpers
type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (url: string) => { status?: number; body?: unknown; raw?: string; type?: string; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url);
    const text = r.raw ?? JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200, headers: { "content-type": r.type ?? "application/json", ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const fetcher = (impl: typeof fetch, extra: Partial<ConstructorParameters<typeof PublicDataFetcher>[0]> = {}) =>
  new PublicDataFetcher({ enabled: true, extraEndpoints: [], fetchImpl: impl, ...extra });
const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof PublicDataError && e.code === code);

// ---------------------------------------------------------------- boundary
test("public data is off unless the host enables it", async () => {
  const { impl, calls } = fakeFetch(() => ({ body: WB }));
  const f = new PublicDataFetcher({ enabled: false, extraEndpoints: [], fetchImpl: impl });
  await rejects(f.getJson(worldBankUrl({ country: "GBR", indicator: "SP.POP.TOTL" })), "PUBLIC_DATA_DISABLED");
  assert.equal(calls.length, 0);
});

test("only https, port 443, exact allowlisted host and path prefix; no credentials in URLs", async () => {
  const { impl, calls } = fakeFetch(() => ({ body: {} }));
  const f = fetcher(impl);
  await rejects(f.getJson("http://api.worldbank.org/v2/country/GBR/indicator/X?format=json"), "HTTPS_REQUIRED");
  await rejects(f.getJson("https://api.worldbank.org:8443/v2/x"), "URL_INVALID");
  await rejects(f.getJson("https://user:pw@api.worldbank.org/v2/x"), "URL_INVALID");
  await rejects(f.getJson("https://evil.api.worldbank.org/v2/x"), "HOST_NOT_ALLOWED");
  await rejects(f.getJson("https://api.worldbank.org.evil.com/v2/x"), "HOST_NOT_ALLOWED");
  await rejects(f.getJson("https://api.worldbank.org/v1/x"), "HOST_NOT_ALLOWED");
  await rejects(f.getJson("https://ec.europa.eu/eurostat/other/thing"), "HOST_NOT_ALLOWED");
  await rejects(f.getJson("https://api.worldbank.org/v2/x?api_key=abc"), "URL_LOOKS_SECRET");
  await rejects(f.getJson("https://api.worldbank.org/v2/ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "URL_LOOKS_SECRET");
  assert.equal(calls.length, 0, "nothing refused should reach the network");
});

test("requests are GET with no credentials and only Accept / User-Agent headers; redirects are not followed", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 302, raw: "", headers: { location: "https://attacker.example/" } }));
  const f = fetcher(impl);
  await rejects(f.getJson("https://api.worldbank.org/v2/country/GBR/indicator/SP.POP.TOTL?format=json"), "REDIRECT_REFUSED");
  const init = calls[0].init;
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "manual");
  assert.equal(init.credentials, "omit");
  assert.deepEqual(Object.keys(init.headers as Record<string, string>).sort(), ["Accept", "User-Agent"]);
});

test("size, content type, HTTP errors and local hourly budget fail closed", async () => {
  const url = "https://api.worldbank.org/v2/country/GBR/indicator/SP.POP.TOTL?format=json";
  await rejects(fetcher(fakeFetch(() => ({ raw: "x".repeat(2000) })).impl, { maxBytes: 1000 }).getJson(url), "RESPONSE_TOO_LARGE");
  await rejects(fetcher(fakeFetch(() => ({ raw: "<html/>", type: "text/html" })).impl).getJson(url), "NOT_JSON");
  await rejects(fetcher(fakeFetch(() => ({ raw: "{not json" })).impl).getJson(url), "NOT_JSON");
  await rejects(fetcher(fakeFetch(() => ({ status: 500, body: {} })).impl).getJson(url), "UPSTREAM_HTTP_ERROR");
  await rejects(fetcher(fakeFetch(() => ({ status: 429, body: {} })).impl).getJson(url), "UPSTREAM_RATE_LIMITED");
  let t = 0;
  const f = fetcher(fakeFetch(() => ({ body: WB })).impl, { now: () => t });
  for (let i = 0; i < 50; i++) await f.getJson("https://sdmx.oecd.org/public/rest/data/X,Y/all");
  await rejects(f.getJson("https://sdmx.oecd.org/public/rest/data/X,Y/all"), "LOCAL_RATE_LIMIT");
  t = 3_600_001;
  await f.getJson("https://sdmx.oecd.org/public/rest/data/X,Y/all");
});

test("a successful fetch is pinned by SHA-256 of the exact bytes", async () => {
  const raw = JSON.stringify(WB);
  const f = fetcher(fakeFetch(() => ({ raw })).impl, { now: () => Date.parse("2026-11-25T01:00:00Z") });
  const r = await f.getJson(worldBankUrl({ country: "GBR", indicator: "SP.POP.TOTL" }));
  assert.equal(r.sha256, createHash("sha256").update(raw).digest("hex"));
  assert.equal(r.bytes, Buffer.byteLength(raw));
  assert.equal(r.retrievedAt, "2026-11-25T01:00:00.000Z");
});

test("operator allowlist accepts public hostnames only", () => {
  assert.deepEqual(parseAllowlist("data.example.org/api/v1/").map((e) => [e.host, e.pathPrefix]), [["data.example.org", "/api/v1/"]]);
  for (const bad of ["localhost/x", "127.0.0.1/x", "10.0.0.5", "metadata.google.internal/", "printer.local/", "a.example.org/../x"]) {
    assert.throws(() => parseAllowlist(bad), (e: unknown) => e instanceof PublicDataError && e.code === "ALLOWLIST_INVALID", bad);
  }
  assert.deepEqual(parseAllowlist(undefined), []);
});

// ---------------------------------------------------------------- URL builders
test("URL builders produce the documented endpoints and reject injected characters", () => {
  assert.equal(worldBankUrl({ country: "GBR", indicator: "SP.POP.TOTL", startYear: 2015, endYear: 2023 }),
    "https://api.worldbank.org/v2/country/GBR/indicator/SP.POP.TOTL?format=json&per_page=1000&date=2015%3A2023");
  assert.equal(oecdUrl({ agency: "OECD.SDD.STES", dataflow: "DSD_STES@DF_CLI", key: ".M.LI...AA...H", startPeriod: "2023-02" }),
    "https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI/.M.LI...AA...H?dimensionAtObservation=AllDimensions&format=jsondata&startPeriod=2023-02");
  assert.equal(eurostatUrl({ dataset: "tec00001", filters: { geo: ["BE", "DE"], unit: ["CP_MEUR"] } }),
    "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/tec00001?format=JSON&lang=EN&geo=BE&geo=DE&unit=CP_MEUR");
  assert.equal(unSdgUrl({ seriesCode: "EG_ELC_ACCS", areaCodes: ["4", "826"] }),
    "https://unstats.un.org/SDGAPI/v1/sdg/Series/Data?seriesCode=EG_ELC_ACCS&areaCode=4&areaCode=826&pageSize=1000");
  assert.throws(() => worldBankUrl({ country: "GBR/../../x", indicator: "SP" }));
  assert.throws(() => oecdUrl({ agency: "OECD", dataflow: "DF", key: "x?y=1" }));
  assert.throws(() => eurostatUrl({ dataset: "tec00001", filters: { format: ["XML"] } }));
  assert.throws(() => eurostatUrl({ dataset: "tec00001", filters: { geo: ["BE&lang=FR"] } }));
  assert.throws(() => unSdgUrl({ seriesCode: "EG_ELC_ACCS", areaCodes: [] }));
  assert.throws(() => oecdUrl({ agency: "OECD", dataflow: "DF", startPeriod: "yesterday" }));
});

// ---------------------------------------------------------------- parsers
test("World Bank: rows become observations; nulls stay null; error payloads are errors", () => {
  const p = parseWorldBank(WB, "SP.POP.TOTL/GBR");
  assert.equal(p.title, "Population, total");
  assert.deepEqual(p.observations.map((o) => [o.area, o.period, o.value]), [["GBR", "2023", 68350000], ["GBR", "2022", null]]);
  assert.equal(p.truncated, false);
  assert.equal(parseWorldBank([{ ...WB[0], pages: 3 }, WB[1]], "x").truncated, true);
  assert.throws(() => parseWorldBank(WB_ERROR, "x"), /Invalid value/);
  assert.throws(() => parseWorldBank({}, "x"), /not \[meta, rows\]/);
});

test("OECD SDMX-JSON 2.0: indices map to dimension codes, OBS_STATUS is kept, NaN is not a number", () => {
  const p = parseSdmxJson(SDMX, "x");
  assert.equal(p.title, "Composite leading indicators");
  const byKey = Object.fromEntries(p.observations.map((o) => [`${o.area}|${o.period}`, o]));
  assert.equal(byKey["GBR|2026-01"].value, 100.2);
  assert.equal(byKey["GBR|2026-01"].flag, "A");
  assert.equal(byKey["GBR|2026-02"].flag, "P");
  assert.deepEqual(byKey["GBR|2026-02"].dims, { MEASURE: "LI" });
  assert.equal(byKey["DEU|2026-01"].value, null);
  assert.equal(byKey["DEU|2026-01"].raw, "NaN");
  // SDMX-JSON 1.0 layout: unwrapped, singular `structure`.
  const v1 = parseSdmxJson({ dataSets: SDMX.data.dataSets, structure: SDMX.data.structures[0] }, "x");
  assert.equal(v1.observations.length, 3);
  assert.throws(() => parseSdmxJson({ data: { dataSets: [] } }, "x"), /no structure or dataSets/);
});

test("Eurostat JSON-stat 2.0: sparse values decode row-major; status flags kept; missing cells absent", () => {
  const p = parseJsonStat(JSONSTAT, "tec00001");
  assert.equal(p.title, "Gross domestic product at market prices");
  const got = p.observations.map((o) => [o.area, o.period, o.value, o.flag ?? null, o.unit]);
  assert.deepEqual(got, [
    ["BE", "2016", 520000.5, null, "CP_MEUR"],
    ["BE", "2017", 540000.1, "p", "CP_MEUR"],
    ["DE", "2017", 4200000, null, "CP_MEUR"],
  ]);
  assert.equal(p.observations[0].areaLabel, "Belgium");
  // Dense array form gives the same answer.
  const dense = parseJsonStat({ ...JSONSTAT, value: [520000.5, 540000.1, null, 4200000], status: ["", "p", "", ""] }, "tec00001");
  assert.deepEqual(dense.observations.map((o) => o.value), [520000.5, 540000.1, 4200000]);
  assert.throws(() => parseJsonStat({ error: [{ status: 400, label: "Dataset not found" }] }, "x"), /Dataset not found/);
  assert.throws(() => parseJsonStat({ class: "collection" }, "x"), /not a dataset/);
});

test("UN SDG: string values parse; qualified values ('>95') are kept raw, not coerced", () => {
  const p = parseUnSdg(SDG, "EG_ELC_ACCS/4");
  assert.deepEqual(p.observations.map((o) => [o.area, o.period, o.value, o.raw ?? null, o.flag, o.unit]), [
    ["4", "2021", 97.7, null, "E", "PERCENT"],
    ["4", "2022", null, ">95", "M", "PERCENT"],
  ]);
  assert.throws(() => parseUnSdg({ message: "x" }, "x"), /no data array/);
});

// ---------------------------------------------------------------- service and MCP tool
test("a fetch records exactly one capped, hash-pinned evidence item and nothing on failure", async () => {
  const d = new Civ1Domain();
  const m = d.createMission("public data");
  const f = fetcher(fakeFetch((u) => (u.includes("worldbank") ? { body: WB } : { status: 500, body: {} })).impl);
  const r = await fetchPublicData(d, f, { missionId: m.id, source: "worldbank", worldbank: { country: "GBR", indicator: "SP.POP.TOTL" } });
  assert.equal(r.trust, "UNVERIFIED");
  assert.equal(r.dataClass, "source_reported");
  assert.equal(r.observationCount, 2);
  const after = d.getMission(m.id)!;
  assert.equal(after.evidence.length, 1);
  const ev = after.evidence[0];
  assert.equal(ev.status, "HYPOTHESIS");
  assert.ok(ev.reference.endsWith(`#sha256=${r.provenance.sha256}`));
  assert.match(ev.description, /not observed or verified by Civilisation\.One/);
  assert.equal(after.audit.at(-1)?.type, "PUBLIC_DATA_RECORDED");

  await assert.rejects(fetchPublicData(d, f, { missionId: m.id, source: "unsdg", unsdg: { seriesCode: "X", areaCodes: ["4"] } }));
  assert.equal(d.getMission(m.id)!.evidence.length, 1, "a failed fetch records nothing");
  await assert.rejects(fetchPublicData(d, f, { missionId: m.id, source: "oecd" }), /needs the "oecd" query/);
  d.closeMission(m.id);
  await assert.rejects(fetchPublicData(d, f, { missionId: m.id, source: "worldbank", worldbank: { country: "GBR", indicator: "X" } }), /closed/);
});

test("allowlisted JSON needs an operator allowlist entry and returns the body unparsed", async () => {
  const d = new Civ1Domain();
  const m = d.createMission("generic");
  const { impl } = fakeFetch(() => ({ body: { rows: [1, 2, 3] } }));
  const none = fetcher(impl);
  await assert.rejects(fetchPublicData(d, none, { missionId: m.id, source: "allowlisted_json", url: "https://data.example.org/api/v1/x.json" }),
    (e: unknown) => e instanceof PublicDataError && e.code === "HOST_NOT_ALLOWED");
  const f = fetcher(impl, { extraEndpoints: parseAllowlist("data.example.org/api/v1/") });
  const r = await fetchPublicData(d, f, { missionId: m.id, source: "allowlisted_json", url: "https://data.example.org/api/v1/x.json" });
  assert.deepEqual(r.json, { rows: [1, 2, 3] });
  assert.equal(r.observations, undefined);
  assert.equal(r.observationCount, 0);
});

test("MCP tool: disabled by default, works when enabled, errors are structured and audited", async () => {
  const dir = mkdtempSync(join(tmpdir(), "civ1-pd-"));
  try {
    const call = async (publicData: PublicDataFetcher | undefined, body: Record<string, unknown>) => {
      const server = createCiv1McpServer(undefined, { audit: new AppendOnlyAudit(join(dir, "audit.jsonl")), publicData });
      const client = new Client({ name: "pd-test", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      const text = async (name: string, args: Record<string, unknown>) =>
        JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0].text);
      const mission = await text("civ1_create_mission", { goal: "pd" });
      const out = await text("civ1_fetch_public_data", { missionId: mission.id, ...body });
      const status = await text("civ1_system_status", {});
      await client.close();
      return { out, status };
    };
    const prev = process.env.CIV1_PUBLIC_DATA_ENABLED;
    delete process.env.CIV1_PUBLIC_DATA_ENABLED;
    const off = await call(undefined, { source: "worldbank", worldbank: { country: "GBR", indicator: "SP.POP.TOTL" } });
    if (prev !== undefined) process.env.CIV1_PUBLIC_DATA_ENABLED = prev;
    assert.equal(off.out.error, "PUBLIC_DATA_DISABLED");
    assert.ok(off.status.limitations.includes("no-external-actions"));

    const on = await call(fetcher(fakeFetch(() => ({ body: JSONSTAT })).impl),
      { source: "eurostat", eurostat: { dataset: "tec00001", filters: { geo: ["BE", "DE"] } }, limit: 1 });
    assert.equal(on.out.observationCount, 3);
    assert.equal(on.out.observations.length, 1);
    assert.equal(on.out.returnedTruncated, true);
    assert.equal(on.out.evidenceId, "E-1");
    assert.ok(on.status.capabilities.includes("public-data-read"));
    assert.ok(on.status.limitations.includes("external-actions-limited-to-read-only-allowlisted-get"));

    const bad = await call(fetcher(fakeFetch(() => ({ body: {} })).impl), { source: "allowlisted_json", url: "https://169.254.169.254/latest/meta-data" });
    assert.equal(bad.out.error, "HOST_NOT_ALLOWED");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
