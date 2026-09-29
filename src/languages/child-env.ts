import { isAbsolute } from "node:path";

/**
 * The environment npm gets when diffninja runs it. npm and the install scripts
 * of the packages it fetches inherit their parent's environment, and an engineer's
 * shell carries tokens (GitHub, cloud providers, package registries) that no
 * install has any business seeing. Only what npm and node-gyp need to find their
 * tools, cache, proxy and certificates is passed on; npm's own `npm_config_*`
 * variables are the user's npm configuration and pass too.
 */
const KEPT = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ",
  "TMPDIR", "TMP", "TEMP",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // Windows: without these npm cannot find its own files, Python or the compiler.
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)",
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
]);

/** What a source build (node-gyp) also looks for: compiler, Python and SDK locations. Only when the person asked for a build. */
const BUILD_KEPT = new Set(["CC", "CXX", "CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS", "PYTHON", "SDKROOT", "DEVELOPER_DIR", "MACOSX_DEPLOYMENT_TARGET", "INCLUDE", "LIB", "LIBPATH"]);
const BUILD_PREFIXES = ["GYP_", "VSINSTALLDIR", "VCINSTALLDIR", "VCTOOLS", "VSCMD_", "VS1", "VISUALSTUDIO", "WINDOWSSDK", "UNIVERSALCRT", "UCRT"];

/**
 * The variables the person running diffninja chose to pass to npm as well, named in
 * DIFFNINJA_NPM_ENV (for example `NPM_TOKEN,NODE_AUTH_TOKEN`). A private registry whose
 * `.npmrc` reads its token from the environment answers 401 without it. Names only. Anything
 * else is refused without being echoed, because what was written there may be the secret itself.
 */
function chosenNames(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const names = (env["DIFFNINJA_NPM_ENV"] ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
  if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error("DIFFNINJA_NPM_ENV must list only environment variable names separated by commas, such as NPM_TOKEN,NODE_AUTH_TOKEN.");
  }
  return new Set(names.map((name) => name.toUpperCase()));
}

/** Compared without regard to case: Windows spells `Path`, `ComSpec` and `SystemRoot` its own way. */
export function npmEnvironment(env: NodeJS.ProcessEnv = process.env, extra: Readonly<Record<string, string>> = {}, options: { readonly build?: boolean } = {}): NodeJS.ProcessEnv {
  const chosen = chosenNames(env);
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    const forBuild = options.build === true && (BUILD_KEPT.has(upper) || BUILD_PREFIXES.some((prefix) => upper.startsWith(prefix)));
    if (KEPT.has(upper) || upper.startsWith("NPM_CONFIG_") || upper.startsWith("LC_") || forBuild || chosen.has(upper)) out[name] = value;
  }
  return { ...out, ...extra };
}

/**
 * The shell Windows runs a `.cmd` shim with, when no npm JS entry point can be
 * found. ComSpec is used only when it is an absolute path to `cmd.exe`; anything
 * else in that variable would otherwise be written into an agent's config and run
 * every time the agent starts.
 */
export function windowsShell(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env["ComSpec"] ?? env["COMSPEC"];
  return candidate !== undefined && /[\\/]cmd\.exe$/i.test(candidate) && (isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) ? candidate : "cmd.exe";
}
