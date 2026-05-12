// Remove ~/.claude/skills/active-work/ on package removal. Fail-soft.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const claudeSkillsDir = join(homedir(), '.claude', 'skills', 'active-work');

try {
  if (existsSync(claudeSkillsDir)) {
    rmSync(claudeSkillsDir, { recursive: true, force: true });
    console.log(`active-work: removed Claude Code skill from ${claudeSkillsDir}`);
  }
} catch (err) {
  console.error(`active-work: skill removal skipped (${err.message})`);
}
