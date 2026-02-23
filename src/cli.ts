#!/usr/bin/env node
// CLI entrypoint:
// - default: start MCP stdio server
// - adapter mode: expose MCP tools as command-line operations

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Logger } from './utils/logger.js';
import { readFileSync } from 'node:fs';

// In CLI adapter mode, prefer machine-readable stdout; route runtime logs to stderr.
if (!process.env.MCP_ROUTE_STDOUT_LOGS) {
  process.env.MCP_ROUTE_STDOUT_LOGS = 'true';
}

type CliCommand =
  | { kind: 'start-server' }
  | { kind: 'tools-list' }
  | { kind: 'tool-describe'; name: string }
  | { kind: 'tool-run'; name: string; args: Record<string, unknown> };

type RuntimeBundle = {
  server: { connect: (transport: InMemoryTransport) => Promise<void> };
  bridge: { dispose: () => void };
  automationBridge: { stop: () => void };
  graphqlServer: { stop: () => Promise<void> };
  metricsServer?: { close: (callback: (error?: Error) => void) => void } | null;
};

async function loadRuntime(): Promise<{
  createServer: () => RuntimeBundle;
  startStdioServer: () => Promise<void>;
}> {
  const mod = await import('./index.js');
  return {
    createServer: mod.createServer as () => RuntimeBundle,
    startStdioServer: mod.startStdioServer as () => Promise<void>
  };
}

const log = new Logger('CLI');

async function printJson(value: unknown): Promise<void> {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(payload, (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseJsonObject(input: string, flagName: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(`${flagName} must be a JSON object`, 2);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    fail(`Invalid JSON for ${flagName}: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
}

function readArgsFromFile(filePath: string): Record<string, unknown> {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return parseJsonObject(content, '--args-file');
  } catch (error) {
    fail(`Failed to read --args-file '${filePath}': ${error instanceof Error ? error.message : String(error)}`, 2);
  }
}

function parseCommand(argv: string[]): CliCommand {
  if (argv.length === 0) {
    return { kind: 'start-server' };
  }

  if (argv[0] === 'tools' && argv[1] === 'list') {
    return { kind: 'tools-list' };
  }

  if (argv[0] === 'tool' && argv[1] === 'describe') {
    const toolName = argv[2];
    if (!toolName) {
      fail('Usage: tool describe <tool-name>', 2);
    }
    return { kind: 'tool-describe', name: toolName };
  }

  if (argv[0] === 'tool' && argv[1] === 'run') {
    const toolName = argv[2];
    if (!toolName) {
      fail('Usage: tool run <tool-name> --args <json> | --args-file <path>', 2);
    }

    let argsValue: Record<string, unknown> | undefined;
    for (let i = 3; i < argv.length; i += 1) {
      const current = argv[i];
      if (current === '--args') {
        const json = argv[i + 1];
        if (!json) {
          fail('Missing value for --args', 2);
        }
        argsValue = parseJsonObject(json, '--args');
        i += 1;
        continue;
      }
      if (current === '--args-file') {
        const filePath = argv[i + 1];
        if (!filePath) {
          fail('Missing value for --args-file', 2);
        }
        argsValue = readArgsFromFile(filePath);
        i += 1;
        continue;
      }
      if (current === '--help' || current === '-h') {
        fail('Usage: tool run <tool-name> --args <json> | --args-file <path>', 0);
      }
      fail(`Unknown option: ${current}`, 2);
    }

    return { kind: 'tool-run', name: toolName, args: argsValue ?? {} };
  }

  if (argv[0] === '--help' || argv[0] === '-h') {
    fail(
      [
        'Usage:',
        '  unreal-engine-mcp-server                         # start MCP stdio server',
        '  unreal-engine-mcp-server tools list              # list tools',
        '  unreal-engine-mcp-server tool describe <name>    # show one tool schema',
        '  unreal-engine-mcp-server tool run <name> [--args <json> | --args-file <path>]'
      ].join('\n'),
      0
    );
  }

  fail(`Unknown command: ${argv.join(' ')}`, 2);
}

async function withInMemoryClient<T>(action: (client: Client) => Promise<T>): Promise<T> {
  const { createServer } = await loadRuntime();
  const runtime = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ue-cli-adapter', version: '0.1.0' }, { capabilities: { elicitation: {} } });

  try {
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);
    return await action(client);
  } finally {
    try {
      await client.close();
    } catch { }

    try {
      runtime.automationBridge.stop();
    } catch { }

    try {
      runtime.bridge.dispose();
    } catch { }

    try {
      await runtime.graphqlServer.stop();
    } catch { }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const timeout = setTimeout(() => finish(), 250);
      try {
        runtime.metricsServer?.close(() => {
          clearTimeout(timeout);
          finish();
        });
      } catch {
        clearTimeout(timeout);
        finish();
      }
    });

    try {
      const serverObj = runtime.server as unknown as { close?: () => Promise<void> };
      if (typeof serverObj.close === 'function') {
        await serverObj.close();
      }
    } catch { }
  }
}

async function runCliCommand(command: CliCommand): Promise<void> {
  if (command.kind === 'start-server') {
    const { startStdioServer } = await loadRuntime();
    await startStdioServer();
    return;
  }

  if (command.kind === 'tools-list') {
    const result = await withInMemoryClient(async (client) => client.listTools());
    await printJson({ count: result.tools.length, tools: result.tools.map((t) => ({ name: t.name, description: t.description })) });
    return;
  }

  if (command.kind === 'tool-describe') {
    const result = await withInMemoryClient(async (client) => client.listTools());
    const tool = result.tools.find((item) => item.name === command.name);
    if (!tool) {
      fail(`Tool not found: ${command.name}`, 2);
    }
    await printJson(tool);
    return;
  }

  const toolResult = await withInMemoryClient(async (client) => {
    return client.callTool({
      name: command.name,
      arguments: command.args
    });
  });

  await printJson(toolResult);
  if ('isError' in toolResult && toolResult.isError) {
    process.exit(4);
  }
}

(async () => {
  try {
    const command = parseCommand(process.argv.slice(2));
    await runCliCommand(command);
  } catch (error) {
    log.error('CLI execution failed:', error);
    process.exit(5);
  }
})();
