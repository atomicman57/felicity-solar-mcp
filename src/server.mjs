#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createServer } from "./tools.mjs";
export { createServer } from "./tools.mjs";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--http")) {
    const port = Number(process.env.FELICITY_MCP_PORT || 4318);
    http
      .createServer(async (req, res) => {
        if (
          !["127.0.0.1:" + port, "localhost:" + port].includes(
            req.headers.host,
          ) ||
          req.headers.origin
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        if (req.url !== "/mcp" || req.method !== "POST") {
          res.writeHead(404);
          res.end();
          return;
        }
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res);
          res.on("close", () => {
            void transport.close();
            void server.close();
          });
        } catch {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        }
      })
      .listen(port, "127.0.0.1", () =>
        console.error("Felicity MCP listening on loopback port " + port),
      );
  } else await createServer().connect(new StdioServerTransport());
}
