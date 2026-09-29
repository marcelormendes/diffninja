import { describe, expect, test } from "vitest";
import { resolveExecutable } from "../src/executables.js";

const onWindows = (files: string[], path: string) => ({ platform: "win32" as const, env: { PATH: path }, exists: (candidate: string) => files.includes(candidate) });

describe("resolveExecutable", () => {
  test("leaves the name alone where PATH lookup already ignores the working directory", () => {
    expect(resolveExecutable("git", { platform: "linux" })).toBe("git");
    expect(resolveExecutable("gh", { platform: "darwin" })).toBe("gh");
  });

  test("on Windows finds git.exe in PATH's absolute entries, in order, and returns its full path", () => {
    const lookup = onWindows(["C:\\Tools\\git.exe", "C:\\Program Files\\Git\\cmd\\git.exe"], "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd;C:\\Tools");
    expect(resolveExecutable("git", lookup)).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
    expect(resolveExecutable("git", onWindows(["C:\\Tools\\git.exe"], '"C:\\Tools"'))).toBe("C:\\Tools\\git.exe");
  });

  test("never takes a binary from the working directory: relative, empty and dot PATH entries are skipped", () => {
    // Even if a git.exe sat in ".", "" or a relative folder, the real one wins or nothing does.
    const files = ["git.exe", ".\\git.exe", "tools\\git.exe", "C:\\Real\\git.exe"];
    expect(resolveExecutable("git", onWindows(files, ".;;tools;C:\\Real"))).toBe("C:\\Real\\git.exe");
    expect(() => resolveExecutable("git", onWindows(files, ".;;tools"))).toThrow(/git was not found on PATH.*never the repository or the current directory/);
  });

  test("only real executables count: a .cmd or .bat cannot be started without a shell", () => {
    expect(() => resolveExecutable("gh", onWindows(["C:\\Tools\\gh.cmd", "C:\\Tools\\gh.bat"], "C:\\Tools"))).toThrow(/gh was not found/);
    expect(resolveExecutable("gh", onWindows(["C:\\Tools\\gh.com"], "C:\\Tools"))).toBe("C:\\Tools\\gh.com");
  });

  test("reads a Windows-cased Path variable too", () => {
    expect(resolveExecutable("git", { platform: "win32", env: { Path: "C:\\Tools" }, exists: (candidate) => candidate === "C:\\Tools\\git.exe" })).toBe("C:\\Tools\\git.exe");
  });
});
