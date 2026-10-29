import { stripVTControlCharacters } from "node:util";

export function stripTerminalOutput(text: string): string {
  // Node's stripper leaves text behind for private CSI parameters such as >4;1m.
  // Remove complete CSI sequences before stripping the remaining VT controls.
  return stripVTControlCharacters(text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""));
}
