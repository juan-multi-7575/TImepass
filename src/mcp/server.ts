import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { GeminiAdapter } from '../adapter/gemini-adapter.js';
import { TOOLS, handleTool } from './tools.js';

export async function createMcpServer(adapter?: GeminiAdapter) {
  const ada = adapter ?? new GeminiAdapter();
  await ada.connect().catch(() => {});

  const server = new Server({ name: 'timepass', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const result = await handleTool(name, (args || {}) as Record<string, unknown>, ada);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  return server;
}

export async function startStdio() {
  const server = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[timepass-mcp] running on stdio');
}
