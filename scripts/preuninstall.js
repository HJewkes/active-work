// Remove ~/.claude/skills/active-work/ on package removal. Fail-soft.
import { existsSync, rmSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// A workspace or checkout uninstall runs this hook too; only an installed copy
// (a package dir under node_modules) may remove the skill.
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!packageDir.split(sep).includes('node_modules')) {
  process.exit(0);
}

const claudeSkillsDir = join(homedir(), '.claude', 'skills', 'active-work');

try {
  if (existsSync(claudeSkillsDir)) {
    rmSync(claudeSkillsDir, { recursive: true, force: true });
    console.log(`active-work: removed Claude Code skill from ${claudeSkillsDir}`);
  }
} catch (err) {
  console.error(`active-work: skill removal skipped (${err.message})`);
}
