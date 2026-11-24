import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AppendOnlyAudit } from "../src/audit.js";
import { createCiv1McpServer } from "../src/server.js";

type ToolTextResult = { content: Array<{ type?: string; text: string }> };

function toolText(response: unknown): string {
  const typed = response as ToolTextResult;
  const text = typed.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("tool response missing text content");
  return text;
}

test("tool calls append actor, tool, argument hash and result class without raw arguments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "civ1-audit-"));
  try {
    const audit = new AppendOnlyAudit(join(dir, "audit.jsonl"));
    const server = createCiv1McpServer(undefined, { audit });
    const client = new Client({ name: "audit-test", version: "0" });
    const [a,b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const mission = JSON.parse(toolText(await client.callTool({ name: "civ1_create_mission", arguments: { goal: "audit test" } })));
    await client.callTool({ name: "civ1_record_objection", arguments: {
      missionId: mission.id, statement: "Persist this objection", raisedBy: "test-agent", actorId: "model-minted-admin"
    }});
    await client.close();
    const lines = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x));
    const objectionIntent = lines.find((x) => x.tool === "civ1_record_objection" && x.result_class === "PENDING");
    const objection = lines.find((x) => x.tool === "civ1_record_objection" && x.result_class === "objection_recorded");
    assert.ok(objectionIntent, "expected a PENDING intent record for civ1_record_objection");
    assert.ok(objection, "expected a completion record with result_class objection_recorded");
    assert.ok(objectionIntent.sequence < objection.sequence);
    assert.equal(objection.who, "stdio:unauthenticated");
    assert.match(objection.args_hash, /^[a-f0-9]{64}$/);
    assert.equal(objection.result_class, "objection_recorded");
    assert.ok(!JSON.stringify(lines).includes("Persist this objection"));
    assert.ok(lines.every((x) => x.sequence > 0 && x.who && x.tool && x.args_hash && x.result_class));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("draft PR tool is present but fails closed without authenticated transport", async () => {
  const dir = mkdtempSync(join(tmpdir(), "civ1-draft-"));
  try {
    const server = createCiv1McpServer(undefined, { audit: new AppendOnlyAudit(join(dir, "audit.jsonl")) });
    const client = new Client({ name: "draft-test", version: "0" });
    const [a,b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(names.includes("civ1_open_draft_pr"));
    const draftTool = (await client.listTools()).tools.find((x) => x.name === "civ1_open_draft_pr")!;
    assert.deepEqual(Object.keys((draftTool.inputSchema as any).properties).sort(), ["base", "head", "repository", "title"]);
    const response = await client.callTool({ name: "civ1_open_draft_pr", arguments: {
      title: "test", body: "test", head: "feature/test", repository: "Civilisation-one/MCP", base: "main"
    }});
    const data = JSON.parse(toolText(response));
    assert.equal(data.error, "AUTHENTICATED_TRANSPORT_REQUIRED");
    await client.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
