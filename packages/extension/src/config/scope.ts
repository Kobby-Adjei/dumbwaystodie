/**
 * Where a setting written by the extension should land.
 *
 * VS Code throws — not returns an error, *throws* — when you write to Workspace
 * settings in a window with no folder open. Every command that flips a setting
 * on the user's behalf has to decide this, so the decision lives in one tested
 * place rather than being repeated at each call site and getting it wrong once.
 *
 * Workspace when there is one, because "this project talks to the relay" should
 * not follow the user into unrelated projects. Global otherwise, because the
 * alternative is the action failing for a reason that has nothing to do with
 * what the user asked for.
 */
export type ConfigScope = "workspace" | "global";

export function configScope(hasWorkspaceFolder: boolean): ConfigScope {
  return hasWorkspaceFolder ? "workspace" : "global";
}

/**
 * Whether the workspace-backed tools can do anything at all.
 *
 * With no folder open, `workspace.read_file`, `search`, `list_directory` and
 * `project_tree` all refuse — correctly, since there is no boundary to enforce.
 * Worth saying out loud rather than letting the user discover it one refused
 * tool at a time.
 */
export function workspaceToolsAvailable(hasWorkspaceFolder: boolean): boolean {
  return hasWorkspaceFolder;
}
