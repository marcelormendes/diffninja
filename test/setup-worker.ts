import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every test worker (and the CLI processes it spawns) reads the one grammar cache
 * that test/global-setup.ts installed before any worker started. Nothing writes
 * to it during the run, so sharing it is safe; a copy per worker would take about
 * 0.7 GB each, because the grammar packages ship native builds for every platform.
 */
process.env.DIFFNINJA_GRAMMAR_CACHE = join(tmpdir(), "diffninja-grammar-test-cache", "master");
