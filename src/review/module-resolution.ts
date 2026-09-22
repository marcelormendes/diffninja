import { posix } from "node:path";
import { z } from "zod";

const configSchema = z.object({
  extends: z.unknown().optional(),
  compilerOptions: z.object({
    baseUrl: z.string().optional(),
    paths: z.record(z.string(), z.array(z.string())).optional(),
    moduleSuffixes: z.array(z.string()).optional(),
    rootDirs: z.array(z.string()).optional(),
  }).optional(),
});

/** Conservative local binding resolution; no package loading or configuration execution. */
export function moduleResolver(readFile: (file: string) => string | null) {
  const files = new Map<string, string | null>();
  const read = (file: string): string | null => {
    if (!files.has(file)) files.set(file, readFile(file));
    return files.get(file) ?? null;
  };
  const safe = (file: string): boolean => !posix.isAbsolute(file) && !file.includes("\\") &&
    !file.includes(":") && file !== ".." && !file.startsWith("../");
  const resolveFile = (candidate: string): string | undefined => {
    if (!safe(candidate)) return undefined;
    const stem = candidate.replace(/\.(?:js|jsx)$/u, "");
    const paths = /\.(?:ts|tsx)$/u.test(candidate)
      ? [candidate]
      : [`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, `${stem}.js`, `${stem}.jsx`];
    for (const path of paths) if (read(path) !== null) return path;
    // Package-directory entry points need package.json resolution, outside this bounded resolver.
    return undefined;
  };
  return (importer: string, specifier: string): string | undefined => {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier)) return undefined;
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      return resolveFile(posix.normalize(posix.join(posix.dirname(importer), specifier)));
    }
    let directory = posix.dirname(importer);
    for (;;) {
      const text = read(posix.join(directory, "tsconfig.json"));
      if (text !== null) {
        let value: unknown;
        try { value = JSON.parse(text); } catch { return undefined; }
        const parsed = configSchema.safeParse(value);
        if (!parsed.success || parsed.data.extends !== undefined) return undefined;
        const options = parsed.data.compilerOptions;
        if (!options || options.moduleSuffixes || options.rootDirs) return undefined;
        const patterns = Object.entries(options.paths ?? {}).filter(([pattern]) => {
          const star = pattern.indexOf("*");
          return star < 0 ? pattern === specifier : pattern.indexOf("*", star + 1) < 0 &&
            specifier.length >= pattern.length - 1 && specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
        }).sort(([left], [right]) => {
          if (!left.includes("*")) return -1;
          if (!right.includes("*")) return 1;
          return right.indexOf("*") - left.indexOf("*") || right.length - left.length;
        });
        const match = patterns[0];
        // Multiple fallbacks and inherited/JSONC configurations stay unproven, not guessed.
        if (!match || match[1].length !== 1) return undefined;
        const [pattern, targets] = match;
        const star = pattern.indexOf("*");
        const capture = star < 0 ? "" : specifier.slice(star, specifier.length - (pattern.length - star - 1));
        const target = targets[0].replace("*", capture);
        if (target.includes("*") || posix.isAbsolute(target) || posix.isAbsolute(options.baseUrl ?? ".")) return undefined;
        return resolveFile(posix.normalize(posix.join(directory, options.baseUrl ?? ".", target)));
      }
      if (directory === ".") return undefined;
      directory = posix.dirname(directory);
    }
  };
}
