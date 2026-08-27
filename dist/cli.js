#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GeminiAdapter } from './adapter/gemini-adapter.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function showUsage() {
    console.log(`
Usage: timepass <command> [argument] [--model <flash|pro|thinking>]

Commands:
  ask              Send prompt to Gemini and print the full response
  stream           Send prompt to Gemini and stream response in real-time
  history          Read recent conversations list from sidebar
  select-history   Switch to an existing conversation by title or URL
  screenshot       Capture and save a PNG screenshot of the active browser viewport
  dom-dump         Dump serialized JSON DOM node subtree of the active tab
  cookies-get      Save browser session cookies for a given domain to a JSON file
  cookies-restore  Restore browser session cookies from a JSON file for a domain
  test-upload      Run diagnostic flow to locate upload menus and file inputs

Options:
  --model          Select Gemini model (e.g. flash, pro, thinking)

Example:
  npx timepass ask "What is quantum computing?" --model pro
  npx timepass stream "Tell me a joke" --model flash
  npx timepass history
  npx timepass screenshot
  npx timepass dom-dump "rich-textarea"
  npx timepass cookies-get gemini.google.com
  `);
}
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const argument = args[1];
    let model;
    const modelIdx = args.indexOf('--model');
    if (modelIdx !== -1 && args[modelIdx + 1]) {
        model = args[modelIdx + 1];
    }
    if (!command) {
        showUsage();
        process.exit(1);
    }
    if ((command === 'ask' || command === 'stream') && !argument) {
        console.error(`[timepass CLI] Error: Command '${command}' requires a prompt string.`);
        showUsage();
        process.exit(1);
    }
    if (command === 'select-history' && !argument) {
        console.error(`[timepass CLI] Error: Command 'select-history' requires a title or URL search term.`);
        showUsage();
        process.exit(1);
    }
    if (command === 'cookies-get' && !argument) {
        console.error(`[timepass CLI] Error: Command 'cookies-get' requires a domain (e.g., gemini.google.com).`);
        showUsage();
        process.exit(1);
    }
    if (command === 'cookies-restore' && !argument) {
        console.error(`[timepass CLI] Error: Command 'cookies-restore' requires a domain.`);
        showUsage();
        process.exit(1);
    }
    const adapter = new GeminiAdapter({ model });
    try {
        console.log(`[timepass CLI] Connecting to Gemini extension...`);
        await adapter.connect();
        if (command === 'history') {
            console.log('[timepass CLI] Reading conversation history from sidebar...');
            const history = await adapter.listHistory();
            console.log('\nRecent Conversations:');
            history.forEach((item, index) => {
                console.log(`  ${index + 1}. [${item.title}] -> ${item.url}`);
            });
            // Save history list to timepass/history.json
            const outputPath = path.resolve(__dirname, '../history.json');
            fs.writeFileSync(outputPath, JSON.stringify(history, null, 2), 'utf-8');
            console.log(`\n[timepass CLI] History saved to: ${outputPath}`);
        }
        else if (command === 'select-history') {
            console.log(`[timepass CLI] Selecting conversation matching: "${argument}"...`);
            const res = await adapter.selectHistory({ title: argument, url: argument });
            console.log(`[timepass CLI] Successfully switched to conversation! URL: ${res.url}`);
        }
        else if (command === 'screenshot') {
            console.log('[timepass CLI] Capturing screenshot of the active browser viewport...');
            const dataUrl = await adapter.captureScreenshot();
            const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
            const outputPath = path.resolve(__dirname, '../screenshot.png');
            fs.writeFileSync(outputPath, Buffer.from(base64Data, 'base64'));
            console.log(`[timepass CLI] Screenshot saved successfully: ${outputPath}`);
        }
        else if (command === 'dom-dump') {
            console.log(`[timepass CLI] Dumping DOM subtree for selector: "${argument || 'body'}"...`);
            const tree = await adapter.dumpDom(argument);
            const outputPath = path.resolve(__dirname, '../dom-tree.json');
            fs.writeFileSync(outputPath, JSON.stringify(tree, null, 2), 'utf-8');
            console.log(`[timepass CLI] DOM subtree dumped successfully: ${outputPath}`);
        }
        else if (command === 'cookies-get') {
            console.log(`[timepass CLI] Fetching browser session cookies for domain: "${argument}"...`);
            const cookies = await adapter.getCookies(argument);
            const outputPath = path.resolve(__dirname, '../cookies.json');
            fs.writeFileSync(outputPath, JSON.stringify(cookies, null, 2), 'utf-8');
            console.log(`[timepass CLI] Cookies saved successfully: ${outputPath}`);
        }
        else if (command === 'cookies-restore') {
            const fileArg = args[2] || '../cookies.json';
            const inputPath = path.resolve(__dirname, fileArg);
            console.log(`[timepass CLI] Restoring cookies for domain "${argument}" from: ${inputPath}...`);
            if (!fs.existsSync(inputPath)) {
                throw new Error(`Cookies source file not found at: ${inputPath}`);
            }
            const rawData = fs.readFileSync(inputPath, 'utf-8');
            const cookies = JSON.parse(rawData);
            await adapter.restoreCookies(argument, cookies);
            console.log(`[timepass CLI] Cookies successfully restored for domain: ${argument}`);
        }
        else if (command === 'file-upload') {
            if (!argument) {
                throw new Error("Command 'file-upload' requires a filepath argument.");
            }
            const filePath = path.resolve(process.cwd(), argument);
            if (!fs.existsSync(filePath)) {
                throw new Error(`File not found at: ${filePath}`);
            }
            console.log(`[timepass CLI] Reading file: ${filePath}...`);
            const buffer = fs.readFileSync(filePath);
            const base64Data = buffer.toString('base64');
            const fileName = path.basename(filePath);
            const mimeType = getMimeType(filePath);
            console.log(`[timepass CLI] Uploading file "${fileName}" (${mimeType}) to Gemini...`);
            await adapter.uploadFile({ fileName, mimeType, base64Data });
            console.log('[timepass CLI] File successfully uploaded!');
        }
        else {
            let finalResponseText = '';
            let images = [];
            const prompt = argument;
            if (command === 'stream') {
                console.log(`[timepass CLI] Sending prompt: "${prompt}"\n---`);
                const response = await adapter.ask(prompt, {
                    model,
                    onChunk: (chunk) => {
                        process.stdout.write(chunk.delta);
                    }
                });
                console.log('\n--- Done.');
                finalResponseText = response.text;
                images = response.images || [];
            }
            else if (command === 'ask') {
                console.log(`[timepass CLI] Sending prompt: "${prompt}"...`);
                const response = await adapter.ask(prompt, { model });
                console.log(`\nResponse:\n${response.text}`);
                finalResponseText = response.text;
                images = response.images || [];
            }
            if (images.length > 0) {
                console.log('\n[timepass CLI] Generated/Extracted Images:');
                images.forEach((img, idx) => {
                    console.log(`  ${idx + 1}: ${img}`);
                    finalResponseText += `\n\n![Generated Image ${idx + 1}](${img})`;
                });
            }
            // Save output to response.md
            const outputPath = path.resolve(__dirname, '../response.md');
            fs.writeFileSync(outputPath, finalResponseText, 'utf-8');
            console.log(`[timepass CLI] Response successfully saved to: ${outputPath}`);
        }
        await adapter.close();
        process.exit(0);
    }
    catch (err) {
        console.error(`[timepass CLI] Error: ${err.message}`);
        await adapter.close();
        process.exit(1);
    }
}
main();
function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.gif': return 'image/gif';
        case '.webp': return 'image/webp';
        case '.pdf': return 'application/pdf';
        case '.txt': return 'text/plain';
        case '.csv': return 'text/csv';
        case '.json': return 'application/json';
        default: return 'application/octet-stream';
    }
}
//# sourceMappingURL=cli.js.map