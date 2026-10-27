import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import { render } from "ink";
import type { SessionMessage } from "@vegamo/deepcode-core";
import { buildProcessOutputItems, type ProcessOutputItem } from "../ui/core/process-output";
import { ProcessStdoutView } from "../ui/views/ProcessStdoutView";
import { PromptInput } from "../ui/views/PromptInput";

function toolMessage(id: string, command: string, output: string, exitCode: number): SessionMessage {
  return {
    id,
    sessionId: "session",
    role: "tool",
    visible: exitCode === 0,
    compacted: false,
    createTime: "2026-01-01T00:00:00Z",
    updateTime: "2026-01-01T00:00:00Z",
    contentParams: null,
    messageParams: { tool_call_id: id },
    meta: { function: { name: "bash", arguments: JSON.stringify({ command }) } },
    content: JSON.stringify({ output, metadata: { exitCode } }),
  };
}

test("history retains repeated commands and failed outputs, and merges a running background call", () => {
  const first = toolMessage("first", "npm test", "passed", 0);
  const failed = toolMessage("second", "npm test", "failed", 1);
  const background = toolMessage("background", "npm start", "started", 0);
  const items = buildProcessOutputItems(
    [first, failed, background],
    new Map([
      [
        "123",
        {
          command: "npm start",
          startTime: first.createTime,
          toolCallId: "background",
          runInBackground: true,
        },
      ],
    ])
  );
  assert.deepEqual(
    items.map((item) => [item.id, item.output, item.exitCode, item.running]),
    [
      ["first", "passed", 0, false],
      ["second", "failed", 1, false],
      ["background", "", null, true],
    ]
  );
  assert.equal(items[2]?.background, true);
  assert.deepEqual(buildProcessOutputItems([{ ...first, content: "invalid json" }], null), []);
});

async function terminal(t: TestContext, element: React.ReactElement) {
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
    { isTTY: true, columns: 120, rows: 24 }
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
    await setTimeout(30);
    await app.waitUntilRenderFlush();
  }
  await flush();
  return {
    frame: () => frame,
    async send(input: string) {
      stdin.emit("data", input);
      await flush();
    },
    async rerender(next: React.ReactElement) {
      app.rerender(next);
      await flush();
    },
  };
}

test("panel retains the selected result, navigates history and targets timeout adjustments", async (t) => {
  const old = buildProcessOutputItems([toolMessage("old", "old command", "old output", 2)], null)[0]!;
  const running: ProcessOutputItem = {
    id: "live",
    command: "npm test",
    pid: "123",
    background: false,
    running: true,
    output: "",
    exitCode: null,
    timeoutMs: 60000,
  };
  const adjustments: string[] = [];
  let dismissed = 0;
  const props = {
    processStdoutRef: { current: new Map([[123, Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")]]) },
    onDismiss: () => {
      dismissed++;
    },
    onAdjustTimeout: (_delta: number, pid: string) => {
      adjustments.push(pid);
      return null;
    },
    screenWidth: 120,
    screenHeight: 15,
  };
  const view = (items: ProcessOutputItem[]) => React.createElement(ProcessStdoutView, { ...props, items });
  const h = await terminal(t, view([old, running]));
  assert.match(h.frame(), /── Process 123 \[npm test\] ──/);
  assert.match(h.frame(), /line 39/);
  await h.send("+");
  assert.deepEqual(adjustments, ["123"]);
  await h.send("\u001b[A");
  assert.doesNotMatch(h.frame(), /line 39/);
  await h.send("\u001b[D");
  assert.match(h.frame(), /── \(return 2\) \[old command\] ──/);
  await h.send("+");
  assert.deepEqual(adjustments, ["123"]);
  await h.send("\u001b[D");
  assert.match(h.frame(), /old output/);
  await h.send("\u001b[C");
  assert.match(h.frame(), /line 39/);

  const completed = { ...running, running: false, output: "finished", exitCode: 0 };
  const next = { ...running, id: "next", pid: "456", command: "next command", background: true };
  await h.rerender(view([old, completed, next]));
  assert.match(h.frame(), /── \(return 0\) \[npm test\] ──/);
  assert.match(h.frame(), /finished/);
  await h.send("\u001b[C");
  assert.match(h.frame(), /── Process 456 \(background\) \[next command\] ──/);
  await h.send("+");
  assert.deepEqual(adjustments, ["123"]);
  await h.send("\u000f");
  assert.equal(dismissed, 1);
});

test("Ctrl+O opens output for an empty prompt and expands pasted text in a nonempty prompt", async (t) => {
  let opened = 0;
  const h = await terminal(
    t,
    React.createElement(PromptInput, {
      projectRoot: process.cwd(),
      skills: [],
      modelConfig: { model: "test", thinkingEnabled: false, reasoningEffort: "high" },
      screenWidth: 120,
      promptHistory: [],
      busy: false,
      planMode: false,
      onSubmit() {},
      onPromptDraftApplied() {},
      onModelConfigChange: () => "",
      onPlanModeChange() {},
      onInterrupt() {},
      onToggleProcessStdout: () => {
        opened++;
      },
    })
  );
  await h.send("\u000f");
  assert.equal(opened, 1);
  await h.send(" ");
  await h.send("\u000f");
  assert.equal(opened, 1);
  await h.send("\u007f");
  await h.send("\u001b[200~" + Array.from({ length: 20 }, (_, i) => `pasted line ${i}`).join("\n") + "\u001b[201~");
  assert.match(h.frame(), /\[paste #1 \+20 lines\]/);
  await h.send("\u000f");
  assert.equal(opened, 1);
  assert.match(h.frame(), /pasted line 0/);
  assert.doesNotMatch(h.frame(), /\[paste #1/);
  await h.send("\u000f");
  assert.match(h.frame(), /\[paste #1 \+20 lines\]/);
});
