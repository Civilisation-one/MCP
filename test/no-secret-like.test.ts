import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AppendOnlyAudit } from "../src/audit.js";
import { createCiv1McpServer, noSecretLike } from "../src/server.js";

test("noSecretLike accepts ordinary titles and rejects Bearer and password patterns", () => {
  assert.equal(noSecretLike("Draft local MCP fixes"), true);
  assert.equal(noSecretLike("Bearer placeholder-value"), false);
  assert.equal(noSecretLike("authorization Bearer placeholder-value"), false);
  assert.equal(noSecretLike("password: placeholder"), false);
  assert.equal(noSecretLike("token=placeholder"), false);
  assert.equal(noSecretLike("secret: placeholder"), false);
  assert.equal(noSecretLike("Password: Placeholder"), false);
});

type ToolTextResult = { content: Array<{ type?: string; text: string }>; isError?: boolean };

test("draft PR title with a password pattern is rejected by input validation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "civ1-secret-"));
  try {
    const server = createCiv1McpServer(undefined, { audit: new AppendOnlyAudit(join(dir, "audit.jsonl")) });
    const client = new Client({ name: "secret-test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const response = await client.callTool({
      name: "civ1_open_draft_pr",
      arguments: { title: "Fix password: placeholder", head: "feature/test", repository: "Civilisation-one/MCP", base: "main" },
    }) as ToolTextResult;
    const text = response.content?.[0]?.text ?? "";
    // Validation must fail closed: either an isError flag or no successful draft receipt.
    const looksLikeSuccess = !response.isError && /"draft"\s*:\s*true/.test(text) && /"merged"\s*:\s*false/.test(text) && /"state"\s*:\s*"open"/.test(text);
    assert.equal(looksLikeSuccess, false);
    assert.equal(text.includes("AUTHENTICATED_TRANSPORT_REQUIRED"), false);
    await client.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
