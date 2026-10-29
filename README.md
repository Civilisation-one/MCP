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
- `civ1_close_mission` — close a mission to further record additions.

All data is in memory and disappears when the process exits. No external API calls, repository writes, memory commits, publishing, or consequential actions are performed.

## Requirements and commands
Node.js 20+ and npm.

```bash
npm install
npm run build
npm test
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
