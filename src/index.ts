import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCiv1McpServer } from "./server.js";

async function main() {
  const server = createCiv1McpServer();
  await server.connect(new StdioServerTransport());
}
main().catch((error: unknown) => {
  console.error("Civilisation.One MCP failed to start:", error);
  process.exitCode = 1;
});
