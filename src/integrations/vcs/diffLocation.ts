/** Check an actual line in the supplied patch, not only its hunk header range. */
export function patchContainsLine(patch: string, line: number, side: "left" | "right" = "right"): boolean {
  if (!Number.isSafeInteger(line) || line <= 0) return false;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const text of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
      newRemaining = header[4] === undefined ? 1 : Number(header[4]);
      continue;
    }
    if (text.startsWith("\\ No newline at end of file")) continue;
    const prefix = text[0];
    if (prefix === " " && oldRemaining > 0 && newRemaining > 0) {
      if ((side === "left" ? oldLine : newLine) === line) return true;
      oldLine++; newLine++; oldRemaining--; newRemaining--;
    } else if (prefix === "-" && oldRemaining > 0) {
      if (side === "left" && oldLine === line) return true;
      oldLine++; oldRemaining--;
    } else if (prefix === "+" && newRemaining > 0) {
      if (side === "right" && newLine === line) return true;
      newLine++; newRemaining--;
    } else {
      oldRemaining = 0; newRemaining = 0;
    }
  }
  return false;
}
