import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AppendOnlyAudit } from "../src/audit.js";
import { Civ1Domain } from "../src/domain.js";
import { createCiv1McpServer } from "../src/server.js";
import { PublicDataError, PublicDataFetcher } from "../src/public-data/fetcher.js";
import {
  checkAdql, cernUrl, hepdataUrl, inspireUrl, parseCern, parseCsvTable, parseHepData, parseInspire, parseZenodo, tapUrl, zenodoUrl,
} from "../src/public-data/science.js";
import { fetchScienceData } from "../src/public-data/science-service.js";

// ---------------------------------------------------------------- fixtures (documented shapes)
const CERN_RECORD = {
  id: "5500", metadata: {
    recid: "5500", title: "Higgs-to-four-lepton analysis example using 2011-2012 data", doi: "10.7483/OPENDATA.CMS.JKB8.RR42",
    experiment: ["CMS"], date_published: "2017", type: { primary: "Software", secondary: ["Analysis"] },
    _files: [
      { key: "HiggsDemoAnalyzer.cc", size: 14943, checksum: "adler32:af301992", uri: "root://eospublic.cern.ch//eos/opendata/cms/software/HiggsExample20112012/HiggsDemoAnalyzer.cc" },
      { key: "mass4l_combine.png", size: 93152, checksum: "adler32:62e0c299", uri: "root://eospublic.cern.ch//eos/opendata/cms/software/HiggsExample20112012/mass4l_combine.png" },
    ],
  },
};
// Large CMS datasets keep their ROOT files inside metadata._file_indices[n].files (checked live on record 24130).
const CERN_DATASET = { id: "24130", created: "2024-12-03T06:48:30.524599+00:00", metadata: {
  recid: 24130, title: "/BTagMu/Run2015D-16Dec2015-v1/MINIAOD",
  _file_indices: [
    { description: "BTagMu MINIAOD dataset file index (1 of 4) for access to data", files: [
      { key: "CMS_Run2015D_BTagMu_MINIAOD_16Dec2015-v1_00000_file_index.json_0", size: 922001552, checksum: "adler32:cc08a89c",
        uri: "root://eospublic.cern.ch//eos/opendata/cms/Run2015D/BTagMu/MINIAOD/16Dec2015-v1/00000/a.root", filename: "a.root" },
      { key: "k2", size: 10, checksum: "adler32:00000001", uri: "root://eospublic.cern.ch//eos/x/b.root" }] },
    { description: "(2 of 4)", files: [{ key: "k3", size: 20, checksum: "adler32:00000002", uri: "root://eospublic.cern.ch//eos/x/c.root" }] },
  ],
} };
const CERN_SEARCH = { hits: { total: 1234, hits: [CERN_RECORD] } };

const HEP_TABLE = {
  name: "Table 1", description: "Differential cross section in pT",
  independent_variables: [{ header: { name: "PT", units: "GEV" }, values: [{ low: 20, high: 30 }, { low: 30, high: 50 }] }],
  dependent_variables: [{
    header: { name: "D(SIG)/DPT", units: "PB/GEV" }, qualifiers: [{ name: "SQRT(S)", value: 13000 }],
    values: [
      { value: 12.5, errors: [{ label: "stat", symerror: 0.4 }, { label: "sys", asymerror: { plus: 0.9, minus: -0.7 } }] },
      { value: "-", errors: [] },
    ],
  }],
};
const HEP_RECORD = { record: { inspire_id: "1419244", title: "Measurement of ...", hepdata_doi: "10.17182/hepdata.73221.v1", collaborations: ["ATLAS"], arxiv_id: "arXiv:1602.07216" } };

const INSPIRE = { hits: { total: 2, hits: [
  { id: "451647", metadata: { control_number: 451647, titles: [{ title: "The Large N limit of superconformal field theories and supergravity" }],
    arxiv_eprints: [{ value: "hep-th/9711200", categories: ["hep-th"] }], dois: [{ value: "10.1023/A:1026654312961" }],
    citation_count: 22000, earliest_date: "1997-11-27", authors: [{ full_name: "Maldacena, Juan Martin" }] } },
] } };

const ZENODO = { hits: { total: 1, hits: [{ id: 3974601, doi: "10.5281/zenodo.3974601", metadata: {
  title: "MakingHEPDataInput", publication_date: "2020-08-05", creators: [{ name: "Watt, Graeme" }], resource_type: { type: "presentation" } },
  files: [{ key: "MakingHEPDataInput.pdf", size: 982900, checksum: "md5:61db6a0ae1b490131f00825e32ff756e", links: { self: "https://zenodo.org/api/records/3974601/files/MakingHEPDataInput.pdf/content" } }] }] } };

const TAP_CSV = 'targetid,z,zerr,spectype,note\r\n39627745944243201,0.512345,1.2e-05,GALAXY,"a, quoted ""note"""\r\n39627745944243202,2.1,,QSO,\r\n';
const TAP_ERROR = `<?xml version="1.0"?><VOTABLE><RESOURCE type="results"><INFO name="QUERY_STATUS" value="ERROR">Table "nope" does not exist</INFO></RESOURCE></VOTABLE>`;

// ---------------------------------------------------------------- helpers
function fakeFetch(handler: (url: string) => { status?: number; raw?: string; body?: unknown; type?: string }) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const r = handler(url);
    return new Response(r.raw ?? JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": r.type ?? "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const fetcher = (impl: typeof fetch) => new PublicDataFetcher({ enabled: true, extraEndpoints: [], fetchImpl: impl });

// ---------------------------------------------------------------- ADQL guard and TAP URL
test("ADQL guard allows one read-only SELECT and refuses everything else", () => {
  assert.equal(checkAdql("SELECT TOP 10 targetid, z FROM desi_dr1.zpix WHERE spectype = 'QSO'"), "SELECT TOP 10 targetid, z FROM desi_dr1.zpix WHERE spectype = 'QSO'");
  assert.doesNotThrow(() => checkAdql("SELECT name FROM t WHERE note = 'drop table x'"), "keywords inside string literals are fine");
  for (const q of [
    "", "DELETE FROM t", "SELECT 1; DROP TABLE t", "SELECT * FROM t -- hidden", "SELECT /* x */ 1",
    "SELECT * INTO new_t FROM t", "WITH x AS (SELECT 1) SELECT * FROM x", "SELECT * FROM tap_upload.mine", "x".repeat(4001),
  ]) assert.throws(() => checkAdql(q), Error, q);
});

test("TAP URLs go to the service's sync endpoint with CSV output and a MAXREC cap", () => {
  const u = new URL(tapUrl({ service: "datalab_desi", query: "SELECT TOP 5 targetid, z FROM desi_dr1.zpix", maxRows: 5 }));
  assert.equal(u.origin + u.pathname, "https://datalab.noirlab.edu/tap/sync");
  assert.equal(u.searchParams.get("LANG"), "ADQL");
  assert.equal(u.searchParams.get("FORMAT"), "csv");
  assert.equal(u.searchParams.get("MAXREC"), "5");
  assert.equal(new URL(tapUrl({ service: "irsa_planck", query: "SELECT * FROM com_pccs2_100" })).pathname, "/TAP/sync");
  assert.equal(new URL(tapUrl({ service: "gaia", query: "SELECT TOP 5 source_id FROM gaiadr3.gaia_source" })).host, "gea.esac.esa.int");
  assert.throws(() => tapUrl({ service: "gaia", query: "SELECT 1", maxRows: 10_000 }));
  assert.throws(() => tapUrl({ service: "nope" as never, query: "SELECT 1" }));
});

test("CSV: quotes, embedded commas and doubled quotes; numbers parsed; blanks null; row cap", () => {
  const t = parseCsvTable(TAP_CSV, 100);
  assert.deepEqual(t.columns, ["targetid", "z", "zerr", "spectype", "note"]);
  assert.equal(t.rows[0].z, 0.512345);
  assert.equal(t.rows[0].zerr, 1.2e-5);
  assert.equal(t.rows[0].note, 'a, quoted "note"');
  assert.equal(t.rows[1].zerr, null);
  assert.equal(t.truncated, false);
  const capped = parseCsvTable(TAP_CSV, 1);
  assert.equal(capped.rows.length, 1);
  assert.equal(capped.truncated, true);
  assert.throws(() => parseCsvTable('a,b\n1,"open', 10), /quoted field/);
  assert.throws(() => parseCsvTable("a,b\n1,2,3\n", 10), /3 fields/);
  // 64-bit IDs (DESI TARGETID, Gaia source_id) exceed 2^53: kept exact as text, never rounded.
  assert.equal(t.rows[0].targetid, "39627745944243201");
  assert.notEqual(String(Number("39627745944243201")), "39627745944243201", "a JS number really would have rounded it");
  assert.equal(parseCsvTable("n\n42\n", 10).rows[0].n, 42);
});

// ---------------------------------------------------------------- archive parsers
test("CERN Open Data: record and search both give records with files listed, not fetched", () => {
  const one = parseCern(CERN_RECORD);
  assert.equal(one.kind, "records");
  if (one.kind !== "records") return;
  assert.equal(one.records[0].doi, "10.7483/OPENDATA.CMS.JKB8.RR42");
  assert.equal(one.records[0].collaboration, "CMS");
  assert.deepEqual(one.records[0].files?.map((f) => [f.name, f.checksum]), [["HiggsDemoAnalyzer.cc", "adler32:af301992"], ["mass4l_combine.png", "adler32:62e0c299"]]);
  const ds = parseCern(CERN_DATASET);
  assert.equal(ds.kind === "records" && ds.records[0].fileCount, 3, "files inside _file_indices are counted");
  assert.equal(ds.kind === "records" && ds.records[0].files?.[0].checksum, "adler32:cc08a89c");
  const many = parseCern(CERN_SEARCH);
  assert.equal(many.kind === "records" && many.total, 1234);
  assert.equal(many.kind === "records" && many.truncated, true);
  assert.equal(parseCern({ unexpected: true }).kind, "raw");
  assert.equal(cernUrl({ recid: 5500 }), "https://opendata.cern.ch/api/records/5500");
  assert.throws(() => cernUrl({}));
});

test("HEPData: a table gives points with bins, qualifiers and stat/sys uncertainties; non-numbers stay raw", () => {
  const p = parseHepData(HEP_TABLE);
  assert.equal(p.kind, "measurements");
  if (p.kind !== "measurements") return;
  assert.equal(p.measurements.length, 2);
  assert.deepEqual(p.measurements[0].x, { "PT [GEV]": "20–30" });
  const y = p.measurements[0].y["D(SIG)/DPT [PB/GEV] (SQRT(S)=13000)"];
  assert.equal(y.value, 12.5);
  assert.deepEqual(y.errors, [{ label: "stat", sym: 0.4, plus: undefined, minus: undefined }, { label: "sys", sym: undefined, plus: 0.9, minus: -0.7 }]);
  assert.equal(p.measurements[1].y["D(SIG)/DPT [PB/GEV] (SQRT(S)=13000)"].raw, "-");
  const rec = parseHepData(HEP_RECORD);
  assert.equal(rec.kind === "records" && rec.records[0].doi, "10.17182/hepdata.73221.v1");
  assert.equal(parseHepData({ something: "else" }).kind, "raw");
  assert.equal(hepdataUrl({ inspireId: 1419244, table: "Table 1", version: 1 }),
    "https://www.hepdata.net/record/ins1419244?format=json&table=Table+1&version=1");
  assert.match(hepdataUrl({ inspireId: 1419244 }), /light=true/);
  assert.throws(() => hepdataUrl({ inspireId: 1, table: "x&format=root" }));
});

test("INSPIRE and Zenodo: literature and records with DOIs, arXiv ids, citations and file checksums", () => {
  const i = parseInspire(INSPIRE);
  assert.equal(i.kind === "records" && i.records[0].arxiv, "hep-th/9711200");
  assert.equal(i.kind === "records" && i.records[0].citationCount, 22000);
  assert.match(inspireUrl({ search: "t ads/cft", sort: "mostcited" }), /^https:\/\/inspirehep\.net\/api\/literature\?q=t\+ads%2Fcft&size=10&sort=mostcited&fields=/);
  const z = parseZenodo(ZENODO);
  assert.equal(z.kind === "records" && z.records[0].doi, "10.5281/zenodo.3974601");
  assert.equal(z.kind === "records" && z.records[0].files?.[0].checksum, "md5:61db6a0ae1b490131f00825e32ff756e");
  assert.equal(zenodoUrl({ recordId: 3974601 }), "https://zenodo.org/api/records/3974601");
});

// ---------------------------------------------------------------- service and boundary
test("TAP over the fetcher: CSV accepted only from TAP hosts; VOTable errors surface as query errors", async () => {
  const f = fetcher(fakeFetch((u) => (u.includes("nope") ? { status: 400, raw: TAP_ERROR, type: "text/xml" } : { raw: TAP_CSV, type: "text/csv;charset=utf-8" })).impl);
  const d = new Civ1Domain();
  const m = d.createMission("desi z");
  const r = await fetchScienceData(d, f, { missionId: m.id, source: "tap", tap: { service: "datalab_desi", query: "SELECT TOP 2 targetid, z FROM desi_dr1.zpix" } });
  assert.equal(r.result.kind, "table");
  assert.equal(r.count, 2);
  assert.equal(d.getMission(m.id)!.evidence[0].status, "HYPOTHESIS");
  await assert.rejects(fetchScienceData(d, f, { missionId: m.id, source: "tap", tap: { service: "irsa_planck", query: "SELECT * FROM nope" } }),
    (e: unknown) => e instanceof PublicDataError && e.code === "SOURCE_QUERY_ERROR" && /does not exist/.test(e.message));
  await assert.rejects(f.get("https://www.hepdata.net/record/ins1?format=csv", "csv"),
    (e: unknown) => e instanceof PublicDataError && e.code === "FORMAT_NOT_ALLOWED");
  await assert.rejects(f.get("https://datalab.noirlab.edu/tap/sync?QUERY=x", "json"),
    (e: unknown) => e instanceof PublicDataError && e.code === "FORMAT_NOT_ALLOWED");
  assert.equal(d.getMission(m.id)!.evidence.length, 1, "failures record nothing");
});

test("records keep DOIs in the evidence; unrecognised shapes come back raw and are labelled", async () => {
  const f = fetcher(fakeFetch((u) => (u.includes("opendata") ? { body: CERN_RECORD } : { body: { surprise: [1, 2, 3] } })).impl);
  const d = new Civ1Domain();
  const m = d.createMission("cms");
  const r = await fetchScienceData(d, f, { missionId: m.id, source: "cern_opendata", cern_opendata: { recid: 5500 } });
  assert.match(d.getMission(m.id)!.evidence[0].description, /10\.7483\/OPENDATA\.CMS\.JKB8\.RR42/);
  assert.ok(r.notes.some((n) => /not downloaded/.test(n)));
  const raw = await fetchScienceData(d, f, { missionId: m.id, source: "zenodo", zenodo: { search: "planck" } });
  assert.equal(raw.result.kind, "raw");
  assert.deepEqual((raw.result as { json?: unknown }).json, { surprise: [1, 2, 3] });
  assert.ok(raw.notes.some((n) => /not recognised/.test(n)));
});

test("MCP tool: listed, off by default, and an ADQL write is refused before any request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "civ1-sci-"));
  try {
    const { impl, calls } = fakeFetch(() => ({ raw: TAP_CSV, type: "text/csv" }));
    const run = async (publicData?: PublicDataFetcher) => {
      const server = createCiv1McpServer(undefined, { audit: new AppendOnlyAudit(join(dir, "audit.jsonl")), publicData });
      const client = new Client({ name: "sci", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      const call = async (name: string, args: Record<string, unknown>) =>
        JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0].text);
      const names = (await client.listTools()).tools.map((t) => t.name);
      const mission = await call("civ1_create_mission", { goal: "sci" });
      const write = await call("civ1_fetch_science_data", { missionId: mission.id, source: "tap", tap: { service: "gaia", query: "DROP TABLE gaiadr3.gaia_source" } });
      const ok = await call("civ1_fetch_science_data", { missionId: mission.id, source: "tap", tap: { service: "gaia", query: "SELECT TOP 2 source_id FROM gaiadr3.gaia_source" } });
      await client.close();
      return { names, write, ok };
    };
    const prev = process.env.CIV1_PUBLIC_DATA_ENABLED;
    delete process.env.CIV1_PUBLIC_DATA_ENABLED;
    const off = await run();
    if (prev !== undefined) process.env.CIV1_PUBLIC_DATA_ENABLED = prev;
    assert.ok(off.names.includes("civ1_fetch_science_data"));
    assert.equal(off.ok.error, "PUBLIC_DATA_DISABLED");
    const on = await run(fetcher(impl));
    assert.equal(on.write.error, "QUERY_INVALID");
    assert.equal(on.ok.count, 2);
    assert.equal(calls.length, 1, "only the SELECT reached the network");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
