import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The skill is only useful if it matches the plugin. When a tool is added to
 * tools.js and left out of the skill, an agent reads instructions that
 * describe a bridge it does not fully know. That drift is what this file is
 * for: every registered tool must be documented, or this test fails.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = path.join(HERE, '..', '..', 'src');
const SKILL_MD = path.join(HERE, 'SKILL.md');
const REFERENCES_DIR = path.join(HERE, 'references');

const skillText = readFileSync(SKILL_MD, 'utf8');
const toolsText = readFileSync(path.join(PLUGIN_SRC, 'tools.js'), 'utf8');

/** Tool names the plugin actually registers, parsed from its source. */
function registeredTools() {
  const names = new Set();
  for (const m of toolsText.matchAll(/name: '(gemini_[a-z_]+)'/g)) names.add(m[1]);
  return [...names].sort();
}

/** Every markdown file in references/. */
function referenceFiles() {
  return readdirSync(REFERENCES_DIR).filter(f => f.endsWith('.md')).sort();
}

function allReferenceText() {
  return referenceFiles().map(f => readFileSync(path.join(REFERENCES_DIR, f), 'utf8')).join('\n');
}

describe('skill frontmatter', () => {
  const match = skillText.match(/^---\n([\s\S]*?)\n---/);

  it('opens with a parseable frontmatter block', () => {
    expect(match).not.toBeNull();
  });

  it('names itself after its directory so the catalog links correctly', () => {
    expect(match[1]).toMatch(/^name: timepass-gemini$/m);
  });

  it('keeps the description under the 1024-character catalog limit', () => {
    const description = match[1].match(/^description: ([\s\S]*?)(?=\n[a-z]+:|$)/m);
    expect(description).not.toBeNull();
    expect(description[1].trim().length).toBeGreaterThan(0);
    expect(description[1].trim().length).toBeLessThan(1024);
  });

  it('triggers on the phrasings that should reach for it', () => {
    const description = match[1].toLowerCase();
    expect(description).toContain('ask gemini');
    expect(description).toContain('use my gemini');
  });

  it('says when NOT to use it, so it does not become the default tool', () => {
    // Without a negative, the agent reaches for a slow browser round trip when
    // a web search would have answered the question.
    expect(description_has_negative()).toBe(true);
  });
});

function description_has_negative() {
  const m = skillText.match(/^description: ([\s\S]*?)(?=\n[a-z]+:|$)/m);
  return !!m && /not for|instead/i.test(m[1]);
}

describe('tool coverage', () => {
  const tools = registeredTools();

  it('finds the tool registrations to check against', () => {
    // If this ever drops to zero the parse broke and every test below would
    // pass vacuously.
    expect(tools.length).toBeGreaterThanOrEqual(12);
  });

  it('documents every registered gemini_* tool', () => {
    const reference = allReferenceText();
    const undocumented = tools.filter(name => !reference.includes(name));
    expect(undocumented).toEqual([]);
  });

  it('documents the /gemini slash command', () => {
    expect(allReferenceText()).toContain('/gemini');
  });
});

describe('references', () => {
  it('has the reference files SKILL.md points readers at', () => {
    for (const name of ['tools.md', 'troubleshooting.md', 'patterns.md']) {
      expect(referenceFiles()).toContain(name);
    }
  });

  it('references only files that exist and are non-empty', () => {
    const referenced = [...skillText.matchAll(/`(references\/[a-z]+\.md)`/g)].map(m => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const rel of referenced) {
      const full = path.join(HERE, rel);
      expect(statSync(full).size, `${rel} is empty`).toBeGreaterThan(0);
    }
  });
});

describe('the answer contract', () => {
  it('distinguishes partial from truncated, since they mean opposite things', () => {
    const text = skillText + allReferenceText();
    expect(text).toContain('partial');
    expect(text).toContain('truncated');
    expect(text).toMatch(/never present it as the full answer/i);
  });

  it('warns against stripping the incomplete banner', () => {
    expect(skillText).toMatch(/never strip it/i);
  });

  it('states that timeoutMs is a whole-turn budget', () => {
    expect(skillText).toMatch(/whole turn/i);
  });

  it('carries the troubleshooting finding that editing the patch file does not remount', () => {
    // This one is easy to undo by accident and expensive to rediscover.
    expect(allReferenceText()).toMatch(/cordis\.patch\.yml/);
    expect(allReferenceText()).toMatch(/plugin manager/i);
  });
});
