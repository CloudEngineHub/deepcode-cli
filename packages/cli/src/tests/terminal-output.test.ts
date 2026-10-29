import assert from "node:assert/strict";
import { test } from "node:test";
import { disableTerminalExtendedKeys, enableTerminalExtendedKeys } from "../ui/hooks/cursor";
import { stripTerminalOutput } from "./terminal-output";

test("terminal capture ignores extended keyboard mode writes without losing visible text", () => {
  for (const control of [enableTerminalExtendedKeys(), disableTerminalExtendedKeys()]) {
    assert.equal(stripTerminalOutput(control), "");
    assert.equal(
      stripTerminalOutput(`\u001b[32m> 中文👋\u001b[0m${control}\nType your message...`),
      "> 中文👋\nType your message..."
    );
  }
});
