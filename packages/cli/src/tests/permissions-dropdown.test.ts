import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import React, { useState } from "react";
import { render, Text } from "ink";
import stringWidth from "string-width";
import type { PermissionSettingsChanges, PermissionSettingsEdit } from "@vegamo/deepcode-core";
import { writePermissionSettingsChanges, resolveCurrentSettings } from "@vegamo/deepcode-core";
import PermissionsDropdown, { describeScopeSetting } from "../ui/components/PermissionsDropdown";
import { PromptInput, type PromptSubmission } from "../ui/views/PromptInput";

async function terminal(t: TestContext, element: React.ReactElement, columns = 80) {
  let frame = "";
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        const text = stripVTControlCharacters(chunk.toString());
        if (text.trim()) frame = text;
        done();
      },
    }),
    { isTTY: true, columns, rows: 40 }
  );
  const app = render(element, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  t.after(() => {
    app.unmount();
    app.cleanup();
  });
  async function flush() {
    await setTimeout(35);
    await app.waitUntilRenderFlush();
  }
  await flush();
  return {
    frame: () => frame,
    async send(input: string) {
      stdin.emit("data", input);
      await flush();
    },
  };
}

async function editor(
  t: TestContext,
  options: {
    edit?: PermissionSettingsEdit;
    width?: number;
    save?: (changes: PermissionSettingsChanges) => void | Promise<void>;
  } = {}
) {
  const saves: PermissionSettingsChanges[] = [];
  const statuses: string[] = [];
  let closed = 0;
  function Probe() {
    const [open, setOpen] = useState(true);
    return open
      ? React.createElement(PermissionsDropdown, {
          edit: options.edit ?? { target: "project" },
          width: options.width ?? 80,
          onClose: () => {
            closed++;
            setOpen(false);
          },
          onStatusMessage: (message) => statuses.push(message),
          onSave: async (_target, changes) => {
            await options.save?.(changes);
            saves.push(changes);
            return "Permissions saved";
          },
        })
      : React.createElement(Text, null, "closed");
  }
  const h = await terminal(t, React.createElement(Probe), options.width);
  return { ...h, saves, statuses, closed: () => closed };
}

const DOWN = "\u001b[B";
const UP = "\u001b[A";
const ESC = "\u001b";
const ENTER = "\r";
const TAB = "\t";
const SHIFT_TAB = "\u001b[Z";

test("default mode returns home with a draft and saves only from home", async (t) => {
  const h = await editor(t, { edit: { target: "user", permissions: { defaultMode: "askAll" } } });
  assert.match(h.frame(), /Permissions · User/);
  assert.match(h.frame(), /> defaultMode +askAll/);
  assert.match(h.frame(), /scopes +│/);
  assert.match(h.frame(), /Save +│/);
  assert.doesNotMatch(h.frame(), /Tab/);
  await h.send(ENTER);
  assert.match(h.frame(), /> ● askAll/);
  assert.match(h.frame(), /askAll +│/);
  assert.match(h.frame(), /allowAll +│/);
  await h.send(DOWN);
  await h.send(" ");
  assert.match(h.frame(), /Permissions · User/);
  assert.match(h.frame(), /> defaultMode +allowAll/);
  assert.deepEqual(h.saves, []);
  assert.equal(h.closed(), 0);
  await h.send(ENTER);
  assert.match(h.frame(), /> ● allowAll/);
  await h.send(ESC);
  await h.send(UP); // wrap to Save
  await h.send(ENTER);
  assert.deepEqual(h.saves, [{ defaultMode: "allowAll" }]);
  assert.equal(h.closed(), 1);
  assert.deepEqual(h.statuses, ["Permissions saved"]);
});

test("scope edits accumulate, preserve list position and save only after Save", async (t) => {
  const h = await editor(t);
  await h.send(DOWN);
  await h.send(ENTER);
  assert.doesNotMatch(h.frame(), /Save/);
  await h.send(ENTER);
  assert.match(h.frame(), /> ● default/);
  await h.send(DOWN); // wrap from default to allow
  await h.send(ENTER);
  assert.match(h.frame(), /> read-in-cwd/);
  assert.deepEqual(h.saves, []);
  await h.send(DOWN);
  await h.send(ENTER);
  await h.send(UP); // default -> ask
  await h.send(ENTER);
  assert.match(h.frame(), /> read-in-tmp/);
  assert.deepEqual(h.saves, []);
  await h.send(ESC); // home retains the draft
  await h.send(DOWN);
  assert.match(h.frame(), /> Save/);
  await h.send(ENTER);
  assert.deepEqual(h.saves, [{ scopes: { "read-in-cwd": "allow", "read-in-tmp": "ask" } }]);
});

test("Esc preserves drafts in submenus and discards them when closing home", async (t) => {
  const h = await editor(t);
  await h.send(DOWN);
  await h.send(ENTER);
  await h.send(DOWN);
  await h.send(ENTER);
  await h.send(ESC);
  assert.match(h.frame(), /> read-in-tmp/);
  await h.send(ENTER);
  await h.send(DOWN);
  await h.send(ENTER);
  await h.send(ESC);
  assert.match(h.frame(), /Permissions · Project/);
  await h.send(ENTER); // scopes again, draft retained
  await h.send(DOWN);
  await h.send(ENTER);
  assert.match(h.frame(), /> ● allow/);
  await h.send(ESC);
  await h.send(ESC);
  await h.send(UP);
  await h.send(ENTER); // defaultMode
  await h.send(UP); // allowAll -> askAll
  await h.send(ENTER);
  assert.match(h.frame(), /> defaultMode +askAll/);
  await h.send(ESC);
  assert.equal(h.closed(), 1);
  assert.deepEqual(h.saves, []);
});

test("Tab and Shift+Tab do nothing on every permissions page", async (t) => {
  const h = await editor(t);
  async function checkTabs() {
    const before = h.frame();
    await h.send(TAB);
    await h.send(SHIFT_TAB);
    assert.equal(h.frame(), before);
    assert.equal(h.closed(), 0);
    assert.deepEqual(h.saves, []);
    assert.doesNotMatch(h.frame(), /Tab/);
  }
  await checkTabs();
  await h.send(ENTER);
  await checkTabs();
  await h.send(ESC);
  await h.send(DOWN);
  await h.send(ENTER);
  await checkTabs();
  await h.send(ENTER);
  await checkTabs();
});

test("mode and scope drafts survive edits in either order and save failures", async (t) => {
  let attempts = 0;
  const h = await editor(t, {
    save: () => {
      if (++attempts === 1) throw new Error("Read-only settings file");
    },
  });
  await h.send(DOWN);
  await h.send(ENTER);
  await h.send(ENTER);
  await h.send(UP);
  await h.send(ENTER);
  await h.send(ESC);
  await h.send(UP); // home: defaultMode
  await h.send(ENTER);
  await h.send(UP); // allowAll -> askAll
  await h.send(ENTER);
  await h.send(DOWN);
  await h.send(ENTER); // scopes again
  assert.match(h.frame(), /read-in-cwd +ask/);
  assert.match(h.frame(), /read-in-tmp +default · effective: ask/);
  await h.send(DOWN);
  await h.send(ENTER);
  assert.match(h.frame(), /default +Remove this level's rule · effective: ask/);
  await h.send(DOWN); // default -> allow
  await h.send(ENTER);
  await h.send(ESC);
  await h.send(DOWN); // Save
  await h.send(ENTER);
  assert.match(h.frame(), /Read-only settings file/);
  assert.match(h.frame(), /Permissions · Project/);
  assert.match(h.frame(), /> Save/);
  assert.equal(h.closed(), 0);
  await h.send(ENTER);
  assert.deepEqual(h.saves, [{ defaultMode: "askAll", scopes: { "read-in-cwd": "ask", "read-in-tmp": "allow" } }]);
  assert.equal(h.closed(), 1);
});

test("pending saves ignore duplicate submissions and navigation", async (t) => {
  let finish!: () => void;
  let attempts = 0;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const h = await editor(t, {
    save: () => {
      attempts++;
      return pending;
    },
  });
  await h.send(UP);
  await h.send(ENTER);
  assert.match(h.frame(), /Saving…/);
  for (const input of [ENTER, " ", DOWN, ESC, TAB, SHIFT_TAB]) await h.send(input);
  assert.equal(attempts, 1);
  assert.equal(h.closed(), 0);
  assert.match(h.frame(), /> Save/);
  finish();
  await h.send("");
  assert.equal(h.closed(), 1);
  assert.deepEqual(h.saves, [{}]);
});

test("conflicts identify the effective decision and layer without treating default as an override", () => {
  assert.equal(
    describeScopeSetting(
      { target: "project", otherPermissions: { deny: ["network"] } },
      { scopes: { network: "allow" } },
      "network"
    ),
    "allow · effective: deny (User)"
  );
  assert.equal(
    describeScopeSetting(
      { target: "project", permissions: { allow: ["network"] }, otherPermissions: { ask: ["network"] } },
      { scopes: { network: "default" } },
      "network"
    ),
    "default · effective: ask (User)"
  );
  assert.equal(
    describeScopeSetting({ target: "user", otherPermissions: { defaultMode: "askAll" } }, {}, "network"),
    "default · effective: ask (Project)"
  );
});

test("narrow terminals keep descriptions beside labels and scroll through scopes", async (t) => {
  const h = await editor(t, { width: 36 });
  assert.match(h.frame(), /Save/);
  await h.send(DOWN);
  await h.send(ENTER);
  assert.match(h.frame(), /read-out-cwd/);
  assert.match(h.frame(), /read-in-cwd +default/);
  assert.doesNotMatch(h.frame(), /Save/);
  // Each scope takes one line; there are no continuation lines for descriptions.
  const scopeRows = h
    .frame()
    .split("\n")
    .filter((line) => /(?:read|write|delete)-|network|mcp|effective/.test(line));
  assert.equal(scopeRows.length, 8);
  assert.ok(
    h
      .frame()
      .split("\n")
      .every((line) => stringWidth(line) <= 36)
  );
  await h.send(UP);
  assert.match(h.frame(), /delete-out-cwd/);
  assert.match(h.frame(), /> mcp/);
  assert.ok(
    h
      .frame()
      .split("\n")
      .every((line) => stringWidth(line) <= 36)
  );
  await h.send(ENTER);
  assert.match(h.frame(), /allow +Allow/);
  assert.ok(
    h
      .frame()
      .split("\n")
      .every((line) => stringWidth(line) <= 36)
  );
});

test("slash command opens the editor, persists settings, and isolates menu keys from the prompt", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permissions-prompt-"));
  t.mock.method(os, "homedir", () => path.join(root, "user"));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(path.join(projectRoot, ".deepcode"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".deepcode", "settings.json"), "{}");
  const submissions: PromptSubmission[] = [];
  let interruptions = 0;
  let toggles = 0;
  let planModeChanges = 0;
  const h = await terminal(
    t,
    React.createElement(PromptInput, {
      projectRoot,
      skills: [],
      modelConfig: { model: "test", thinkingEnabled: false, reasoningEffort: "high" },
      screenWidth: 80,
      promptHistory: [],
      busy: false,
      planMode: false,
      onSubmit: (submission) => submissions.push(submission),
      onPromptDraftApplied() {},
      onModelConfigChange: () => "",
      onPermissionSettingsChange: (target, changes) => {
        writePermissionSettingsChanges(target, changes, projectRoot);
        return "Permissions saved";
      },
      onPlanModeChange() {
        planModeChanges++;
      },
      onInterrupt: () => {
        interruptions++;
      },
      onToggleProcessStdout: () => {
        toggles++;
      },
    })
  );
  await h.send("/permissions");
  await h.send(ENTER);
  assert.match(h.frame(), /Permissions · Project/);
  await h.send("stray text");
  await h.send("\u000f");
  await h.send(TAB);
  await h.send(SHIFT_TAB);
  assert.match(h.frame(), /Permissions · Project/);
  await h.send(ENTER);
  await h.send(UP);
  await h.send(ENTER);
  assert.equal(resolveCurrentSettings(projectRoot).permissions.defaultMode, "allowAll");
  assert.match(h.frame(), /> defaultMode +askAll/);
  await h.send(UP); // Save
  await h.send(ENTER);
  assert.equal(resolveCurrentSettings(projectRoot).permissions.defaultMode, "askAll");
  assert.match(h.frame(), /Permissions saved/);
  assert.equal(submissions.length, 0);
  await h.send("/perm");
  await h.send(ENTER);
  assert.match(h.frame(), /Permissions · Project/);
  await h.send(ESC);
  assert.equal(interruptions, 0);
  assert.equal(toggles, 0);
  assert.equal(planModeChanges, 0);
  await h.send("hello");
  await h.send(ENTER);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0]?.text, "hello");
});
