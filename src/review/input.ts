import { execFileSync } from "node:child_process";
import type { ReviewUnit } from "./types.js";

function pathName(raw: string): string {
  const value = raw.split("\t")[0];
  if (value.startsWith('"')) {
    // Keep Git's quoted path verbatim rather than guessing at octal escapes.
    // A quoted path (or one containing " b/") therefore differs from the
    // repo-relative path the engine reports, which downstream file matching and
    // definition reads compare against.
    return value;
  }
  return value.replace(/^[ab]\//, "");
}

/** Reject incomplete patches rather than silently omitting review work. */
export function parseDiff(text: string): ReviewUnit[] {
  if (!text.trim()) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const units: ReviewUnit[] = [];
  let file = "", metadata: string[] = [], found = false;
  const add = (unit: Omit<ReviewUnit, "id">) => units.push({ ...unit, id: `hunk-${units.length + 1}` });
  const flushMetadata = () => {
    const important = metadata.filter(line => /^(old mode|new mode|rename |copy |similarity |dissimilarity |Binary files|GIT binary patch|Submodule|new file mode 120000|new file mode 160000)/.test(line));
    if (important.length || (file && !found)) {
      add({ file, header: "File metadata", diff: metadata.join("\n"), added: 0, removed: 0, oldStart: 0, newStart: 0,
        special: "Binary, rename, mode, or metadata-only change needs manual review." });
    }
    metadata = []; found = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      flushMetadata();
      file = / b\/(.*)$/.exec(line)?.[1] ?? line.slice(11); metadata.push(line); continue;
    }
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ") || line.startsWith("@@@")) {
      throw new Error("Combined merge diffs are unsupported. Supply a two-commit unified diff.");
    }
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      if (found) flushMetadata();
      const oldPath = pathName(line.slice(4));
      const newPath = pathName(lines[++i].slice(4));
      file = newPath === "/dev/null" ? oldPath : newPath;
      metadata.push(line, lines[i]); continue;
    }
    if (line.startsWith("@@")) {
      if (!file) throw new Error("Hunk has no file header.");
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) throw new Error(`Malformed hunk header: ${line}`);
      let oldLeft = Number(match[2] ?? 1), newLeft = Number(match[4] ?? 1);
      const body = [line]; let added = 0, removed = 0;
      while (oldLeft > 0 || newLeft > 0) {
        const next = lines[++i];
        if (next === undefined) throw new Error(`Truncated hunk in ${file}`);
        body.push(next);
        if (next === "\\ No newline at end of file") continue;
        if (next.startsWith("+")) { newLeft--; added++; }
        else if (next.startsWith("-")) { oldLeft--; removed++; }
        else if (next.startsWith(" ")) { oldLeft--; newLeft--; }
        else throw new Error(`Invalid or truncated hunk in ${file}`);
        if (oldLeft < 0 || newLeft < 0) throw new Error(`Hunk line counts do not match in ${file}`);
      }
      if (lines[i + 1] === "\\ No newline at end of file") body.push(lines[++i]);
      const unit: Omit<ReviewUnit, "id"> = { file, header: line, diff: body.join("\n"), added, removed,
        oldStart: Number(match[1]), newStart: Number(match[3]) };
      if (/^(new file mode|index).*\b(120000|160000)\b/m.test(metadata.join("\n"))) {
        unit.special = "Symbolic link or submodule change needs manual review.";
      }
      add(unit);
      found = true; continue;
    }
    if (/^[ +-]/.test(line) && found && line.trim()) throw new Error(`Unexpected content outside hunk in ${file}`);
    if (file) metadata.push(line);
    else if (line.trim()) throw new Error("Expected a unified diff with file headers.");
  }
  flushMetadata();
  if (!units.length) throw new Error("No reviewable changes found in input.");
  return units;
}

export function resolveCommit(cwd: string, ref: string): string {
  return execFileSync("git", ["--no-replace-objects", "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd, encoding: "utf8" }).trim();
}

export interface GitDiffInput { diff: string; from: string; to: string }

export function gitDiff(cwd: string, from: string, to: string): GitDiffInput {
  const base = resolveCommit(cwd, from), head = resolveCommit(cwd, to);
  const diff = execFileSync("git", ["--no-replace-objects", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=5", base, head, "--"],
    { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { diff, from: base, to: head };
}
