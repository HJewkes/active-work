// Copy the bundled Claude Code skill into ~/.claude/skills/active-work/ and the
// /aw-prompt slash command into ~/.claude/commands/ when ~/.claude exists. Skip
// silently otherwise. Fail-soft: never abort an npm install if a copy fails.
import { existsSync, mkdirSync, cpSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillSource = join(__dirname, '..', 'skill');
const commandSource = join(__dirname, '..', 'claude-commands', 'aw-prompt.md');
const claudeDir = join(homedir(), '.claude');
const claudeSkillsDir = join(claudeDir, 'skills', 'active-work');
const claudeCommandsDir = join(claudeDir, 'commands');

if (!existsSync(claudeDir)) {
  // User doesn't have Claude Code installed — skip silently.
  process.exit(0);
}

// Skill and command installs are independent — a missing source for one must
// not skip the other.
if (existsSync(skillSource)) {
  try {
    // Remove existing install to ensure a clean copy.
    if (existsSync(claudeSkillsDir)) {
      rmSync(claudeSkillsDir, { recursive: true, force: true });
    }
    mkdirSync(claudeSkillsDir, { recursive: true });
    cpSync(skillSource, claudeSkillsDir, { recursive: true });
    console.log(`active-work: installed Claude Code skill to ${claudeSkillsDir}`);
  } catch (err) {
    // Don't fail npm install if skill copy fails.
    console.error(`active-work: skill install skipped (${err.message})`);
  }
}

try {
  if (existsSync(commandSource)) {
    mkdirSync(claudeCommandsDir, { recursive: true });
    copyFileSync(commandSource, join(claudeCommandsDir, 'aw-prompt.md'));
    console.log(`active-work: installed /aw-prompt command to ${claudeCommandsDir}`);
  }
} catch (err) {
  // Don't fail npm install if the command copy fails.
  console.error(`active-work: command install skipped (${err.message})`);
}
