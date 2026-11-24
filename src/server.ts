import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Civ1Domain, EVIDENCE_STATUSES, GATE_STATUSES } from "./domain.js";
import { validateNuNTemporalState } from "./bridge/state-validator.js";
import { AppendOnlyAudit, type TransportActor } from "./audit.js";
import type { DraftPrAuthorizer, DraftPrExecutor, DraftPrRequest } from "./draft-pr.js";

const missionId = z.string().regex(/^CIV1-M-\d{5}$/, "Expected mission ID like CIV1-M-00001");
const shortText = z.string().trim().min(1).max(4000);
const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const noSecretLike = (value: string) =>
  !/(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{15,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\\s+|\b(password|token|secret)\\s*[:=])/i.test(value);

export interface Civ1McpServerOptions {
  audit?: AppendOnlyAudit;
  /** Must derive identity from a trusted transport/host context, never tool arguments. */
  resolveTransportActor?: (extra: unknown) => TransportActor | null;
  authorizeDraftPr?: DraftPrAuthorizer;
  executeDraftPr?: DraftPrExecutor;
}
export function createCiv1McpServer(domain = new Civ1Domain(), options: Civ1McpServerOptions = {}) {
  const server = new McpServer({ name: "civilisation-one-mcp", version: "0.1.0" });
  const audit = options.audit ?? new AppendOnlyAudit();
  const registerTool = (name: string, description: string, schema: any, handler: (args: any, extra?: any) => Promise<any>) => {
    (server as any).tool(name, description, schema, async (args: any, extra: any) => {
      // Preflight before any handler can mutate state or perform an external action.
      audit.assertWritable();
      let actor: TransportActor | null = null;
      try { actor = options.resolveTransportActor?.(extra) ?? null; }
      catch { actor = null; }
      const who = actor?.authenticated === true && actor.subject.trim()
        ? actor.subject.slice(0, 256) : "stdio:unauthenticated";
      // Fsynced intent record before any handler mutation or external action.
      audit.append(who, name, args, "PENDING");
      try {
        const response = await handler(args, extra);
        let resultClass = "success";
        const text = response?.content?.find((item: any) => item.type === "text")?.text;
        if (typeof text === "string") {
          try {
            const parsed = JSON.parse(text);
            if (parsed?.error) resultClass = String(parsed.error).slice(0, 100);
            else if (name === "civ1_record_objection") resultClass = "objection_recorded";
            else if (name === "civ1_close_mission") resultClass = "mission_closed";
            else if (name === "civ1_open_draft_pr") resultClass = "draft_pr_result";
          } catch { /* classify opaque tool output as success without retaining it */ }
        }
        audit.append(who, name, args, resultClass);
        return response;
      } catch (error) {
        audit.append(who, name, args, "handler_error");
        throw error;
      }
    });
  };

  registerTool("civ1_bridge_validate_temporal_state", "Validate a proposed NuN temporal-state envelope structurally. This does not authenticate the sender or verify the model equations.",
    { state: z.unknown() }, async ({ state }) => {
      try { return result({ valid: true, trust: "UNVERIFIED", state: validateNuNTemporalState(state) }); }
      catch (error) { return result({ valid: false, trust: "UNVERIFIED", error: error instanceof Error ? error.message : String(error) }); }
    });

  registerTool("civ1_system_status", "Return capabilities and limitations; no deployment or production-readiness claim.", {}, async () =>
    result({ name: "Civilisation.One MCP", version: "0.1.0", status: "PROTOTYPE", transport: "stdio",
      persistence: "in-memory-missions, local-jsonl-audit",
      capabilities: ["missions", "evidence-records", "objection-ledger", "gate-status-records", "audit-events",
        "external-source-import", "local-jsonl-audit", "bridge-temporal-state-validation", "fail-closed-draft-pr"],
      limitations: ["no-authentication", "audit-not-tamper-evident-or-multi-process-safe", "no-source-verification", "no-external-actions"] }));

  registerTool("civ1_create_mission", "Create a local in-memory mission. This does not authorize external actions.",
    { goal: shortText, constraints: z.array(z.string().trim().min(1).max(1000)).max(50).default([]) },
    async ({ goal, constraints }) => result(domain.createMission(goal, constraints)));

  registerTool("civ1_list_missions", "List missions created during this server process.", {}, async () => result(domain.listMissions()));

  registerTool("civ1_get_mission", "Return mission, evidence, objections, gate records and audit events.",
    { missionId }, async ({ missionId: id }) => result(domain.getMission(id) ?? { error: "MISSION_NOT_FOUND", missionId: id }));

  registerTool("civ1_record_evidence", "Record an evidence item; this does not verify its source or truth.",
    { missionId, reference: z.string().trim().min(1).max(500), description: shortText,
      status: z.enum(EVIDENCE_STATUSES), sourceUri: z.string().url().max(2000).optional() },
    async ({ missionId: id, reference, description, status, sourceUri }) => {
      try { return result(domain.recordEvidence(id, { reference, description, status, sourceUri })); }
      catch (error) { return result({ error: "EVIDENCE_RECORD_FAILED", message: error instanceof Error ? error.message : String(error) }); }
    });

  registerTool("civ1_record_objection", "Record criticism or unresolved disagreement without silently resolving it.",
    { missionId, statement: shortText, raisedBy: z.string().trim().min(1).max(200) },
    async ({ missionId: id, statement, raisedBy }) => {
      try { return result(domain.recordObjection(id, statement, raisedBy)); }
      catch (error) { return result({ error: "OBJECTION_RECORD_FAILED", message: error instanceof Error ? error.message : String(error) }); }
    });

  registerTool("civ1_set_gate_status", "Record a declared gate result; this does not independently verify it.",
    { missionId, gate: z.string().trim().min(1).max(100), status: z.enum(GATE_STATUSES), rationale: shortText },
    async ({ missionId: id, gate, status, rationale }) => {
      try { return result(domain.setGateStatus(id, gate, status, rationale)); }
      catch (error) { return result({ error: "GATE_RECORD_FAILED", message: error instanceof Error ? error.message : String(error) }); }
    });

  registerTool("civ1_import_external_source",
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

  registerTool("civ1_close_mission", "Close a mission to further record additions. Internal state change only.",
    { missionId }, async ({ missionId: id }) => {
      try { return result(domain.closeMission(id)); }
      catch (error) { return result({ error: "MISSION_CLOSE_FAILED", message: error instanceof Error ? error.message : String(error) }); }
    });

  registerTool("civ1_open_draft_pr",
    "Open a draft pull request in Civilisation-one/MCP only. Requires authenticated transport identity and independent host authorization. Never merges, publishes, deploys, accepts secrets, or grants authority.",
    { title: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9 .:_/-]*$/).refine(noSecretLike),
      head: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/).refine(noSecretLike), repository: z.literal("Civilisation-one/MCP").default("Civilisation-one/MCP"),
      base: z.literal("main").default("main") },
    async ({ title, head, repository, base }, extra) => {
      let actor: TransportActor | null = null;
      try { actor = options.resolveTransportActor?.(extra) ?? null; } catch { actor = null; }
      if (!actor || actor.authenticated !== true || !actor.subject.trim())
        return result({ error: "AUTHENTICATED_TRANSPORT_REQUIRED", state: "DENIED" });
      const request: DraftPrRequest = { repository, title, body: "MCP draft PR opened under host authorization; human merge required.", head, base };
      if (!options.authorizeDraftPr || !options.executeDraftPr)
        return result({ error: "DRAFT_PR_CAPABILITY_NOT_CONFIGURED", state: "DENIED" });
      if (!await options.authorizeDraftPr(actor, request))
        return result({ error: "DRAFT_PR_AUTHORIZATION_DENIED", state: "DENIED" });
      const receipt = await options.executeDraftPr(request, actor);
      if (receipt.state !== "open" || receipt.draft !== true || receipt.merged !== false)
        return result({ error: "DRAFT_PR_RECEIPT_INVALID", state: "FAILED" });
      return result(receipt);
    });

  return server;
}
