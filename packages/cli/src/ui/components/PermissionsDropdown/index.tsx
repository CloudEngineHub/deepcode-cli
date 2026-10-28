import React, { useState } from "react";
import { Box, Text, useWindowSize } from "ink";
import {
  getPermissionScopeSelection,
  PERMISSION_SCOPES,
  previewPermissionSettings,
  type PermissionDefaultMode,
  type PermissionScope,
  type PermissionScopeSelection,
  type PermissionSettingsChanges,
  type PermissionSettingsEdit,
} from "@vegamo/deepcode-core";
import DropdownMenu, { type DropdownMenuItem } from "../DropdownMenu";
import { useTerminalInput } from "../../hooks";

const MODES: PermissionDefaultMode[] = ["askAll", "allowAll"];
const DECISIONS: PermissionScopeSelection[] = ["allow", "deny", "ask", "default"];
const DECISION_DESCRIPTIONS = ["Allow automatically", "Block", "Ask before proceeding", "Remove this level's rule"];

type Props = {
  edit: PermissionSettingsEdit;
  width: number;
  onClose: () => void;
  onSave: (target: PermissionSettingsEdit["target"], changes: PermissionSettingsChanges) => string | Promise<string>;
  onStatusMessage: (message: string) => void;
};

export function describeScopeSetting(
  edit: PermissionSettingsEdit,
  changes: PermissionSettingsChanges,
  scope: PermissionScope
): string {
  const { permissions, effective } = previewPermissionSettings(edit, changes);
  const selected = getPermissionScopeSelection(permissions, scope);
  const explicit = getPermissionScopeSelection(effective, scope);
  const decision = explicit === "default" ? (effective.defaultMode === "askAll" ? "ask" : "allow") : explicit;
  if (selected === decision) return selected;
  const otherSource = edit.target === "project" ? "User" : "Project";
  const projectPermissions = edit.target === "project" ? permissions : edit.otherPermissions;
  const userPermissions = edit.target === "user" ? permissions : edit.otherPermissions;
  const source =
    explicit !== "default" ? otherSource : projectPermissions ? "Project" : userPermissions ? "User" : "defaultMode";
  return `${selected} · effective: ${decision} (${source})`;
}

export default function PermissionsDropdown({
  edit,
  width,
  onClose,
  onSave,
  onStatusMessage,
}: Props): React.ReactElement {
  const { rows } = useWindowSize();
  const [step, setStep] = useState<"home" | "defaultMode" | "scopes" | "scope">("home");
  const [activeIndex, setActiveIndex] = useState(0);
  const [scopeIndex, setScopeIndex] = useState(0);
  const [changes, setChanges] = useState<PermissionSettingsChanges>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const scope = PERMISSION_SCOPES[scopeIndex]!;
  const { permissions, effective } = previewPermissionSettings(edit, changes);
  const currentMode = edit.permissions ? (edit.permissions.defaultMode ?? "allowAll") : effective.defaultMode;
  const targetLabel = edit.target === "project" ? "Project" : "User";

  async function save(nextChanges: PermissionSettingsChanges): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const message = await onSave(edit.target, nextChanges);
      onStatusMessage(message);
      onClose();
    } catch (cause) {
      setError(`Could not save permissions: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSaving(false);
    }
  }

  let items: DropdownMenuItem[];
  if (step === "home") {
    items = [
      { key: "defaultMode", label: "defaultMode", description: currentMode },
      { key: "scopes", label: "scopes", description: "Set permissions by scope" },
    ];
  } else if (step === "defaultMode") {
    items = MODES.map((mode) => {
      const next = previewPermissionSettings(edit, { defaultMode: mode }).effective.defaultMode;
      const description = mode === "askAll" ? "Ask unless a scope has a rule" : "Allow unless a scope has a rule";
      return {
        key: mode,
        label: mode,
        selected: mode === currentMode,
        description: next === mode ? description : `${description} · effective: ${next} (Project)`,
      };
    });
  } else if (step === "scopes") {
    items = [
      ...PERMISSION_SCOPES.map((item) => ({
        key: item,
        label: item,
        description: describeScopeSetting(edit, changes, item),
      })),
      { key: "save", label: "Save", description: "Save changes" },
    ];
  } else {
    items = DECISIONS.map((decision, index) => {
      const description = describeScopeSetting(edit, { scopes: { ...changes.scopes, [scope]: decision } }, scope);
      const effectiveHint = description.includes(" · ") ? description.slice(description.indexOf(" · ")) : "";
      return {
        key: decision,
        label: decision,
        selected: decision === getPermissionScopeSelection(permissions, scope),
        description: `${DECISION_DESCRIPTIONS[index]}${effectiveHint}`,
      };
    });
  }

  useTerminalInput((input, key) => {
    if (saving || key.paste) return;
    if (key.tab) {
      onClose();
    } else if (key.escape) {
      setError(null);
      if (step === "home") onClose();
      else if (step === "scope") {
        setStep("scopes");
        setActiveIndex(scopeIndex);
      } else {
        setStep("home");
        setActiveIndex(step === "scopes" ? 1 : 0);
        setChanges({});
      }
    } else if (key.upArrow || key.downArrow) {
      setActiveIndex((index) => (index + (key.upArrow ? -1 : 1) + items.length) % items.length);
    } else if (!key.ctrl && !key.meta && !key.shift && (key.return || input === " ")) {
      setError(null);
      if (step === "home") {
        setStep(activeIndex === 0 ? "defaultMode" : "scopes");
        setActiveIndex(activeIndex === 0 ? MODES.indexOf(currentMode) : 0);
      } else if (step === "defaultMode") {
        void save({ defaultMode: MODES[activeIndex]! });
      } else if (step === "scopes") {
        if (activeIndex === PERMISSION_SCOPES.length) void save(changes);
        else {
          setScopeIndex(activeIndex);
          setStep("scope");
          setActiveIndex(DECISIONS.indexOf(getPermissionScopeSelection(permissions, PERMISSION_SCOPES[activeIndex]!)));
        }
      } else {
        const selection = DECISIONS[activeIndex]!;
        const scopes = { ...changes.scopes };
        if (selection === getPermissionScopeSelection(edit.permissions, scope)) delete scopes[scope];
        else scopes[scope] = selection;
        setChanges({ scopes });
        setStep("scopes");
        setActiveIndex(scopeIndex);
      }
    }
  });

  const title = step === "home" ? "Permissions" : step === "scope" ? scope : step;
  const helpText = saving
    ? "Saving…"
    : step === "home"
      ? "↑↓ move · Enter/Space select · Esc/Tab cancel"
      : step === "defaultMode"
        ? "↑↓ move · Enter/Space save · Esc back · Tab cancel"
        : step === "scopes"
          ? "↑↓ move · Enter/Space select · Save to apply · Esc back (discard) · Tab cancel"
          : "↑↓ move · Enter/Space select · Esc back · Tab cancel";
  return (
    <Box flexDirection="column" width={width}>
      <DropdownMenu
        title={`${title} · ${targetLabel}`}
        width={width}
        items={items}
        activeIndex={activeIndex}
        maxVisible={Math.max(1, Math.min(8, Math.floor((rows - 10) / (width < 60 ? 4 : 2))))}
        helpText={helpText}
        renderItem={(item, active) => (
          <Box paddingX={1} flexDirection="column">
            <Text color={active ? "#229ac3" : undefined}>
              {active ? "> " : "  "}
              {item.selected === undefined ? "" : item.selected ? "● " : "○ "}
              {item.label}
            </Text>
            {item.description ? <Text dimColor>{`  ${item.description}`}</Text> : null}
          </Box>
        )}
      />
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}
