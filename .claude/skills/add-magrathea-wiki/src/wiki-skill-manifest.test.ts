import { existsSync, readFileSync } from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

/**
 * Guards the Magrathea wiki container skill (`/add-magrathea-wiki`).
 *
 * The schema is prose the agent reads, not code the build typechecks, so
 * nothing else goes red when it disappears — which is exactly what a reset to
 * upstream does to it.
 */
const PAYLOAD = path.join(
  process.cwd(),
  '.claude/skills/add-magrathea-wiki/container-skills/wiki/SKILL.md',
);
const INSTALLED = path.join(process.cwd(), 'container', 'skills', 'wiki', 'SKILL.md');

describe('magrathea wiki container skill', () => {
  it('is installed where the shared-skills mount picks it up', () => {
    expect(existsSync(INSTALLED)).toBe(true);
  });

  it('declares the skill name the agent loads it under', () => {
    expect(readFileSync(INSTALLED, 'utf8')).toMatch(/^name: wiki$/m);
  });

  it('is byte-identical to the payload the skill ships', () => {
    // Red means the two diverged: either a tailored edit is waiting to be
    // copied back into the payload, or the install is stale. See the
    // "Updating the schema" section of SKILL.md.
    expect(readFileSync(INSTALLED, 'utf8')).toBe(readFileSync(PAYLOAD, 'utf8'));
  });

  it('sits in the directory core still mounts as the shared skills dir', () => {
    // Structural, because the resolver isn't exported: buildMounts mounts
    // <root>/container/skills at /app/skills, and selectedSkillNames lists that
    // same directory. If upstream moves either, installing the file here stops
    // meaning anything — go red rather than silently do nothing.
    const runner = readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf8');
    expect(runner).toContain("path.join(projectRoot, 'container', 'skills')");
    expect(runner).toContain("containerPath: '/app/skills'");
    expect(runner).toContain("path.join(process.cwd(), 'container', 'skills')");
  });
});
