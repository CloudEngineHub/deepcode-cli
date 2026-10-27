import { stripVTControlCharacters } from "node:util";

type TitleOutput = { isTTY?: boolean; write: (text: string) => unknown };

export function createTerminalTitle(output: TitleOutput) {
  let lastTitle: string | undefined;
  return {
    set(title: string): void {
      if (!output.isTTY) return;
      const clean = Array.from(stripVTControlCharacters(title))
        .filter((char) => {
          const code = char.codePointAt(0)!;
          return code >= 0x20 && !(code >= 0x7f && code <= 0x9f) && code !== 0x2028 && code !== 0x2029;
        })
        .join("");
      if (clean === lastTitle) return;
      output.write(`\u001b]0;${clean}\u0007`);
      lastTitle = clean;
    },
    clear(): void {
      if (lastTitle === undefined) return;
      this.set("");
      lastTitle = undefined;
    },
  };
}
