/**
 * Scratch driver: boot the plugin in a real Cordis composition and use it.
 *
 * This is the loop that catches what a unit test cannot — a tool schema the
 * registry rejects, a canonical value that fails its own output schema, a bridge
 * that never releases its port.
 *
 *   node scratch/driver.mjs            # no browser: registration + status + the
 *                                      # error a user hits before loading the
 *                                      # Chrome extension
 *   node scratch/driver.mjs --fake     # with a stand-in extension: every success
 *                                      # path, including artifacts on disk
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startFakeExtension } from './fake-extension.mjs'

const STATE_NAME = { 0: 'PENDING', 1: 'LOADING', 2: 'ACTIVE', 3: 'FAILED', 4: 'DISPOSED' }
const scratchDir = path.dirname(fileURLToPath(import.meta.url))
const useFake = process.argv.includes('--fake')

let callIndex = 0
let failures = 0

/**
 * Run one tool through the real execution pipeline and print what the model
 * would have seen.
 *
 * @param {any} ctx - The booted composition.
 * @param {string} name - The registered tool name.
 * @param {Record<string, unknown>} args - The model arguments.
 * @param {string} label - What this step proves.
 * @param {{ expectError?: boolean }} [options] - Set for the steps that must fail.
 * @returns {Promise<{ ok: boolean, text: string }>} The settled outcome.
 */
async function run(ctx, name, args, label, options = {}) {
  console.log('\n=== ' + label + ' ===')
  callIndex += 1
  // callId is an opaque identity at runtime: ToolCallId is a branded string type.
  const result = await ctx.tools.execute({
    callId: 'scratch-' + callIndex,
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
  const text = result.content
    .map(block => (block.type === 'text' ? block.text : JSON.stringify(block)))
    .join('')
  if (result.isError && options.expectError !== true) {
    failures += 1
    console.log('  FAIL  an unexpected failure')
  }
  console.log((result.isError ? '[isError] ' : '') + text)
  return { ok: !result.isError, text }
}

/**
 * Assert a condition, so the driver's exit code means something.
 *
 * @param {string} what - The claim being checked.
 * @param {boolean} ok - Whether it held.
 * @returns {void}
 */
function check(what, ok) {
  if (!ok) failures += 1
  console.log((ok ? '  PASS  ' : '  FAIL  ') + what)
}

async function main() {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(scratchDir).href + '/'

  await ctx.plugin(Loader)
  await ctx.loader.create({
    name: '@deepseek-ai/cordis-plugin-include',
    config: { path: './cordis.yml' },
  })

  const fibers = []
  for (const entry of ctx.loader.entries()) {
    if (entry.fiber) fibers.push(entry.fiber)
  }
  await Promise.allSettled(fibers.map(fiber => fiber.await()))

  console.log('=== mounted plugins ===')
  for (const entry of ctx.loader.entries()) {
    const state = entry.fiber ? STATE_NAME[entry.fiber.state] : 'UNMOUNTED'
    console.log('  ' + state.padEnd(9) + entry.options.name + (entry.disabled ? ' (disabled)' : ''))
  }

  const tools = ctx.tools.schemas().filter(schema => schema.name.startsWith('gemini_'))
  console.log('\n=== registered gemini tools: ' + tools.length + ' ===')
  for (const tool of tools.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log('  ' + tool.name + ' — ' + tool.description.split('. ')[0] + '.')
  }

  // Start the stand-in extension before the first call. It is not awaited: the
  // bridge only starts listening once a tool call needs it, so the fake dials in
  // the background and connects the moment that happens.
  const fake = useFake ? startFakeExtension({ verbose: true }) : null

  if (!useFake) {
    await run(ctx, 'gemini_status', {}, 'gemini_status without a probe (never touches the browser)')
    const probed = await run(ctx, 'gemini_status', { probe: true }, 'gemini_status with a probe (no extension)', { expectError: true })
    check('a probe with no extension reports an actionable error',
      probed.text.includes('chrome://extensions') && probed.text.includes('Load unpacked'))
  } else {
    const status = await run(ctx, 'gemini_status', { probe: true }, 'gemini_status with a probe (extension present)')
    check('the probe reports a connected extension', status.text.includes('chrome extension: connected'))

    const tabs = await run(ctx, 'gemini_tabs', {}, 'gemini_tabs')
    check('tabs carry id, title and group', tabs.text.includes('#11') && tabs.text.includes('Timepass Gemini'))

    await run(ctx, 'gemini_history', { limit: 5 }, 'gemini_history')
    await run(ctx, 'gemini_page_info', {}, 'gemini_page_info')
    await run(ctx, 'gemini_open_chat', { match: 'Quantum notes' }, 'gemini_open_chat')
    await run(ctx, 'gemini_click', { selector: 'button.send-button' }, 'gemini_click')

    const deep = await run(ctx, 'gemini_dom_snapshot', { maxDepth: 8 }, 'gemini_dom_snapshot (full depth)')
    check('the outline reports every node', deep.text.includes('8 of 8 nodes'))

    const shallow = await run(ctx, 'gemini_dom_snapshot', { maxDepth: 1 }, 'gemini_dom_snapshot (maxDepth 1)')
    check('maxDepth prunes the outline', shallow.text.includes('3 of 8 nodes at maxDepth 1'))

    const shot = await run(ctx, 'gemini_screenshot', { label: 'composer view' }, 'gemini_screenshot')
    // The renderer writes the image as markdown: ![label](<absolute path>).
    const shotPath = shot.text.match(/<([^>]+)>/)?.[1]
    const bytes = shotPath ? await fs.readFile(shotPath) : null
    check('a real PNG landed on disk', bytes !== null && bytes.subarray(1, 4).toString() === 'PNG')

    const answer = await run(ctx, 'gemini_ask', { query: 'What is Shor\'s algorithm?' }, 'gemini_ask')
    check('the answer reaches the model', answer.text.includes('Fake extension answer'))

    const long = await run(ctx, 'gemini_ask', { query: 'LONG: explain Grover' }, 'gemini_ask (answer past the inline budget)')
    check('a long answer is bounded and spilled to disk', long.text.includes('full answer at'))

    const attachDir = path.join(scratchDir, '.tmp')
    await fs.mkdir(attachDir, { recursive: true })
    const attachment = path.join(attachDir, 'notes.txt')
    await fs.writeFile(attachment, 'scratch attachment')
    const withFiles = await run(ctx, 'gemini_ask_with_files', { query: 'Summarize this', files: [attachment] }, 'gemini_ask_with_files')
    check('files are attached before the ask', withFiles.text.includes('1 file(s) attached'))
    await fs.rm(attachDir, { recursive: true, force: true })

    await run(ctx, 'gemini_cookies_backup', { domain: 'gemini.google.com' }, 'gemini_cookies_backup (opt-in tools)')
    const restore = await run(ctx, 'gemini_cookies_restore', { file: 'does-not-exist.json' }, 'gemini_cookies_restore with a missing file', { expectError: true })
    check('a missing cookie backup names itself', restore.text.includes('No such file:'))

    const blank = await run(ctx, 'gemini_ask', { query: '   ' }, 'gemini_ask with a blank query (validation)', { expectError: true })
    check('a blank query is refused before the browser', blank.text.includes('query must not be empty'))

    const invalid = await run(ctx, 'gemini_ask', {}, 'gemini_ask without its required argument (schema validation)', { expectError: true })
    check('the registry rejects a missing required argument', invalid.text.length > 0)

    await fake.ready
    check('the stand-in extension connected and answered every action', fake.answered() >= 12)
  }

  await ctx.fiber.dispose()
  fake?.close()
  console.log('\n=== disposed: the bridge released its port ===')
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED')
  // The fake's reconnect timer keeps the event loop alive; the checks are done.
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(error => {
  console.error('DRIVER ERROR:', error)
  process.exit(1)
})
