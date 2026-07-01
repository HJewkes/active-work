/**
 * Imports every command module and registers its default export with the
 * shared registry. The CLI dispatcher (Wave 3.1) and MCP server (Wave 3.2)
 * import this module first so the registry is populated.
 *
 * Order doesn't affect runtime behavior (the registry is a Map keyed by
 * command name), but is kept alphabetical for readability.
 */
import { register, type AnyCommand } from '../registry/index.js';

// Lifecycle
import archive from './archive.js';
import cmdNew from './new.js';
import paths from './paths.js';
import rename from './rename.js';
import set from './set.js';
import touch from './touch.js';

// Focus / pause
import focus from './focus.js';
import pause from './pause.js';
import unfocus from './unfocus.js';
import unpause from './unpause.js';

// Tasks
import taskAdd from './task-add.js';
import taskDelete from './task-delete.js';
import taskDone from './task-done.js';
import taskEdit from './task-edit.js';
import taskList from './task-list.js';
import taskReorder from './task-reorder.js';

// Sessions
import sessionList from './session-list.js';
import sessionRecord from './session-record.js';
import sessionsBrowser from './sessions-browser.js';

// Sources / artifacts
import artifactAddBranch from './artifact-add-branch.js';
import artifactAddStash from './artifact-add-stash.js';
import artifactList from './artifact-list.js';
import artifactNote from './artifact-note.js';
import artifactPrune from './artifact-prune.js';
import artifactStatus from './artifact-status.js';
import sourceAdd from './source-add.js';

// Worktree / cross-initiative reads
import audit from './audit.js';
import list from './list.js';
import worktreeSetDefault from './worktree-set-default.js';

// Discover / triage
import discover from './discover.js';
import drop from './drop.js';
import fold from './fold.js';
import track from './track.js';

// Bootstrap / picker
import open from './open.js';

// Editor
import edit from './edit.js';

// MCP server
import mcpServe from './mcp-serve.js';
import mcpStop from './mcp-stop.js';
import mcpRestart from './mcp-restart.js';
import mcpStatus from './mcp-status.js';
import mcpLogs from './mcp-logs.js';

// Setup / uninstall
import setup from './setup.js';
import uninstall from './uninstall.js';
import doctor from './doctor.js';

const ALL_COMMANDS: AnyCommand[] = [
  // lifecycle
  cmdNew,
  set,
  touch,
  paths,
  rename,
  archive,
  // focus / pause
  focus,
  unfocus,
  pause,
  unpause,
  // tasks
  taskAdd,
  taskDone,
  taskList,
  taskEdit,
  taskReorder,
  taskDelete,
  // sessions
  sessionRecord,
  sessionList,
  sessionsBrowser,
  // sources / artifacts
  sourceAdd,
  artifactAddBranch,
  artifactAddStash,
  artifactList,
  artifactStatus,
  artifactPrune,
  artifactNote,
  // worktree / cross-initiative
  worktreeSetDefault,
  audit,
  list,
  // discover / triage
  discover,
  fold,
  drop,
  track,
  // bootstrap
  open,
  // editor
  edit,
  // mcp server
  mcpServe,
  mcpStop,
  mcpRestart,
  mcpStatus,
  mcpLogs,
  // setup / uninstall
  setup,
  uninstall,
  doctor,
];

for (const cmd of ALL_COMMANDS) {
  register(cmd);
}

export { ALL_COMMANDS };
