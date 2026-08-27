#!/usr/bin/env node
import { startStdio } from './server.js';
startStdio().catch((e) => { console.error(e); process.exit(1); });
