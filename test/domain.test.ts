import test from "node:test";
import assert from "node:assert/strict";
import { Civ1Domain } from "../src/domain.js";

test("creates mission and records ordered audit events", () => {
  const domain = new Civ1Domain();
  const mission = domain.createMission("Test a hypothesis", ["No circular reasoning"]);
  assert.equal(mission.id, "CIV1-M-00001");
  assert.equal(mission.status, "OPEN");
  assert.equal(mission.audit.length, 1);
  assert.equal(mission.audit[0]?.type, "MISSION_CREATED");
});

test("records evidence and objections without asserting truth", () => {
  const domain = new Civ1Domain();
  const mission = domain.createMission("Assess a claim");
  const evidence = domain.recordEvidence(mission.id, { reference: "DOC-001", description: "A source to review", status: "UNKNOWN" });
  const objection = domain.recordObjection(mission.id, "Source is not independently verified", "critic-agent");
  assert.equal(evidence.status, "UNKNOWN");
  assert.equal(objection.resolved, false);
  assert.equal(domain.getMission(mission.id)?.audit.length, 3);
});

test("closed mission rejects further mutations", () => {
  const domain = new Civ1Domain();
  const mission = domain.createMission("Close-state test");
  domain.closeMission(mission.id);
  assert.throws(() => domain.recordObjection(mission.id, "Late objection", "tester"), /Mission is closed/);
});

test("unknown mission is not silently created", () => {
  const domain = new Civ1Domain();
  assert.equal(domain.getMission("CIV1-M-99999"), undefined);
  assert.throws(() => domain.recordObjection("CIV1-M-99999", "x", "tester"), /Mission not found/);
});
