import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_GENESIS_HASH, AppendOnlyAudit, auditRecordHash, verifyAuditChain } from "../src/audit.js";
import { canonicalJson } from "../src/bridge/protocol.js";

const withDir = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "civ1-chain-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const lines = (p: string) => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("records are hash-chained from the genesis hash over canonical JSON", () => withDir((dir) => {
  const path = join(dir, "a.jsonl");
  const audit = new AppendOnlyAudit(path);
  const r1 = audit.append("w", "t1", { b: 1, a: 2 }, "success");
  const r2 = audit.append("w", "t2", {}, "success");
  assert.equal(r1.previousHash, AUDIT_GENESIS_HASH);
  assert.equal(r2.previousHash, r1.hash);
  const { hash, ...body } = r1;
  assert.equal(hash, auditRecordHash(body));
  assert.equal(audit.append("w", "t3", { a: 2, b: 1 }, "x").args_hash, r1.args_hash, "argument hash ignores key order");
  assert.deepEqual(verifyAuditChain(readFileSync(path, "utf8")).reasonCodes, []);
}));

test("a restart resumes sequence and head hash; it never reuses a sequence number", () => withDir((dir) => {
  const path = join(dir, "a.jsonl");
  const first = new AppendOnlyAudit(path);
  first.append("w", "t", {}, "PENDING");
  const last = first.append("w", "t", {}, "success");
  const second = new AppendOnlyAudit(path);
  const next = second.append("w", "t", {}, "PENDING");
  assert.equal(next.sequence, last.sequence + 1);
  assert.equal(next.previousHash, last.hash);
  assert.deepEqual(lines(path).map((r) => r.sequence), [1, 2, 3]);
}));

test("verifyAuditChain detects edits, deletions, reordering and torn writes", () => withDir((dir) => {
  const path = join(dir, "a.jsonl");
  const audit = new AppendOnlyAudit(path);
  for (let i = 0; i < 4; i++) audit.append("w", `t${i}`, { i }, "success");
  const good = readFileSync(path, "utf8");
  const rows = good.trim().split("\n");
  const edited = rows.map((l, i) => (i === 1 ? l.replace('"success"', '"denied"') : l)).join("\n") + "\n";
  assert.ok(verifyAuditChain(edited).reasonCodes.includes("hash_mismatch:2"));
  const deleted = [rows[0], rows[2], rows[3]].join("\n") + "\n";
  const d = verifyAuditChain(deleted).reasonCodes;
  assert.ok(d.includes("sequence_gap:2") && d.includes("broken_link:2"));
  const swapped = [rows[0], rows[2], rows[1], rows[3]].join("\n") + "\n";
  assert.ok(!verifyAuditChain(swapped).valid);
  assert.ok(verifyAuditChain(good + '{"at":"x"').reasonCodes.includes("torn_final_line"));
}));

test("a checkpoint stored elsewhere detects truncation and rollback", () => withDir((dir) => {
  const path = join(dir, "a.jsonl");
  const audit = new AppendOnlyAudit(path);
  audit.append("w", "a", {}, "success");
  audit.append("w", "b", {}, "success");
  const cp = audit.checkpoint();
  audit.append("w", "c", {}, "success");
  const full = readFileSync(path, "utf8");
  assert.deepEqual(verifyAuditChain(full, cp).reasonCodes, [], "later records after the checkpoint are fine");
  const truncated = full.trim().split("\n").slice(0, 1).join("\n") + "\n";
  assert.deepEqual(verifyAuditChain(truncated).reasonCodes, [], "without a checkpoint, a clean truncation looks valid");
  assert.ok(verifyAuditChain(truncated, cp).reasonCodes.includes("truncated_before_checkpoint"));
  assert.ok(verifyAuditChain(full, { ...cp, hash: "f".repeat(64) }).reasonCodes.includes("checkpoint_mismatch"));
}));

test("startup fails closed on a tampered log, and accepts legacy records only before the chain", () => withDir((dir) => {
  const path = join(dir, "a.jsonl");
  const audit = new AppendOnlyAudit(path);
  audit.append("w", "a", {}, "success");
  writeFileSync(path, readFileSync(path, "utf8").replace('"success"', '"denied"'));
  assert.throws(() => new AppendOnlyAudit(path), /failed verification: hash_mismatch:1/);

  const legacyPath = join(dir, "legacy.jsonl");
  writeFileSync(legacyPath, [
    { at: "2026-11-20T00:00:00Z", sequence: 1, who: "w", tool: "t", args_hash: "a".repeat(64), result_class: "PENDING" },
    { at: "2026-11-20T00:00:01Z", sequence: 2, who: "w", tool: "t", args_hash: "a".repeat(64), result_class: "success" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const resumed = new AppendOnlyAudit(legacyPath);
  const r = resumed.append("w", "t", {}, "PENDING");
  assert.equal(r.sequence, 3, "continues after the highest legacy sequence");
  const report = resumed.verify();
  assert.equal(report.legacyRecords, 2);
  assert.equal(report.records, 1);
  appendFileSync(legacyPath, JSON.stringify({ at: "x", sequence: 9, who: "w", tool: "t", args_hash: "a", result_class: "x" }) + "\n");
  assert.ok(verifyAuditChain(readFileSync(legacyPath, "utf8")).reasonCodes.includes("legacy_record_after_chain:4"));
}));

test("canonicalJson is the only serialisation used for hashes (key order does not change them)", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
});
