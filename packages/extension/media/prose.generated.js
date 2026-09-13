"use strict";
(() => {
  // src/ui/prose.ts
  var ALIGNMENT = /[↑↓←→⬆⬇▲▼│┃─━┌┐└┘├┤┬┴┼╭╮╰╯╱╲]/;
  var CARET_ARROW = /^\s*\^+\s*$/;
  function isAlignmentLine(line) {
    return ALIGNMENT.test(line) || CARET_ARROW.test(line);
  }
  function splitProse(text) {
    const lines = text.split("\n");
    const art = new Array(lines.length).fill(false);
    lines.forEach((line, index) => {
      if (!isAlignmentLine(line)) {
        return;
      }
      art[index] = true;
      for (const neighbour of [index - 1, index + 1]) {
        if (lines[neighbour] !== void 0 && lines[neighbour]?.trim() !== "") {
          art[neighbour] = true;
        }
      }
    });
    const segments = [];
    for (let index = 0; index < lines.length; index += 1) {
      const kind = art[index] ? "art" : "text";
      const last = segments[segments.length - 1];
      if (last && last.kind === kind) {
        last.text += `
${lines[index] ?? ""}`;
      } else {
        segments.push({ kind, text: lines[index] ?? "" });
      }
    }
    return segments.map((segment) => ({ ...segment, text: segment.text.replace(/^\n+|\n+$/g, "") })).filter((segment) => segment.text.length > 0);
  }

  // src/ui/prose.browser.ts
  globalThis.dwtdSplitProse = splitProse;
})();
