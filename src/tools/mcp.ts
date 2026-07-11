// Minimal MCP (Model Context Protocol) stdio client. Connects to configured
// MCP servers, discovers their tools, and bridges each into OMcode's registry
// so the model can call it like any native tool. Transport is newline-delimited
// JSON-RPC 2.0 over the child's stdin/stdout (the stdio transport MCP servers
// speak). Everything is best-effort: a server that fails to start or answer is
// reported and skipped — it never blocks the session.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolRegistry } from "./registry.js";
import { capOutput } from "./registry.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2024-11-05";
const REQUEST_TIMEOUT_MS = 20_000;

/** One MCP server connection speaking JSON-RPC 2.0 over stdio (newline-framed). */
export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private buffer = "";

  constructor(
    readonly name: string,
    private config: McpServerConfig,
  ) {}

  async connect(): Promise<void> {
    // Windows resolves npx/npm to .cmd shims that spawn rejects without a shell.
    const child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      shell: process.platform === "win32",
      windowsHide: true,
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.on("error", (err) => this.failAll(err));
    child.on("close", () => this.failAll(new Error("MCP server process exited")));

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "omcode", version: "0.0.1" },
    });
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = (await this.request("tools/list", {})) as { tools?: McpToolInfo[] };
    return res.tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const res = (await this.request("tools/call", { name, arguments: args ?? {} })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type} content]`))
      .join("\n")
      .trim();
    const body = text || "(the MCP tool returned no text content)";
    return res.isError ? `MCP tool error: ${body}` : body;
  }

  close(): void {
    this.failAll(new Error("client closed"));
    this.child?.kill();
    this.child = undefined;
  }

  // ---- JSON-RPC plumbing ----

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error("not connected"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: unknown): void {
    try {
      this.child?.stdin.write(JSON.stringify(msg) + "\n");
    } catch {
      // a write failure surfaces via the process 'error'/'close' handlers
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON lines (some servers log to stdout)
      }
      if (typeof msg.id !== "number") continue; // a notification, not a response
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
      else p.resolve(msg.result);
    }
  }

  private failAll(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }
}

export interface McpServerStatus {
  name: string;
  ok: boolean;
  tools: string[];
  error?: string;
}

export interface McpManager {
  status(): McpServerStatus[];
  close(): void;
}

/**
 * Connect every configured MCP server, register its tools into `registry`
 * (namespaced `mcp__<server>__<tool>`), and return a manager for /mcp + cleanup.
 * Servers are connected concurrently; failures are captured, never thrown.
 */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  registry: ToolRegistry,
): Promise<McpManager> {
  const clients: McpClient[] = [];
  const statuses: McpServerStatus[] = [];

  await Promise.all(
    Object.entries(servers).map(async ([name, config]) => {
      const client = new McpClient(name, config);
      try {
        await client.connect();
        const tools = await client.listTools();
        for (const t of tools) registry.register(mcpTool(client, name, t));
        clients.push(client);
        statuses.push({ name, ok: true, tools: tools.map((t) => t.name) });
      } catch (err) {
        client.close();
        statuses.push({ name, ok: false, tools: [], error: (err as Error).message });
      }
    }),
  );

  return {
    status: () => statuses,
    close: () => clients.forEach((c) => c.close()),
  };
}

/** Wrap one MCP tool as an OMcode Tool. The server owns schema validation, so
 * local validation accepts any object and the real JSON Schema is advertised. */
function mcpTool(client: McpClient, server: string, info: McpToolInfo): Tool<Record<string, unknown>> {
  return {
    name: `mcp__${server}__${info.name}`,
    description: info.description ?? `MCP tool "${info.name}" from server "${server}".`,
    schema: z.record(z.string(), z.unknown()),
    rawParameters: info.inputSchema ?? { type: "object", properties: {} },
    readOnly: false,
    permission: "ask",
    async execute(input) {
      return capOutput(await client.callTool(info.name, input));
    },
  };
}
