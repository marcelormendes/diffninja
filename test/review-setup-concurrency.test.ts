import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, open, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { updateFile as updateFileWithIO, type FileEdit, type UpdateFileIO } from "../src/review/setup.js";

/**
 * The filesystem boundary, where these tests schedule real work. Every case
 * below runs the production code and only arranges the order in which its
 * filesystem calls land: no sleeps, no polling, no assumed timing.
 */
interface Boundary {
  /** Called with the name of an exclusive temporary, before the OS sees it. */
  beforeOpen?: (path: string) => void | Promise<void>;
  /** Called once a staged temporary holds its contents. */
  staged?: (path: string) => void | Promise<void>;
  /** Called before a rename lands, with the temporary and the file it replaces. */
  beforeRename?: (from: string, to: string) => Promise<void>;
  /** Stands in for a staging failure, returning the error the write should hit. */
  failStage?: (path: string) => Error | undefined;
  /** Temporaries this process opened, in order. */
  temps: string[];
  /** State reported in place of a file's real state, per path. */
  frozen: Map<string, Record<string, number>>;
}

const boundary: Boundary = { temps: [], frozen: new Map() };

// Real filesystem operations with scheduling gates at the staging boundary.
const io: UpdateFileIO = {
  async open(path, flags, mode) {
    await boundary.beforeOpen?.(path);
    const handle = await open(path, flags, mode);
    boundary.temps.push(path);
    return {
      async writeFile(text) {
        const failure = boundary.failStage?.(path);
        if (failure !== undefined) {
          await handle.writeFile(text.slice(0, 8));
          throw failure;
        }
        await handle.writeFile(text);
        await boundary.staged?.(path);
      },
      chmod: (mode) => handle.chmod(mode),
      close: () => handle.close(),
    };
  },
  async rename(from, to) {
    await boundary.beforeRename?.(from, to);
    await rename(from, to);
  },
  async stat(path) {
    const info = await stat(path);
    return Object.assign(info, boundary.frozen.get(path));
  },
};

function updateFile(path: string, merge: (current: string | undefined) => FileEdit) {
  return updateFileWithIO(path, merge, 3, io);
}

const configSchema = z.record(z.string(), z.union([z.boolean(), z.number(), z.string()]));

/** The temporaries this module stages, by shape alone. */
function isTemp(path: string): boolean {
  return /\.diffninja-[\w-]+\.tmp$/u.test(path);
}

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

/** A promise a test opens by hand, so work can be ordered without a timer. */
function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function fakeHome(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "diffninja-concurrency-")));
}

/** A merge that adds one key, so two merges of one file can be told apart. */
function addKey(key: string) {
  return (current: string | undefined) => {
    const value = configSchema.parse(JSON.parse(current ?? "{}"));
    value[key] = true;
    return { text: `${JSON.stringify(value, null, 2)}\n`, changed: true };
  };
}

function readJson(path: string) {
  return configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

beforeEach(() => {
  boundary.temps = [];
  boundary.beforeOpen = undefined;
  boundary.staged = undefined;
  boundary.beforeRename = undefined;
  boundary.failStage = undefined;
  boundary.frozen.clear();
});

describe("updates that run at once", () => {
  it("keeps both edits when two updates run at once", async () => {
    const home = fakeHome();
    try {
      const path = join(home, "config.json");
      writeFileSync(path, '{"base":true}\n');
      let merges = 0;
      let parks = 0;
      const release = gate();
      boundary.beforeRename = async (from, to) => {
        if (to !== path || !isTemp(from)) return;
        parks += 1;
        // No rename runs while another update has merged and not yet committed:
        // that is the interleaving in which the later rename would drop the
        // earlier edit. An update serialized behind another never reaches this
        // point before that one has finished, so the counts agree as soon as
        // one update parks here.
        if (parks >= merges) release.open();
        await release.promise;
      };
      const counted = (key: string) => {
        const merge = addKey(key);
        return (current: string | undefined) => {
          merges += 1;
          return merge(current);
        };
      };

      const first = updateFile(path, counted("alpha"));
      const second = updateFile(path, counted("beta"));
      const settled = await Promise.allSettled([first, second]);

      // Both edits, or an explicit refusal — never one edit quietly dropped.
      expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(readJson(path)).toEqual({ base: true, alpha: true, beta: true });
      expect(boundary.temps).toHaveLength(2);
      expect(new Set(boundary.temps).size).toBe(2);
      expect(readdirSync(home)).toEqual(["config.json"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("re-merges when an independent writer lands after its temporary is staged", async () => {
    const home = fakeHome();
    try {
      const path = join(home, "config.json");
      writeFileSync(path, '{"base":true}\n');
      const staged = gate();
      const written = gate();
      boundary.staged = async () => {
        staged.open();
        await written.promise;
      };
      const sibling = (async () => {
        await staged.promise;
        // A separate operation, running while the update is held at the
        // filesystem boundary: exactly the window between its read and its
        // rename, where a rename would otherwise drop this write.
        await writeFile(path, '{"base":true,"theirs":true}\n');
        written.open();
      })();

      await updateFile(path, addKey("ours"));
      await sibling;

      expect(readJson(path)).toEqual({ base: true, theirs: true, ours: true });
      expect(readdirSync(home)).toEqual(["config.json"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("keeps a mode tightened while its temporary was staged", async () => {
    const home = fakeHome();
    try {
      const path = join(home, "config.json");
      writeFileSync(path, '{"base":true}\n');
      chmodSync(path, 0o644);
      const staged = gate();
      const tightened = gate();
      boundary.staged = async () => {
        staged.open();
        await tightened.promise;
      };
      const sibling = (async () => {
        await staged.promise;
        // Tightening runs concurrently with this update's own commit: the
        // replacement it lands must not restore the mode it read earlier.
        await chmod(path, 0o600);
        tightened.open();
      })();

      await updateFile(path, addKey("ours"));
      await sibling;

      expect(readJson(path)).toEqual({ base: true, ours: true });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(home)).toEqual(["config.json"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("re-merges contents a matching file state would hide", async () => {
    const home = fakeHome();
    try {
      const path = join(home, "config.json");
      writeFileSync(path, '{"a":"0000","z":0}\n');
      // Freeze the state the commit will read, so only the contents can reveal
      // the write that lands in between.
      const state = statSync(path);
      boundary.frozen.set(path, {
        mode: state.mode & 0o777,
        size: state.size,
        mtimeMs: state.mtimeMs,
        ino: state.ino,
      });
      const staged = gate();
      const written = gate();
      boundary.staged = async () => {
        staged.open();
        await written.promise;
      };
      const sibling = (async () => {
        await staged.promise;
        // Same length as what the update read, so its size says nothing.
        await writeFile(path, '{"a":"1111","z":0}\n');
        written.open();
      })();
      const setZ = (current: string | undefined) => {
        const value = configSchema.parse(JSON.parse(current ?? "{}"));
        value["z"] = 1;
        return { text: `${JSON.stringify(value)}\n`, changed: true };
      };

      await updateFile(path, setZ);
      await sibling;

      expect(readJson(path)).toEqual({ a: "1111", z: 1 });
      expect(readdirSync(home)).toEqual(["config.json"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never truncates or deletes a temporary another writer already holds", async () => {
    const home = fakeHome();
    try {
      const path = join(home, "config.json");
      writeFileSync(path, "{}\n");
      const foreign: string[] = [];
      boundary.beforeOpen = (name) => {
        if (foreign.length > 0) return;
        // The name this commit picked is already taken: the refusal has to come
        // from the OS, because the file behind it belongs to someone else.
        foreign.push(name);
        writeFileSync(name, "another writer's work in progress\n");
      };

      await expect(updateFile(path, addKey("ours"))).rejects.toThrow(/EEXIST/u);

      expect(readJson(path)).toEqual({});
      expect(readFileSync(foreign[0] ?? "", "utf8")).toBe("another writer's work in progress\n");
      expect(readdirSync(home).sort()).toEqual(["config.json", basename(foreign[0] ?? "")].sort());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("removes its own half-written temporary when staging fails", async () => {
    const home = fakeHome();
    try {
      const path = join(home, "config.json");
      writeFileSync(path, "{}\n");
      boundary.failStage = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });

      await expect(updateFile(path, addKey("ours"))).rejects.toThrow(/ENOSPC/u);

      expect(readJson(path)).toEqual({});
      expect(readdirSync(home)).toEqual(["config.json"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves a temporary from an older run where it is", async () => {
    const home = fakeHome();
    try {
      const path = join(home, "config.json");
      writeFileSync(path, "{}\n");
      // The name a single fixed scheme would reuse every time, left behind by a
      // run that died: it was never this update's file to write or remove.
      const leftover = join(home, `.${basename(path)}.diffninja-${process.pid}.tmp`);
      writeFileSync(leftover, "left behind\n");

      await updateFile(path, addKey("ours"));

      expect(readJson(path)).toEqual({ ours: true });
      expect(readFileSync(leftover, "utf8")).toBe("left behind\n");
      expect(readdirSync(home).sort()).toEqual(["config.json", basename(leftover)].sort());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("symlinked configs", () => {
  it.skipIf(process.platform === "win32")("creates the missing destination of a relative link, keeping the link", async () => {
    const home = fakeHome();
    try {
      const link = join(home, "config.json");
      symlinkSync(join("dotfiles", "config.json"), link);

      await updateFile(link, addKey("ours"));

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readJson(join(home, "dotfiles", "config.json"))).toEqual({ ours: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("follows a chain of links to a destination that does not exist yet", async () => {
    const home = fakeHome();
    try {
      mkdirSync(join(home, "dotfiles"));
      const real = join(home, "dotfiles", "config.json");
      const middle = join(home, "middle.json");
      const link = join(home, "config.json");
      symlinkSync(real, middle);
      symlinkSync("middle.json", link);

      await updateFile(link, addKey("ours"));

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(lstatSync(middle).isSymbolicLink()).toBe(true);
      expect(readJson(real)).toEqual({ ours: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("resolves a destination reached through a symlinked directory", async () => {
    const home = fakeHome();
    try {
      const real = join(home, "real");
      mkdirSync(real);
      writeFileSync(join(real, "config.json"), "{}\n");
      const alias = join(home, "alias");
      symlinkSync(real, alias);
      const link = join(home, "config.json");
      symlinkSync(join("alias", "config.json"), link);

      await updateFile(link, addKey("ours"));

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(readJson(join(real, "config.json"))).toEqual({ ours: true });
      expect(readdirSync(home).sort()).toEqual(["alias", "config.json", "real"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("refuses a cycle instead of replacing one of its links", async () => {
    const home = fakeHome();
    try {
      const left = join(home, "left.json");
      const right = join(home, "right.json");
      symlinkSync("right.json", left);
      symlinkSync("left.json", right);

      await expect(updateFile(left, () => ({ text: "{}\n", changed: true }))).rejects.toThrow(/symlinks form a cycle/u);

      expect(lstatSync(left).isSymbolicLink()).toBe(true);
      expect(lstatSync(right).isSymbolicLink()).toBe(true);
      expect(readdirSync(home).sort()).toEqual(["left.json", "right.json"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
