import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('Auto Ontology naming', () => {
  it('keeps the research setting and MCP environment mapping compatible', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    expect(manifest.user_config.research.title).toBe('Google Surf Auto Ontology');
    expect(manifest.user_config.research.default).toBe(true);
    expect(manifest.server.mcp_config.env.SURF_RESEARCH).toBe('${user_config.research}');
    expect(manifest.server.mcp_config.env.SURF_RESEARCH_ROOT).toBe('${user_config.research_root}');
    expect(loadConfig({}).researchEnabled).toBe(true);
    expect(loadConfig({ SURF_RESEARCH: 'false' }).researchEnabled).toBe(false);
  });

  it('documents the new feature name without renaming the registry environment variable', () => {
    const registry = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
    const setting = registry.packages[0].environmentVariables.find(
      (entry: { name: string }) => entry.name === 'SURF_RESEARCH',
    );
    expect(setting.description).toContain('Google Surf Auto Ontology');
    for (const name of ['README.md', 'README.ko.md']) {
      const readme = readFileSync(new URL('../' + name, import.meta.url), 'utf8');
      expect(readme).toContain('## Google Surf Auto Ontology');
      expect(readme).toContain('SURF_RESEARCH=false');
    }
  });

  it('uses Auto Ontology in user-facing disabled errors and database descriptions', () => {
    const service = readFileSync(new URL('../src/research/service.ts', import.meta.url), 'utf8');
    expect(service).toContain('Auto Ontology is disabled (SURF_RESEARCH=false)');
    for (const name of ['README.md', 'README.ko.md']) {
      const readme = readFileSync(new URL('../' + name, import.meta.url), 'utf8');
      expect(readme).not.toMatch(/local research DB|local research database|research search route/i);
    }
  });
});
