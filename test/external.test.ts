import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Civ1Domain, authorityFlags, externalStatus } from "../src/domain.js";
import { createCiv1McpServer } from "../src/server.js";

const nun = JSON.parse(readFileSync(fileURLToPath(new URL("../examples/nun-core-96a7dcf.json", import.meta.url)), "utf8"));

test("external claims are capped: HYPOTHESIS with a named test, SPECULATION without", () => {
  assert.equal(externalStatus({ statement: "x", reference: "r", test: "measure y" }), "HYPOTHESIS");
  assert.equal(externalStatus({ statement: "x", reference: "r", test: "  " }), "SPECULATION");
  assert.equal(externalStatus({ statement: "x", reference: "r", assertedStatus: "ESTABLISHED" }), "SPECULATION");
});

test("authority, verification and royalty language is flagged", () => {
  assert.deepEqual(authorityFlags("plain description of a model"), []);
  const flags = authorityFlags("Commercial License: 50/50 Revenue Split verified ([ROOT] @bis3946)");
  for (const f of ["claims root authority", "claims a revenue or royalty entitlement", "claims to be verified or proven"]) {
    assert.ok(flags.includes(f), f);
  }
});

test("NuN snapshot imports with nothing above HYPOTHESIS and every authority claim objected to", () => {
  const d = new Civ1Domain();
  const m = d.createMission("Assess NuN claims");
  const r = d.importExternalSource(m.id, nun);
  assert.equal(r.imported.length, 5);
  assert.deepEqual(r.imported.map((i) => i.status), ["HYPOTHESIS", "HYPOTHESIS", "SPECULATION", "HYPOTHESIS", "SPECULATION"]);
  assert.deepEqual(r.imported.map((i) => i.downgraded), [true, true, true, false, true]);
  const after = d.getMission(m.id)!;
  assert.ok(after.evidence.every((e) => !["ESTABLISHED", "SUPPORTED"].includes(e.status)));
  assert.ok(after.evidence.every((e) => e.description.includes("not verified by Civilisation.One")));
  const flagged = new Set(after.objections.map((o) => o.statement.split(" ")[0]));
  for (const id of ["E-1", "E-2", "E-3", "E-5"]) assert.ok(flagged.has(id), `${id} should carry an objection`);
  assert.ok(!flagged.has("E-4"), "a plain hash claim is not an authority claim");
  assert.equal(after.audit.at(-1)?.type, "EXTERNAL_SOURCE_IMPORTED");
  assert.ok(after.objections.every((o) => !o.resolved));
});

test("import refuses closed missions and empty claim lists", () => {
  const d = new Civ1Domain();
  const m = d.createMission("x");
  assert.throws(() => d.importExternalSource(m.id, { ...nun, claims: [] }), /at least one claim/);
  d.closeMission(m.id);
  assert.throws(() => d.importExternalSource(m.id, nun), /closed/);
});

test("over MCP: the tool is listed and imports the NuN snapshot", async () => {
  const server = createCiv1McpServer();
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("civ1_import_external_source"));
  const created = JSON.parse((await client.callTool({ name: "civ1_create_mission", arguments: { goal: "NuN review" } }) as any).content[0].text);
  const out = JSON.parse((await client.callTool({ name: "civ1_import_external_source",
    arguments: { missionId: created.id, ...nun } }) as any).content[0].text);
  assert.equal(out.imported.length, 5);
  assert.equal(out.objections.length >= 4, true);
  const bad = JSON.parse((await client.callTool({ name: "civ1_import_external_source",
    arguments: { missionId: "CIV1-M-99999", ...nun } }) as any).content[0].text);
  assert.equal(bad.error, "EXTERNAL_IMPORT_FAILED");
  await client.close();
});

test("NuN b0f6938 snapshot: every claim names a test, so all arrive capped at HYPOTHESIS", () => {
  const snap = JSON.parse(readFileSync(fileURLToPath(new URL("../examples/nun-core-b0f6938.json", import.meta.url)), "utf8"));
  const d = new Civ1Domain();
  const m = d.createMission("Review NuN b0f6938");
  const r = d.importExternalSource(m.id, snap);
  assert.deepEqual(r.imported.map((i) => i.status), ["HYPOTHESIS", "HYPOTHESIS", "HYPOTHESIS", "HYPOTHESIS"]);
  assert.ok(r.imported.every((i) => i.downgraded && i.assertedStatus === "VERIFIED"));
  assert.ok(r.objections.length >= 4, "each VERIFIED assertion is objected to until checked here");
});
