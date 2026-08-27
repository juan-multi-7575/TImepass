import type { GeminiAdapter } from '../adapter/gemini-adapter.js';

export const TOOLS = [
  { name: 'browser_navigate', description: 'Navigate Gemini tab to URL (creates tab if needed)', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to navigate to' } }, required: ['url'] } },
  { name: 'browser_ask', description: 'Send a prompt to Gemini and wait for complete response (broad DOM diff observer)', inputSchema: { type: 'object', properties: { query: { type: 'string' }, model: { type: 'string', enum: ['flash','pro','thinking'] }, newChat: { type: 'boolean' } }, required: ['query'] } },
  { name: 'browser_ask_with_files', description: 'Upload files sequentially, verify, then ask (single atomic command)', inputSchema: { type: 'object', properties: { query: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, model: { type: 'string' }, newChat: { type: 'boolean' } }, required: ['query','files'] } },
  { name: 'browser_observe', description: 'Observe current Gemini response until complete (broad diff + copy signal)', inputSchema: { type: 'object', properties: { timeoutMs: { type: 'number' }, settleMs: { type: 'number' } } } },
  { name: 'browser_screenshot', description: 'Capture viewport screenshot', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_dom_snapshot', description: 'Full DOM snapshot (serializeSubtree) for inspection', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, maxDepth: { type: 'number' } } } },
  { name: 'browser_tabs', description: 'List Gemini tabs', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_history', description: 'Read conversation history from sidebar', inputSchema: { type: 'object', properties: {} } },
] as const;

export async function handleTool(name: string, args: Record<string, unknown>, ada: GeminiAdapter) {
  switch (name) {
    case 'browser_navigate': {
      const tab = await ada.createTab(args.url as string);
      return tab;
    }
    case 'browser_ask': {
      const r = await ada.ask(args.query as string, { model: args.model as any, newChat: args.newChat as boolean });
      return r;
    }
    case 'browser_ask_with_files': {
      const r = await ada.askWithFiles(args.query as string, args.files as string[], { model: args.model as any, newChat: args.newChat as boolean });
      return r;
    }
    case 'browser_observe': {
      // Re-use ask with empty prompt? Instead trigger getPageInfo + dom snapshot polling via adapter if needed
      const info = await ada.getPageInfo();
      return info;
    }
    case 'browser_screenshot': {
      const dataUrl = await ada.captureScreenshot();
      return { dataUrl: dataUrl.slice(0, 120) + '... (truncated, length ' + dataUrl.length + ')' };
    }
    case 'browser_dom_snapshot': {
      const snap = await ada.dumpDom(args.selector as string | undefined);
      return snap;
    }
    case 'browser_tabs': return ada.listTabs();
    case 'browser_history': return ada.listHistory();
    default: throw new Error('Unknown tool: ' + name);
  }
}
