// Starts the built server exactly as an MCP client would (node dist/index.js over stdio) and checks the
// tools respond. Run after `npm run build`: `npm run smoke`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const client = new Client({ name: "civ1-smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}dist/src/index.js`] }));
const tools = (await client.listTools()).tools.map((t) => t.name);
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const mission = await call("civ1_create_mission", { goal: "smoke test" });
const nun = JSON.parse(readFileSync(`${root}examples/nun-core-96a7dcf.json`, "utf8"));
const imported = await call("civ1_import_external_source", { missionId: mission.id, ...nun });
await client.close();
const ok = tools.includes("civ1_import_external_source") && mission.id === "CIV1-M-00001" &&
  imported.imported?.every((i) => ["HYPOTHESIS", "SPECULATION"].includes(i.status));
console.log(ok ? `smoke OK: ${tools.length} tools, ${imported.imported.length} claims imported` : "smoke FAILED");
process.exit(ok ? 0 : 1);
