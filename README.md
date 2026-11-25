# Civilisation.One MCP

A minimal, local-first Model Context Protocol (MCP) server for Civilisation.One / VIREÁX workflows.

**Status:** prototype scaffold. It is not a deployed swarm controller, an authority system, or a production persistence layer.

## Tools
- `civ1_system_status` — inspect prototype capabilities and limitations.
- `civ1_create_mission` — create an in-memory mission.
- `civ1_list_missions` / `civ1_get_mission` — inspect mission state.
- `civ1_record_evidence` — attach a provenance-labelled evidence record.
- `civ1_record_objection` — preserve criticism and unresolved disagreement.
- `civ1_set_gate_status` — record a declared gate result; it does not prove the gate passed.
- `civ1_import_external_source` — one-way import of an outside source's claims (see below).
- `civ1_fetch_public_data` — read-only fetch from a public data API into a mission (off by default; see below).
- `civ1_fetch_science_data` — read-only query of a scientific archive (CERN, HEPData, INSPIRE, Zenodo, TAP for DESI / Planck / Gaia) into a mission (off by default).
- `civ1_close_mission` — close a mission to further record additions.
- `civ1_bridge_validate_temporal_state` — structural validation of a proposed NuN temporal-state envelope; not authentication or model verification.
- `civ1_open_draft_pr` — fail-closed draft PR capability for Civilisation-one/MCP; denied unless a trusted host injects an authenticated actor and authorizer.

Mission state is in memory and disappears when the process exits. Tool calls are also appended to a local JSONL audit file (default `.data/mcp-audit.jsonl`) with argument hashes and result classes, not raw arguments or results. Each record is hash-chained (SHA-256 over canonical JSON, linked to the previous record); on start the server verifies the log, refuses one that fails, and resumes the sequence. It is tamper-evident, not tamper-proof: whoever controls the file can rewrite it wholesale, and truncation is only caught against a `checkpoint()` stored somewhere else. It is single-writer: not safe for several processes. The only external calls are the opt-in, read-only public and scientific data fetches described below. No repository writes, memory commits, publishing, or consequential actions are performed.

## Requirements and commands
Node.js 20+ and npm. The `civ-intelligence-layer` Git submodule must be initialised; it is pinned in `.gitmodules` and is required for the canonical contract types.

```bash
git submodule update --init
npm ci                # requires package-lock.json; use npm install only if you need to regenerate it
npm run build
npm test
npm run smoke   # starts dist/src/index.js over stdio, as a client would, and calls the tools
npm start
```

MCP uses stdio. Protocol messages use stdout; diagnostic logs go to stderr.

## Example MCP client configuration
Use an absolute path appropriate to your machine:

```json
{
  "mcpServers": {
    "civilisation-one": {
      "command": "node",
      "args": ["/absolute/path/to/MCP/dist/src/index.js"]
    }
  }
}
```

## Importing outside sources

`civ1_import_external_source` records another project's claims in a mission without trusting them:

- Nothing is fetched from the source and nothing is sent back. The caller supplies the claims and a snapshot id (for example a commit).
- Status is capped: **HYPOTHESIS** if the claim names the test that would settle it, otherwise **SPECULATION**. The source's own status ("PROVEN", "VERIFIED") is kept as `assertedStatus` and never applied.
- Language that asserts authority, verification, priority or a revenue/royalty entitlement (`[ROOT]`, "authorised", "50/50 split", "proven") is recorded as an unresolved objection on that claim. Text can't grant any of these.
- Raising a claim above HYPOTHESIS needs evidence checked inside Civilisation.One, recorded separately.

[`examples/nun-core-96a7dcf.json`](examples/nun-core-96a7dcf.json) is a snapshot of the NuN claims in `github.com/bis3946/core` at commit `96a7dcf`, ready to pass as the tool's arguments (with a `missionId`). A review of that repository on 30 Oct 2026 found that `quantum_priority_hash.txt` does match `nun_quantum_proof.lean`, that the Lean theorem's conclusion is `True` (so it holds whatever the assumptions), that room temperature and the VFE bound are assumed rather than derived, and that the repository has no Lean toolchain or build configuration. Record those as evidence or objections against the imported claims.

There is no live connection to NuN or any other outside system. Before one is considered, this server needs the authentication, per-tool authorisation and durable audit listed under Security limitations.

## Public data access

`civ1_fetch_public_data` pulls statistics from public APIs into a mission. It is **off unless the host sets `CIV1_PUBLIC_DATA_ENABLED=1`**.

| `source` | API | Query |
|---|---|---|
| `worldbank` | World Bank Indicators API v2 (`api.worldbank.org/v2/`) | `country` (ISO2/ISO3, `;`-separated, or `all`), `indicator` (e.g. `SP.POP.TOTL`), optional `startYear`/`endYear` |
| `oecd` | OECD Data Explorer SDMX (`sdmx.oecd.org/public/rest/data/`) | `agency`, `dataflow`, optional `key`, `startPeriod`, `endPeriod` |
| `eurostat` | Eurostat Statistics API, JSON-stat 2.0 (`ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/`) | `dataset`, optional `filters` ({dimension: [codes]}), `lastTimePeriod` |
| `unsdg` | UN SDG API (`unstats.un.org/SDGAPI/v1/sdg/`) | `seriesCode`, `areaCodes` (M49), optional `timePeriods` |
| `allowlisted_json` | Any endpoint in `CIV1_PUBLIC_DATA_ALLOWLIST` | `url`; the body is returned unparsed |

What a fetch produces:

- **One evidence item per fetch**, capped at **HYPOTHESIS** like any outside source, with the URL, retrieval time and the SHA-256 of the exact response bytes in its reference. Re-fetching and comparing the hash shows what the source said at that time; it does not show the data are true.
- **Observations** in one shape (`area`, `period`, `value`, `unit`, `flag`, `dims`). The source's status flag (estimate, provisional, projection…) is kept. Values that are not plain numbers (`">95"`, `NaN`) come back as `value: null` with `raw` kept; they are never coerced.
- `trust: "UNVERIFIED"` and `dataClass: "source_reported"`. Civilisation.One did not observe these values. Do not feed them to CivScore or treat them as observed data without independent verification (C1-DAP-001 / IEV-001).

Boundary (all fail closed): HTTPS on port 443 only; exact host plus path prefix on the allowlist (no subdomains); GET only, with no cookies or credentials and only `Accept` and `User-Agent` headers; redirects refused; 5 MB and 15 s caps; JSON only; URLs that look like they carry a key or token refused; a per-host hourly budget (50 for OECD, whose API allows 60 downloads an hour, otherwise 120). `CIV1_PUBLIC_DATA_ALLOWLIST` takes comma-separated `host/path/prefix/` entries; IP literals, `localhost`, `.local` and `.internal` names are rejected. Every call is audited like any other tool call (arguments hashed, never stored).

The response parsers were written against each API's documented format and tested with fixtures; run a live fetch against each source before relying on them.

## Scientific archives

`civ1_fetch_science_data` uses the same switch, fetcher and boundary as public data.

| `source` | Archive | What you get |
|---|---|---|
| `cern_opendata` | CERN Open Data portal (`opendata.cern.ch/api/records`) | Records by `recid` or `search`: title, DOI, experiment, and the file list with sizes and checksums |
| `hepdata` | HEPData (`www.hepdata.net/record/ins<id>`) | With `table`: data points with bins, qualifiers and stat/sys uncertainties. Without: the record (title, DOI, collaboration) |
| `inspire` | INSPIRE-HEP (`inspirehep.net/api/literature`) | Literature search: titles, arXiv ids, DOIs, citation counts, authors |
| `zenodo` | Zenodo (`zenodo.org/api/records`) | Records by id or search, with file checksums |
| `tap` / `datalab_desi` | NOIRLab Astro Data Lab TAP | ADQL over DESI catalogues (e.g. `desi_dr1.zpix`) |
| `tap` / `irsa_planck` | NASA/IPAC IRSA TAP | ADQL over Planck catalogues (e.g. `com_pccs2_100`) |
| `tap` / `gaia` | ESA Gaia Archive TAP | ADQL over Gaia (e.g. `gaiadr3.gaia_source`) |

- **Bulk files are never downloaded.** CERN datasets, Planck maps and DESI spectra are FITS or ROOT files from megabytes to terabytes. The tool lists them with size, checksum and location so they can be fetched in an analysis environment and checked against the checksum.
- **TAP queries** must be a single `SELECT`. Statements that write, `INTO`, `WITH`, comments, `;` and table uploads are refused before any request. Results come back as CSV, capped with `MAXREC` (default 1000, at most 5000); a full result needs an asynchronous TAP job, which this tool does not run. 64-bit IDs (DESI `TARGETID`, Gaia `source_id`) stay exact as text.
- **Unrecognised responses are returned raw**, labelled as such, rather than guessed at.
- Each query is one evidence item, capped at **HYPOTHESIS**, with the archive's DOIs, the URL, the retrieval time and the SHA-256 of the response. Published values carry the collaboration's own systematics; check them against an independent result before relying on them.

Not covered yet: the ESA Planck Legacy Archive's own interface (Planck maps and chains are files; the catalogues are available through IRSA), SPARCL spectra (its API takes POST requests and this fetcher is GET-only), arXiv (it returns Atom XML), and NASA ADS (needs an API token).

## Design invariants
1. Model output is not verified evidence.
2. A gate status is a record, not proof by itself.
3. Objections are preserved rather than silently discarded.
4. Agents cannot grant themselves authority.
5. Memory writes, publication, deployment and repository mutations are outside this prototype.
6. Missing data is not silently treated as success.

Evidence statuses: `ESTABLISHED`, `SUPPORTED`, `HYPOTHESIS`, `SPECULATION`, `UNKNOWN`, `REFUTED`.

Gate statuses: `PASS`, `FAIL`, `BLOCKED`, `INCONCLUSIVE`.

## Security limitations
- No authentication or authorization.
- Local append-only JSONL audit (default `.data/mcp-audit.jsonl`) is hash-chained and verified on start, and sequence numbers resume across restarts. It is single-writer, and detecting truncation needs a checkpoint kept outside the log. Records written before chaining are accepted only before the first chained record.
- No source authenticity verification.
- No rate limits or multi-user isolation.
- Do not expose this as a network service without security hardening.
- Never put secrets in source files.

## Roadmap
1. Shared versioned contracts.
2. Durable append-only audit storage and integrity checks.
3. Identity and per-tool authorization.
4. Source provenance and citation verification.
5. Independent critic/verifier adapters and reproducible evaluation.
6. MCP client integration tests, threat model and release workflow.

No license has been selected. All rights are reserved unless the repository owner adds a license.


## CV1-SEC-001 security integration

The cross-repository capability contract and MCP hardening requirements are documented in [CV1-SEC-001](docs/CV1-SEC-001.md). This is a design/integration milestone, not a claim that this prototype is now authenticated or production-secure. The current stdio server remains unauthenticated and in-memory; do not expose it as a network service. The future T3MP3ST adapter must verify exact scope and approval independently before any tool execution.
