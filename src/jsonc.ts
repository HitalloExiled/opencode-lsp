/**
 * Minimal JSONC reader: comments and trailing commas, nothing else.
 *
 * OpenCode config files are JSONC. The plugin cannot ask the host for its
 * merged config, so it parses the files itself and only needs the parts JSON
 * does not cover.
 */

/** Parse a JSONC document, tolerating a UTF-8 BOM. Throws on invalid JSON. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(removeTrailingCommas(stripComments(stripBom(text))));
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Remove `//` and block comments outside strings. */
export function stripComments(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      const end = stringEnd(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++;
      index += 2;
      continue;
    }
    out += char;
    index++;
  }
  return out;
}

/** Remove commas that only precede a closing bracket, outside strings. */
export function removeTrailingCommas(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      const end = stringEnd(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      if (text[next] === "}" || text[next] === "]") {
        index++;
        continue;
      }
    }
    out += char;
    index++;
  }
  return out;
}

/** Index just past the closing quote of the string starting at `start`. */
function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') return index + 1;
    index++;
  }
  return text.length;
}
