import * as fs from "fs";
import * as path from "path";
import {
  getProjectSettingsPath,
  getUserSettingsPath,
  mergePermissions,
  PERMISSION_SCOPES,
  writeProjectSettings,
  writeSettings,
  type DeepcodingSettings,
  type PermissionDefaultMode,
  type PermissionScope,
  type PermissionSettings,
} from "./settings";

export type PermissionScopeSelection = "allow" | "deny" | "ask" | "default";

export type PermissionSettingsChanges = {
  defaultMode?: PermissionDefaultMode;
  scopes?: Partial<Record<PermissionScope, PermissionScopeSelection>>;
};

export type PermissionSettingsEdit = {
  target: "project" | "user";
  permissions?: PermissionSettings;
  otherPermissions?: PermissionSettings;
};

/** Editing must not mistake an unreadable or malformed file for an empty one. */
function readEditableSettings(settingsPath: string): DeepcodingSettings {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const settings = JSON.parse(raw) as DeepcodingSettings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`Invalid settings in ${settingsPath}`);
  }
  const permissions = settings.permissions;
  if (permissions !== undefined) {
    if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
      throw new Error(`Invalid permissions in ${settingsPath}`);
    }
    for (const key of ["allow", "deny", "ask"] as const) {
      const list = permissions[key];
      if (list !== undefined && (!Array.isArray(list) || list.some((scope) => typeof scope !== "string"))) {
        throw new Error(`Invalid permissions.${key} in ${settingsPath}`);
      }
    }
    if (permissions.defaultMode !== undefined && !["askAll", "allowAll"].includes(permissions.defaultMode)) {
      throw new Error(`Invalid permissions.defaultMode in ${settingsPath}`);
    }
  }
  return settings;
}

function readPermissionSettingsTarget(
  projectRoot: string,
  target: PermissionSettingsEdit["target"]
): {
  settings: DeepcodingSettings;
  edit: PermissionSettingsEdit;
} {
  const projectPath = getProjectSettingsPath(projectRoot);
  const userPath = getUserSettingsPath();
  const sameFile = path.resolve(projectPath) === path.resolve(userPath);
  const settings = readEditableSettings(target === "project" ? projectPath : userPath);
  const other = sameFile ? {} : readEditableSettings(target === "project" ? userPath : projectPath);
  return { settings, edit: { target, permissions: settings.permissions, otherPermissions: other.permissions } };
}

export function readPermissionSettingsEdit(projectRoot: string = process.cwd()): PermissionSettingsEdit {
  const target = fs.existsSync(getProjectSettingsPath(projectRoot)) ? "project" : "user";
  return readPermissionSettingsTarget(projectRoot, target).edit;
}

export function getPermissionScopeSelection(
  permissions: PermissionSettings | undefined,
  scope: PermissionScope
): PermissionScopeSelection {
  for (const decision of ["deny", "ask", "allow"] as const) {
    if (permissions?.[decision]?.includes(scope)) return decision;
  }
  return "default";
}

export function applyPermissionSettingsChanges(
  settings: DeepcodingSettings,
  changes: PermissionSettingsChanges,
  currentDefaultMode: PermissionDefaultMode
): DeepcodingSettings {
  const permissions = { ...settings.permissions };
  let changed = false;
  if (
    changes.defaultMode !== undefined &&
    changes.defaultMode !== (settings.permissions ? (permissions.defaultMode ?? "allowAll") : currentDefaultMode)
  ) {
    permissions.defaultMode = changes.defaultMode;
    changed = true;
  }
  for (const scope of PERMISSION_SCOPES) {
    const selection = changes.scopes?.[scope];
    if (selection === undefined) continue;
    for (const decision of ["allow", "deny", "ask"] as const) {
      const previous = permissions[decision];
      if (selection === decision && previous?.filter((item) => item === scope).length === 1) continue;
      const next = (previous ?? []).filter((item) => item !== scope);
      if (selection === decision) next.push(scope);
      if (JSON.stringify(previous ?? []) !== JSON.stringify(next)) {
        permissions[decision] = next;
        changed = true;
      }
    }
  }
  if (!changed) return settings;
  // A new project permissions object otherwise resets an inherited askAll to allowAll.
  if (!settings.permissions && permissions.defaultMode === undefined) permissions.defaultMode = currentDefaultMode;
  return { ...settings, permissions };
}

export function previewPermissionSettings(
  edit: PermissionSettingsEdit,
  changes: PermissionSettingsChanges = {}
): { permissions: PermissionSettings | undefined; effective: Required<PermissionSettings> } {
  const own = { permissions: edit.permissions };
  const other = { permissions: edit.otherPermissions };
  const merge = (settings: DeepcodingSettings) =>
    edit.target === "project" ? mergePermissions(other, settings) : mergePermissions(settings, other);
  const settings = applyPermissionSettingsChanges(own, changes, merge(own).defaultMode);
  return { permissions: settings.permissions, effective: merge(settings) };
}

export function writePermissionSettingsChanges(
  target: PermissionSettingsEdit["target"],
  changes: PermissionSettingsChanges,
  projectRoot: string = process.cwd()
): { changed: boolean } {
  // Re-read both layers, but keep the destination selected when the editor opened.
  const { settings, edit } = readPermissionSettingsTarget(projectRoot, target);
  const next = applyPermissionSettingsChanges(settings, changes, previewPermissionSettings(edit).effective.defaultMode);
  if (next === settings) return { changed: false };
  if (target === "project") writeProjectSettings(next, projectRoot);
  else writeSettings(next);
  return { changed: true };
}
