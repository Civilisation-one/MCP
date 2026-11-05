import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Civ1Domain, EVIDENCE_STATUSES, GATE_STATUSES } from "./domain.js";
import { validateNuNTemporalState } from "./bridge/state-validator.js";

const missionId = z.string().regex(/^CIV1-M-\d{5}$/, "Expected mission ID like CIV1-M-00001");
const shortText = z.string().trim().min(1).max(4000);
const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export function createCiv1McpServer(domain = new Civ1Domain()) {
  const server = new McpServer({ name: "civilisation-one-mcp", version: "0.1.0" });

  server.tool("civ1_bridge_validate_temporal_state", "Validate a proposed NuN temporal-state envelope structurally. This does not authenticate the sender or verify the model equations.",
    { state: z.unknown() }, async ({ state }) => {
      try { return result({ valid: true, trust: "UNVERIFIED", state: validateNuNTemporalState(state) }); }
      catch (error) { return result({ valid: false, trust: "UNVERIFIED", error: error instanceof Error ? error.message : String(error) }); }
    });

  server.tool("civ1_system_status", "Return capabilities and limitations; no deployment or production-readiness claim.", {}, async () =>
    result({ name: "Civilisation.One MCP", version: "0.1.0", status: "PROTOTYPE", transport: "stdio",
      persistence: "in-memory", capabilities: ["missions", "evidence-records", "objection-ledger", "gate-status-records", "audit-events",
        "external-source-import"],
      limitations: ["no-authentication", "no-durable-storage", "no-source-verification", "no-external-actions"] }));

  server.tool("civ1_create_mission", "Create a local in-memory mission. This does not authorize external actions.",
    { goal: shortText, constraints: z.array(z.string().trim().min(1).max(1000)).max(50).default([]) },
    async ({ goal, constraints }) => result(domain.createMission(goal, constraints)));

  server.tool("civ1_list_missions", "List missions created during this server process.", {}, async () => result(domain.listMissions()));

  server.tool("civ1_get_mission", "Return mission, evidence, objections, gate records and audit events.",
    { missionId }, async ({ missionId: id }) => result(domain.getMission(id) ?? { error: "MISSION_NOT_FOUND", missionId: id }));

  server.tool("civ1_record_evidence", "Record an evidence item; this does not verify its source or truth.",
    { missionId, reference: z.string().trim().min(1).max(500), description: shortText,
      status: z.enum(EVIDENCE_STATUSES), sourceUri: z.string().url().max(2000).optional() },
    async ({ missionId: id, reference, description, status, sourceUri }) => {
      try { return result(domain.recordEvidence(id, { reference, description, status, sourceUri })); }
      catch (error) { return result({ error: "EVIDENCE_RECORD_FAILED", message: error instanceof Error ? error.message : String(error) }); }
    });

  server.tool("civ1_record_objection", "Record criticism or unresolved disagreement without silently resolving it.",
    { missionId, statement: shortText, raisedBy: z.string().trim().min(1).max(200) },
    async ({ missionId: id, statement, raisedBy }) => {
      try { return result(domain.recordObjection(id, statement, raisedBy)); }
      catch (error) { return result({ error: "OBJECTION_RECORD_FAILED", message: error instanceof Error ? error.message : String(error) }); }
    });

  server.tool("civ1_set_gate_status", "Record a declared gate result; this does not independently verify it.",
    { missionId, gate: z.string().trim().min(1).max(100), status: z.enum(GATE_STATUSES), rationale: shortText },
    async ({ missionId: id, gate, status, rationale }) => {
      try { return result(domain.setGateStatus(id, gate, status, rationale)); }
      catch (error) { return result({ error: "GATE_RECORD_FAILED", message: error instanceof Error ? error.message : String(error) }); }
    });

  server.tool("civ1_import_external_source",
    "One-way import of an outside source's claims into a mission. Statuses are capped at HYPOTHESIS (SPECULATION " +
    "without a named test); the source's own status is recorded, not applied; authority, verification and " +
    "royalty language is recorded as objections. Nothing is fetched from or sent to the source.",
    { missionId, source: z.string().trim().min(1).max(200), snapshot: z.string().trim().min(1).max(200),
      sourceUri: z.string().url().max(2000).optional(),
      claims: z.array(z.object({
        statement: shortText, reference: z.string().trim().min(1).max(500),
        sourceUri: z.string().url().max(2000).optional(), assertedStatus: z.string().trim().max(100).optional(),
        test: z.string().trim().max(2000).optional(),
      })).min(1).max(100) },
    async ({ missionId: id, ...input }) => {
      try { return result(domain.importExternalSource(id, input)); }
      catch (error) { return result({ error: "EXTERNAL_IMPORT_FAILED", message: error instanceof Error ? error.message : String(error) }); }
    });

  server.tool("civ1_close_mission", "Close a mission to further record additions. Internal state change only.",
    { missionId }, async ({ missionId: id }) => {
      try { return result(domain.closeMission(id)); }
      catch (error) { return result({ error: "MISSION_CLOSE_FAILED", message: error instanceof Error ? error.message : String(error) }); }
    });

  return server;
}
