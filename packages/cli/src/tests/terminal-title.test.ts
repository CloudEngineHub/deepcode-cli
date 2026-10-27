import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerminalTitle } from "../utils/terminal-title";

test("terminal titles follow changes, deduplicate writes and clear on exit", () => {
  const writes: string[] = [];
  const title = createTerminalTitle({ isTTY: true, write: (text) => writes.push(text) });
  title.set("Deep Code");
  title.set("修复登录");
  title.set("修复登录");
  title.set("Another session");
  title.clear();
  title.clear();
  assert.deepEqual(writes, [
    "\u001b]0;Deep Code\u0007",
    "\u001b]0;修复登录\u0007",
    "\u001b]0;Another session\u0007",
    "\u001b]0;\u0007",
  ]);
});

test("terminal titles strip escape sequences and control characters", () => {
  const writes: string[] = [];
  const title = createTerminalTitle({ isTTY: true, write: (text) => writes.push(text) });
  title.set("Fix\u001b[31m login\u001b[0m\u0007\n\r\u009c\u2028");
  assert.deepEqual(writes, ["\u001b]0;Fix login\u0007"]);
});

test("non-TTY output never receives title control sequences", () => {
  const writes: string[] = [];
  const title = createTerminalTitle({ write: (text) => writes.push(text) });
  title.set("Fix login");
  title.clear();
  assert.deepEqual(writes, []);
});
