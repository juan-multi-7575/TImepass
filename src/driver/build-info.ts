import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

/**
 * What the host knows about the extension build it is supposed to be talking to.
 *
 * The retest that produced issue #10 was run against a service worker still
 * executing code from an earlier edit: the on-disk `background.js` had
 * `recover_last_response` and the live worker's dispatch table did not, so a
 * whole recovery path was never exercised and the results were untrustworthy.
 * Nothing reported the skew. This module is the host's half of the fix — it
 * reads what is on disk so it can be compared against what the extension says
 * is loaded.
 * @module driver/build-info
 */

/**
 * Wire revision of the host↔extension handshake.
 *
 * Bumped only when a message shape changes incompatibly. Both ends must
 * tolerate a peer that never sends the handshake at all, so this is diagnostic
 * information rather than a compatibility switch.
 */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Identity of this host build, reported to the extension. */
export const DRIVER_BUILD_ID = 'timepass-driver@1.1.0';

/** What the on-disk extension build looks like from the host's side. */
export interface ExtensionBuildInfo {
  /** Directory the manifest was read from, or null when none was found. */
  manifestPath: string | null;
  /**
   * `version` from the on-disk manifest — the build the host expects to be
   * talking to. Compared against the id the extension reports at runtime.
   */
  expectedBuildId: string | null;
  /**
   * Short digest over the extension's own sources. A build whose digest is
   * unchanged since the last check cannot differ from the loaded one; a digest
   * that moved with no version bump means edits landed without a reload.
   *
   * Advisory: the extension cannot compute this without hashing its own files
   * over `chrome.runtime.getURL`, so it is reported to a human rather than
   * compared against a peer value.
   */
  sourceFingerprint: string | null;
  /** Source files the digest covered. */
  sources: string[];
  /** Why the manifest could not be read, when it could not. */
  error?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Candidate directories for the unpacked extension, in preference order.
 *
 * `__dirname` is two levels under the project root from either `src/driver` or
 * the compiled `dist/driver`, so the same relative walk works for a tsx launch
 * and for a packaged build. The cwd entry covers a layout where the plugin and
 * the project are installed side by side.
 *
 * @returns Absolute paths to try.
 */
function manifestCandidates(): string[] {
  return [
    path.resolve(__dirname, '..', '..', 'extension', 'manifest.json'),
    path.resolve(process.cwd(), 'extension', 'manifest.json'),
    path.resolve(process.cwd(), '..', 'extension', 'manifest.json'),
  ];
}

/**
 * Read the on-disk extension manifest.
 *
 * @returns The path it was read from, or null when no candidate existed.
 */
export function readExtensionManifestPath(): string | null {
  for (const candidate of manifestCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Describe the extension build that is on disk right now.
 *
 * Never throws: this runs on a status call and on every connect, and a missing
 * or malformed manifest must degrade into a reported fact rather than take the
 * bridge down.
 *
 * @param manifestPath - Manifest to read; discovered from the project layout when omitted.
 * @returns What the host expects to be talking to.
 */
export function readExtensionBuildInfo(manifestPath?: string): ExtensionBuildInfo {
  const resolved = manifestPath ?? readExtensionManifestPath();
  if (!resolved) {
    return {
      manifestPath: null,
      expectedBuildId: null,
      sourceFingerprint: null,
      sources: [],
      error:
        'No extension manifest found. Expected extension/manifest.json next to the timepass project, '
        + 'or load the unpacked extension from chrome://extensions.',
    };
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      manifestPath: resolved,
      expectedBuildId: null,
      sourceFingerprint: null,
      sources: [],
      error: `Could not read ${resolved}: ${detail}`,
    };
  }

  const version = typeof manifest.version === 'string' ? manifest.version : null;
  const fingerprint = fingerprintSources(path.dirname(resolved), resolved);

  return {
    manifestPath: resolved,
    expectedBuildId: version,
    sourceFingerprint: fingerprint.digest,
    sources: fingerprint.sources,
  };
}

/**
 * Digest the extension's own scripts and manifest.
 *
 * The worker is what actually runs, so its script and the manifest are what
 * have to be covered. Sorted so the digest is stable across filesystems, and
 * length-prefixed so a rename cannot collide with an edit.
 *
 * @param extensionDir - Directory holding the unpacked extension.
 * @param manifestPath - The manifest inside it, included in the digest.
 * @returns The short digest and the files it covered.
 */
function fingerprintSources(extensionDir: string, manifestPath: string): { digest: string | null; sources: string[] } {
  try {
    const files = fs
      .readdirSync(extensionDir)
      .filter(name => name.endsWith('.js'))
      .concat(path.basename(manifestPath))
      .filter((name, index, all) => all.indexOf(name) === index)
      .sort();

    const hash = crypto.createHash('sha256');
    for (const name of files) {
      const filePath = path.join(extensionDir, name);
      const body = fs.readFileSync(filePath);
      hash.update(`${name}:${body.length}:`);
      hash.update(body);
    }
    return { digest: hash.digest('hex').slice(0, 12), sources: files };
  } catch {
    // An unreadable source file must not take the status call down; the caller
    // reports a null digest, which reads as "unknown", never as "matching".
    return { digest: null, sources: [] };
  }
}