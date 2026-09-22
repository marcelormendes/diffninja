import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { outdent } from "outdent";
import { describe, expect, test } from "vitest";
import { gitDiff, parseDiff } from "../src/review/input.js";
import { checkReferences } from "../src/review/reference-check.js";
import { workspace } from "./workspace.js";
import type { WorkspaceHost } from "./workspace.js";

const project = outdent`
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "strict": true
    }
  }
`;

const aliasProject = outdent`
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "strict": true,
      "baseUrl": ".",
      "paths": { "@app/*": ["src/*"] }
    }
  }
`;

const ignoreNodeModules = "/node_modules\n";

/**
 * Link this repository's own installed compiler into the fixture, standing in
 * for the dependency install of the opted-in project.
 */
function installCompiler(root: string): void {
  const resolved = createRequire(import.meta.url).resolve("typescript");
  const target = join(root, "node_modules", "typescript");
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(dirname(dirname(resolved)), target, "dir");
}

async function checkRange(host: WorkspaceHost, from: string, to: string, projectPath = "tsconfig.json") {
  const range = gitDiff(host.root, from, to);
  return checkReferences(host.root, range.from, range.to, parseDiff(range.diff), projectPath);
}

function repoStatus(root: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
}

describe("introduced versus pre-existing unresolved references", () => {
  test("reports only references the head revision introduces, with snapshot provenance", async () => {
    const host = workspace();
    installCompiler(host.root);
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/src/main.ts": outdent`
        import { missing } from "./missing.js";
        export const value = missing;
        export const other = notDefined;
      `,
    });
    const head = host.commit("head", {
      "/src/main.ts": outdent`
        // a new comment that shifts every line below it
        // and another one
        import { missing } from "./missing.js";
        import { absent } from "./absent.js";
        export const value = missing;
        export const other = notDefined;
        const box = { width: 1 };
        export const height = box.height;
      `,
      "/src/added.ts": outdent`
        import { gone } from "./gone.js";
        export const added = gone;
      `,
    });

    const { findings, check } = await checkRange(host, base, head);

    // Two of the three head errors are the shifted pre-existing ones, matched
    // by content, so only the genuinely new references are reported.
    expect(findings.map(finding => finding.title)).toEqual([
      "TS2307: Cannot find module './gone.js' or its corresponding type declarations.",
      "TS2307: Cannot find module './absent.js' or its corresponding type declarations.",
      "TS2339: Property 'height' does not exist on type '{ width: number; }'.",
    ]);
    expect(findings.some(finding => finding.title.includes("missing.js"))).toBe(false);
    expect(findings.some(finding => finding.title.includes("notDefined"))).toBe(false);

    expect(check.kind).toBe("broken-reference");
    expect(check.status).toBe("checked");
    expect(check.detail).toContain("2 matched a pre-existing error");
    expect(check.detail).toContain("3 are reported as introduced");
    expect(check.detail).not.toContain("Not verified:");

    // A newly added file has no base snapshot, so its reference is new; the
    // evidence keeps the head revision, the head line, and the source text.
    expect(findings[0].scope).toBe("src/added.ts:1");
    expect(findings[0].unitIds).toEqual(["hunk-1"]);
    expect(findings[1].scope).toBe("src/main.ts:4");
    expect(findings[1].limitation).toContain("not evidence that the project builds");
    expect(findings[1].evidence).toEqual([
      {
        id: "reference-2-head",
        label: "TS2307",
        file: "src/main.ts",
        line: 4,
        ref: head.slice(0, 8),
        text: 'import { absent } from "./absent.js";',
        role: "change",
      },
    ]);
    expect(findings[2].scope).toBe("src/main.ts:8");

    // The reviewed repository is only ever read.
    expect(repoStatus(host.root)).toBe("");
  });

  test("keeps a reflowed pre-existing diagnostic pre-existing", async () => {
    const host = workspace();
    installCompiler(host.root);
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/src/main.ts": "export const value = notHere;\n",
    });
    const head = host.commit("head", { "/src/main.ts": "export const value =  notHere;\n" });

    const { findings, check } = await checkRange(host, base, head);

    expect(findings).toEqual([]);
    expect(check.status).toBe("checked");
    expect(check.detail).toContain("1 matched a pre-existing error");
  });

  test("reports a broken reference an unchanged module develops when an export is removed", async () => {
    const host = workspace();
    installCompiler(host.root);
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/src/helper.ts": "export const helper = 1;\nexport const keep = 2;\n",
      "/src/uses-helper.ts": 'import { helper } from "./helper.js";\nexport const value = helper;\n',
    });
    const head = host.commit("head", {
      "/src/helper.ts": "export const keep = 2;\n",
    });

    const { findings, check } = await checkRange(host, base, head);

    // Only helper.ts changed, yet the error appears in the unchanged consumer.
    expect(findings.map(finding => finding.title)).toEqual([
      "TS2305: Module '\"./helper.js\"' has no exported member 'helper'.",
    ]);
    expect(findings[0].scope).toBe("src/uses-helper.ts:1");
    expect(findings[0].unitIds).toEqual([]);
    expect(check.status).toBe("checked");
    expect(check.detail).toContain("finding(s) in files this diff does not change");
  });

  test("resolves an import of an unchanged module and a path alias", async () => {
    const host = workspace();
    installCompiler(host.root);
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": aliasProject,
      "/src/helper.ts": "export const helper = 1;\nexport const other = 2;\n",
      "/src/main.ts": "export const value = 1;\n",
    });
    const head = host.commit("head", {
      "/src/main.ts": outdent`
        import { helper } from "@app/helper.js";
        import { other } from "./helper.js";
        export const value = helper + other;
      `,
    });

    const { findings, check } = await checkRange(host, base, head);

    expect(findings).toEqual([]);
    expect(check.status).toBe("checked");
    expect(check.detail).toContain("0 are reported as introduced");
  });

  test("sees a global supplied by an unchanged declaration file", async () => {
    const host = workspace();
    installCompiler(host.root);
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/src/globals.d.ts": "declare const APP_VERSION: string;\n",
      "/src/main.ts": "export const value = 1;\n",
    });
    const head = host.commit("head", { "/src/main.ts": "export const value = APP_VERSION;\n" });

    const { findings, check } = await checkRange(host, base, head);

    expect(findings).toEqual([]);
    expect(check.status).toBe("checked");
  });

  test("never reports references from a file the change removes", async () => {
    const host = workspace();
    installCompiler(host.root);
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/src/gone.ts": 'import { x } from "./nowhere.js";\nexport const value = x;\n',
      "/src/main.ts": "export const value = 1;\n",
    });
    host.remove("src/gone.ts");
    const head = host.commit("delete gone.ts");

    const { findings, check } = await checkRange(host, base, head);

    expect(findings).toEqual([]);
    expect(check.status).toBe("checked");
    expect(check.detail).toContain("1 at base, 0 at head");
  });

  test("never reports an error from an installed package's own sources", async () => {
    const host = workspace();
    installCompiler(host.root);
    // The installed package ships a .d.ts that itself has a broken reference.
    // Under `preserveSymlinks` TypeScript keeps the snapshot's node_modules
    // path for it, so only physical ownership and tracked-file membership keep
    // that error out of the report.
    const config = outdent`
      {
        "compilerOptions": {
          "target": "ES2022",
          "module": "NodeNext",
          "moduleResolution": "NodeNext",
          "strict": true,
          "preserveSymlinks": true
        }
      }
    `;
    const brokenDep = join(host.root, "node_modules", "broken-dep");
    mkdirSync(brokenDep, { recursive: true });
    writeFileSync(join(brokenDep, "package.json"), '{ "name": "broken-dep", "version": "1.0.0", "types": "index.d.ts" }\n');
    writeFileSync(join(brokenDep, "index.d.ts"), "import { gone } from './absent-in-package.js';\nexport declare const dep: number;\n");
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": config,
      "/package.json": '{ "dependencies": { "broken-dep": "^1.0.0" } }\n',
      "/src/main.ts": "export const value = 1;\n",
    });
    const head = host.commit("head", {
      "/src/main.ts": 'import { dep } from "broken-dep";\nexport const value = dep;\n',
    });

    const { findings, check } = await checkRange(host, base, head);

    // The package's own unresolved import is not this revision's source.
    expect(findings).toEqual([]);
    expect(check.status).toBe("checked");
  });

  test("does not report a namespace-property error whose message embeds a snapshot path", async () => {
    const host = workspace();
    installCompiler(host.root);
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/src/lib.ts": "export const real = 1;\n",
      "/src/main.ts": 'import * as lib from "./lib.js";\nexport const value = lib.missing;\n',
    });
    // Only an unrelated comment is added: the error is unchanged, but
    // TypeScript renders it as `typeof import("<root>/src/lib")`, and the base
    // and head snapshots have different roots.
    const head = host.commit("head", {
      "/src/main.ts": '// shifted\nimport * as lib from "./lib.js";\nexport const value = lib.missing;\n',
    });

    const { findings, check } = await checkRange(host, base, head);

    expect(findings).toEqual([]);
    expect(check.status).toBe("checked");
    expect(check.detail).toContain("1 matched a pre-existing error");
  });

  test("reports a new namespace-property error without leaking the snapshot path", async () => {
    const host = workspace();
    installCompiler(host.root);
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/src/lib.ts": "export const real = 1;\n",
      "/src/main.ts": 'import * as lib from "./lib.js";\nexport const value = lib.real;\n',
    });
    const head = host.commit("head", {
      "/src/main.ts": 'import * as lib from "./lib.js";\nexport const value = lib.gone;\n',
    });

    const { findings, check } = await checkRange(host, base, head);

    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain("Property 'gone' does not exist");
    expect(findings[0].title).toContain("<snapshot>");
    expect(findings[0].title).not.toContain("diffninja-reference-");
    expect(check.status).toBe("checked");
  });
});

/**
 * `count` top-level statements each referencing an undefined name, so every
 * line produces exactly one unresolved-reference error.
 */
function manyErrors(offset: number, count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `export const v${offset + index} = missing${offset + index};`,
  ).join("\n") + "\n";
}

describe("comparison bounds", () => {
  test("refuses the comparison instead of truncating a revision past the error cap", async () => {
    const host = workspace();
    installCompiler(host.root);
    // 501 errors in each revision, the head fixing the first and adding one at
    // the end. Truncating each list at the cap would shift the base boundary,
    // making the base's last error look introduced while the real introduction
    // fell past the cut.
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/src/many.ts": manyErrors(1, 501),
    });
    const head = host.commit("head", { "/src/many.ts": manyErrors(2, 501) });

    const { findings, check } = await checkRange(host, base, head);

    expect(findings).toEqual([]);
    expect(check.status).toBe("not-checked");
    expect(check.detail).toContain("more than 500 unresolved-reference errors");
  });

  test("still compares a revision whose error count is exactly the cap", async () => {
    const host = workspace();
    installCompiler(host.root);
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/src/many.ts": manyErrors(1, 500),
    });
    const head = host.commit("head", { "/src/many.ts": manyErrors(2, 500) });

    const { findings, check } = await checkRange(host, base, head);

    // 500 pre-existing errors at each revision and one genuinely new reference.
    expect(findings.map(finding => finding.scope)).toEqual(["src/many.ts:500"]);
    expect(findings[0].title).toContain("missing501");
    expect(check.status).toBe("checked");
    expect(check.detail).toContain("499 matched a pre-existing error and 1 are reported as introduced");
  });
});

describe("reference check availability and configuration safety", () => {
  const broken = "export const value = notHere;\n";

  test("reports not-checked when the opted-in project has no installed compiler", async () => {
    const host = workspace();
    const base = host.commit("base", {
      "/tsconfig.json": project,
      "/src/main.ts": "export const value = 1;\n",
    });
    const head = host.commit("head", { "/src/main.ts": broken });

    const { findings, check } = await checkRange(host, base, head);

    expect(findings).toEqual([]);
    expect(check.status).toBe("not-checked");
    expect(check.detail).toContain("No installed TypeScript compiler was found");
  });

  test("rejects a reference project that is not a repository-relative tsconfig", async () => {
    const host = workspace();
    installCompiler(host.root);
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/src/main.ts": "export const value = 1;\n",
    });
    const head = host.commit("head", { "/src/main.ts": broken });
    const range = gitDiff(host.root, base, head);
    const units = parseDiff(range.diff);

    for (const candidate of ["/etc/tsconfig.json", "../tsconfig.json", "missing/tsconfig.json", "src/main.ts", "  "]) {
      const { findings, check } = await checkReferences(host.root, range.from, range.to, units, candidate);
      expect(findings).toEqual([]);
      expect(check.status).toBe("not-checked");
      expect(check.detail).not.toContain("are reported as introduced");
    }
  });

  test("reports not-checked for project references, a configuration error, and a config escape", async () => {
    const cases = [
      {
        config: outdent`
          {
            "compilerOptions": { "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext" },
            "references": [{ "path": "./src" }]
          }
        `,
        reason: "project references",
      },
      {
        config: '{ "compilerOptions": { "moduleResolution": "Nonsense" } }',
        reason: "configuration error",
      },
      {
        config: '{ "compilerOptions": { "target": "ES2022", "baseUrl": ".." } }',
        reason: "resolves inputs outside the isolated snapshot",
      },
    ];
    for (const item of cases) {
      const host = workspace();
      installCompiler(host.root);
      const base = host.commit("base", {
        "/.gitignore": ignoreNodeModules,
        "/tsconfig.json": item.config,
        "/src/main.ts": "export const value = 1;\n",
      });
      const head = host.commit("head", { "/src/main.ts": broken });

      const { findings, check } = await checkRange(host, base, head);

      expect(findings).toEqual([]);
      expect(check.status).toBe("not-checked");
      expect(check.detail).toContain(item.reason);
    }
  });

  test("resolves a dependency installed only in a nested directory under a root project", async () => {
    const host = workspace();
    installCompiler(host.root);
    // The root project compiles the nested package's source; the dependency is
    // installed only at packages/app/node_modules, which Node reaches from the
    // importing file. Omitting that mirror would invent a TS2307.
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/packages/app/src/main.ts": "export const value = 1;\n",
    });
    const head = host.commit("head", {
      "/packages/app/src/main.ts": 'import { dep } from "pkg-dep";\nexport const value = dep;\n',
    });
    const dep = join(host.root, "packages", "app", "node_modules", "pkg-dep");
    mkdirSync(dep, { recursive: true });
    writeFileSync(join(dep, "package.json"), '{ "name": "pkg-dep", "version": "1.0.0", "types": "index.d.ts" }\n');
    writeFileSync(join(dep, "index.d.ts"), "export declare const dep: number;\n");

    const { findings, check } = await checkRange(host, base, head);

    expect(findings).toEqual([]);
    expect(check.status).toBe("checked");
    expect(check.detail).not.toContain("Not verified:");
    // The mirror is a link and the real install gained nothing: no tracked
    // repository content changed.
    expect(execFileSync("git", ["status", "--porcelain", "-uno"], { cwd: host.root, encoding: "utf8" })).toBe("");
  });

  test("refuses a declared dependency that is installed only in a sibling workspace", async () => {
    const host = workspace();
    installCompiler(host.root);
    // The head manifest declares the dependency, but it is installed only for a
    // sibling package. Node would not resolve it from the root either, and a
    // per-directory mirror cannot reproduce that layout, so the revision is
    // refused rather than reported against a guessed resolution.
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/package.json": '{ "dependencies": {} }\n',
      "/src/main.ts": "export const value = 1;\n",
    });
    const head = host.commit("head", {
      "/package.json": '{ "dependencies": { "sibling-dep": "^1.0.0" } }\n',
      "/src/main.ts": 'import { other } from "sibling-dep";\nexport const value = other;\n',
      // A tracked file in the sibling keeps it in the head revision's directory
      // set, so its install is discovered and cannot be reproduced.
      "/packages/other/index.ts": "export const other = 1;\n",
    });
    const dep = join(host.root, "packages", "other", "node_modules", "sibling-dep");
    mkdirSync(dep, { recursive: true });
    writeFileSync(join(dep, "package.json"), '{ "name": "sibling-dep", "version": "1.0.0", "types": "index.d.ts" }\n');
    writeFileSync(join(dep, "index.d.ts"), "export declare const other: number;\n");

    const { findings, check } = await checkRange(host, base, head);

    expect(findings).toEqual([]);
    expect(check.status).toBe("not-checked");
    expect(check.detail).toContain("installed only at packages/other");
  });

  test("resolves a dependency hoisted to the root for a nested project", async () => {
    const host = workspace();
    installCompiler(host.root);
    const nested = outdent`
      {
        "compilerOptions": { "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true },
        "include": ["src/**/*"]
      }
    `;
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/packages/app/tsconfig.json": nested,
      "/packages/app/package.json": '{ "dependencies": { "hoisted-dep": "^1.0.0" } }\n',
      "/packages/app/src/main.ts": "export const value = 1;\n",
    });
    const head = host.commit("head", {
      "/packages/app/src/main.ts": 'import { hoisted } from "hoisted-dep";\nexport const value = hoisted;\n',
    });
    // Installed only at the repository root, which Node reaches by climbing.
    const dep = join(host.root, "node_modules", "hoisted-dep");
    mkdirSync(dep, { recursive: true });
    writeFileSync(join(dep, "package.json"), '{ "name": "hoisted-dep", "version": "1.0.0", "types": "index.d.ts" }\n');
    writeFileSync(join(dep, "index.d.ts"), "export declare const hoisted: number;\n");

    const range = gitDiff(host.root, base, head);
    const { findings, check } = await checkReferences(
      host.root,
      range.from,
      range.to,
      parseDiff(range.diff),
      "packages/app/tsconfig.json",
    );

    expect(findings).toEqual([]);
    expect(check.status).toBe("checked");
    expect(check.detail).not.toContain("Not verified:");
  });

  test("reports not-checked when a declared dependency is not installed", async () => {
    const host = workspace();
    installCompiler(host.root);
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/package.json": '{ "dependencies": { "left-pad": "^1.0.0" } }\n',
      "/src/main.ts": "export const value = 1;\n",
    });
    const head = host.commit("head", { "/src/main.ts": broken });

    const { findings, check } = await checkRange(host, base, head);

    expect(findings).toEqual([]);
    expect(check.status).toBe("not-checked");
    expect(check.detail).toContain("Node cannot resolve from its own directory — left-pad (not installed)");
  });

  test("resolves dependencies installed in a nested project directory", async () => {
    const host = workspace();
    installCompiler(host.root);
    const nested = outdent`
      {
        "compilerOptions": { "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true },
        "include": ["src/**/*"]
      }
    `;
    const base = host.commit("base", {
      "/.gitignore": "/node_modules\n",
      "/packages/app/tsconfig.json": nested,
      "/packages/app/package.json": '{ "dependencies": { "pkg-dep": "^1.0.0" } }\n',
      "/packages/app/src/main.ts": "export const value = 1;\n",
    });
    const head = host.commit("head", {
      "/packages/app/src/main.ts": 'import { dep } from "pkg-dep";\nexport const value = dep;\n',
    });
    // Installed beside the nested project, not at the repository root, and the
    // dependency carries its own types: only the nested node_modules symlink can
    // resolve this import.
    const modules = join(host.root, "packages", "app", "node_modules", "pkg-dep");
    mkdirSync(modules, { recursive: true });
    writeFileSync(join(modules, "package.json"), '{ "name": "pkg-dep", "version": "1.0.0", "types": "index.d.ts" }\n');
    writeFileSync(join(modules, "index.d.ts"), "export declare const dep: number;\n");

    const range = gitDiff(host.root, base, head);
    const { findings, check } = await checkReferences(
      host.root,
      range.from,
      range.to,
      parseDiff(range.diff),
      "packages/app/tsconfig.json",
    );

    expect(findings).toEqual([]);
    expect(check.status).toBe("checked");
  });

  test("reports not-checked when a revision's own manifest needs an uninstalled dependency", async () => {
    const host = workspace();
    installCompiler(host.root);
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/package.json": '{ "dependencies": {} }\n',
      "/src/main.ts": "export const value = 1;\n",
    });
    const head = host.commit("head", {
      "/package.json": '{ "dependencies": { "only-in-head": "^2.0.0" } }\n',
      "/src/main.ts": broken,
    });

    const { findings, check } = await checkRange(host, base, head);

    expect(findings).toEqual([]);
    expect(check.status).toBe("not-checked");
    expect(check.detail).toContain("Node cannot resolve from its own directory — only-in-head (not installed)");
  });

  test("reports not-checked when a program reads a source file outside the revision", async () => {
    const host = workspace();
    installCompiler(host.root);
    // A real file outside the repository that an absolute specifier reaches.
    const elsewhere = mkdtempSync(join(tmpdir(), "diffninja-outside-"));
    const outsideFile = join(elsewhere, "outside.ts");
    writeFileSync(outsideFile, "export const outside = 1;\n");
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/src/main.ts": "export const value = 1;\n",
    });
    const head = host.commit("head", {
      "/src/main.ts": `import { outside } from ${JSON.stringify(outsideFile.replace(/\.ts$/, ".js"))};\nexport const value = outside;\n`,
    });

    const { findings, check } = await checkRange(host, base, head);
    rmSync(elsewhere, { recursive: true, force: true });

    // The absolute specifier escapes the snapshot and TypeScript does read the
    // live file, so the revision is refused instead of judged against it.
    expect(findings).toEqual([]);
    expect(check.status).toBe("not-checked");
    expect(check.detail).toContain("neither snapshot content, an installed dependency, nor a compiler library");
  });

  test("reports not-checked for a paths target or extends chain that leaves the snapshot", async () => {
    const cases = [
      {
        config: '{ "compilerOptions": { "target": "ES2022", "baseUrl": ".", "paths": { "@x/*": ["../outside/*"] } } }',
        reason: "resolves inputs outside the isolated snapshot (paths @x/*",
      },
      {
        config: '{ "extends": "../shared/tsconfig.base.json" }',
        reason: "resolves inputs outside the isolated snapshot (extends ../shared/tsconfig.base.json)",
      },
      {
        config: '{ "extends": ["./base.json", "../../outside.json"] }',
        reason: "resolves inputs outside the isolated snapshot (extends ../../outside.json)",
      },
      {
        config: '{ "extends": "/etc/tsconfig.json" }',
        reason: "resolves inputs outside the isolated snapshot (extends /etc/tsconfig.json)",
      },
      {
        config: '{ "extends": "/tmp/outside/base.json" }',
        reason: "resolves inputs outside the isolated snapshot (extends /tmp/outside/base.json)",
      },
    ];
    for (const item of cases) {
      const host = workspace();
      installCompiler(host.root);
      const base = host.commit("base", {
        "/.gitignore": ignoreNodeModules,
        "/tsconfig.json": item.config,
        "/src/main.ts": "export const value = 1;\n",
      });
      const head = host.commit("head", { "/src/main.ts": broken });

      const { findings, check } = await checkRange(host, base, head);

      expect(findings).toEqual([]);
      expect(check.status).toBe("not-checked");
      expect(check.detail).toContain(item.reason);
    }
  });

  test("reports not-checked when the reference project is absent from a revision", async () => {
    const host = workspace();
    installCompiler(host.root);
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/src/main.ts": "export const value = 1;\n",
    });
    const head = host.commit("head", {
      "/tsconfig.json": project,
      "/src/main.ts": broken,
    });

    const { findings, check } = await checkRange(host, base, head);

    expect(findings).toEqual([]);
    expect(check.status).toBe("not-checked");
    expect(check.detail).toContain("not present in both compared revisions");
  });
});

describe("snapshot materialization safety", () => {
  test("reports not-checked rather than emulating a revision with a symbolic link", async () => {
    const host = workspace();
    installCompiler(host.root);
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/src/real.ts": "export const real = 1;\n",
      "/src/main.ts": "export const value = 1;\n",
    });
    writeFileSync(join(host.root, "src/real.ts"), "export const real = 1;\n");
    symlinkSync("./real.ts", join(host.root, "src", "link.ts"));
    const head = host.commit("head", {
      "/src/main.ts": 'import { real } from "./link.js";\nexport const value = real;\n',
    });

    const { findings, check } = await checkRange(host, base, head);

    expect(findings).toEqual([]);
    expect(check.status).toBe("not-checked");
    expect(check.detail).toContain("symbolic link or submodule (src/link.ts)");
    expect(repoStatus(host.root)).not.toContain("src/link.ts");
  });

  test("leaves the repository working tree and installed dependencies untouched", async () => {
    const host = workspace();
    const base = host.commit("base", {
      "/.gitignore": ignoreNodeModules,
      "/tsconfig.json": project,
      "/src/main.ts": "export const value = 1;\n",
    });
    installCompiler(host.root);
    const before = repoStatus(host.root);
    const head = host.commit("head", { "/src/main.ts": "export const value = notHere;\n" });

    const { check } = await checkRange(host, base, head);

    expect(check.status).toBe("checked");
    expect(repoStatus(host.root)).toBe(before);
    // The stand-in dependency install survived: nothing was written into it.
    expect(existsSync(join(host.root, "node_modules", "typescript", "package.json"))).toBe(true);
  });
});
