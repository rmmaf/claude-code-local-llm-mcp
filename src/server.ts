#!/usr/bin/env node
/**
 * local-coder MCP server entry point. stdio transport: stdout carries the MCP
 * protocol and NOTHING else — all diagnostics go through the stderr logger.
 * The single sanctioned non-protocol stdout write is the --version flag,
 * which exits before the transport starts (used to pre-warm `npx github:`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { ToolError } from "./fs-safety.js";
import { log } from "./logger.js";
import {
  implementInputSchema,
  implementToolDescription,
  implementToolName,
  runImplement,
} from "./tools/implement.js";
import { fixInputSchema, fixToolDescription, fixToolName, runFix } from "./tools/fix.js";
import {
  runScaffold,
  scaffoldInputSchema,
  scaffoldToolDescription,
  scaffoldToolName,
} from "./tools/scaffold.js";
import { runStatus, statusToolDescription, statusToolName } from "./tools/status.js";

function packageVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function jsonResult(payload: unknown): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(error: unknown): ToolResponse {
  if (error instanceof ToolError) {
    log.error(`tool error [${error.code}]: ${error.message}`);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: { code: error.code, message: error.message, ...error.details } },
            null,
            2
          ),
        },
      ],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  log.error(`unexpected tool failure: ${error instanceof Error ? error.stack ?? message : message}`);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { code: "internal_error", message } }, null, 2),
      },
    ],
  };
}

async function main(): Promise<void> {
  const version = packageVersion();

  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${version}\n`);
    return;
  }

  const config = loadConfig();
  const server = new McpServer({ name: "local-coder", version });

  server.registerTool(
    implementToolName,
    { title: "Implement via local LLM", description: implementToolDescription, inputSchema: implementInputSchema },
    async (args) => {
      try {
        return jsonResult(await runImplement(args, config));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    fixToolName,
    { title: "Fix a failure via local LLM", description: fixToolDescription, inputSchema: fixInputSchema },
    async (args) => {
      try {
        return jsonResult(await runFix(args, config));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    scaffoldToolName,
    { title: "Scaffold new files via local LLM", description: scaffoldToolDescription, inputSchema: scaffoldInputSchema },
    async (args) => {
      try {
        return jsonResult(await runScaffold(args, config));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    statusToolName,
    {
      title: "Local delegation status",
      description: statusToolDescription,
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return jsonResult(await runStatus(config));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  await server.connect(new StdioServerTransport());
  log.info(
    `local-coder v${version} ready (root=${config.root}, endpoint=${config.baseUrl}, ` +
      `solo=${config.modelSolo}, ide=${config.modelIde})`
  );
}

main().catch((error: unknown) => {
  log.error(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
