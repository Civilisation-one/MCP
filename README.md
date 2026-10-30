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
- `civ1_close_mission` — close a mission to further record additions.

All data is in memory and disappears when the process exits. No external API calls, repository writes, memory commits, publishing, or consequential actions are performed.

## Requirements and commands
Node.js 20+ and npm.

```bash
npm install
npm run build
npm test
npm run smoke   # starts dist/index.js over stdio, as a client would, and calls the tools
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
      "args": ["/absolute/path/to/MCP/dist/index.js"]
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
- No durable or tamper-evident audit.
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
