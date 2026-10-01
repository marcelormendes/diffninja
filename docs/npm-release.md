# Publishing diffninja to npm

**Status: publishing through GitHub Actions.** A `vX.Y.Z` tag on `main` runs the
release workflow, which publishes through npm trusted publishing (OIDC). This
page does not track which version is current. `npm view diffninja version` does.

Publishing requires an explicit maintainer action: the trusted-publisher
configuration below, then a tag. Two consequences follow:

- **A version bump is not publication.** A merged release becomes available
  only after its matching `vX.Y.Z` tag passes the release workflow and npm
  accepts the tarball.
- **Platforms are verified by CI.** `.github/workflows/consumer-matrix.yml`
  packs once and runs `scripts/verify-package.mjs` against a real global
  install on Ubuntu x64 and ARM64, macOS x64 and ARM64, and Windows x64, on
  Node 22 and 24. It runs on every pull request, on pushes to `main`, and on
  demand.

## What is prepared

| Piece | State |
|---|---|
| `package.json` | `version` is the release number. `publishConfig.access: public`, `engines.node: >=22.18.0`, bins `diffninja` and `diffninja-mcp` |
| Packed tarball contents | `dist` JavaScript and declarations, `package.json`, `README.md`, `LICENSE`, `npm-shrinkwrap.json`, and `scripts/ensure-native-grammar.mjs` (the postinstall script). The `dist` files include `dist/cli.js` and `dist/index.js`, the legacy calldiff command and library entry, which no bin runs. No `src`, `test`, other scripts, `tsconfig.json` or `vitest.config.ts`, and no `node_modules`. `npm pack --dry-run` lists the files. |
| `.github/workflows/release.yml` | one workflow: metadata gate, tag gate on tag pushes, build/lint/test/pack, four-runner install matrix, minimum-toolchain job, OIDC publish job |
| `.github/workflows/consumer-matrix.yml` | pack once, then a 5-OS x 2-Node consumer matrix (Ubuntu x64/ARM64, macOS x64/ARM64, Windows x64; Node 22/24) that globally installs the tarball and runs `scripts/verify-package.mjs`; runs on PRs, on pushes to `main`, and on demand |
| `scripts/verify-package.mjs` | installs the packed tarball into a throwaway prefix and exercises the installed surface |

## What a consumer actually installs

The published tarball carries compiled JavaScript, type declarations, package
metadata and documentation, the postinstall script and an `npm-shrinkwrap.json`.
Parser support comes from npm dependencies.

- `tree-sitter@^0.25.1` and `tree-sitter-javascript@^0.25.0` are direct
  `dependencies`. `tree-sitter-typescript@^0.23.2` is an `optionalDependency`.
  npm installs all three from the registry next to diffninja. Both grammars load
  from the package's own `node_modules` (`BUNDLED_GRAMMARS` in `grammars.ts` names
  them, and nothing else is ever loaded from outside the grammar cache).
- Declaring tree-sitter-typescript optional is what keeps a broken prebuild from
  aborting the install. npm ignores the failure of an optional dependency's
  install script instead of exiting non-zero. The `postinstall` script
  (`scripts/ensure-native-grammar.mjs`, shipped in the tarball) then loads
  `tree-sitter` and the TypeScript grammar for real. Where that works it does
  nothing. Where it does not, it installs `tree-sitter-typescript` without its
  scripts if npm dropped it, deletes the package's `prebuilds/` and `build/`
  directories, and runs `npm rebuild tree-sitter-typescript`, which runs install
  scripts, needs a toolchain and may download the Node headers. It passes on the
  environment of the npm that runs it, gives each npm command 900 seconds, and
  always exits 0. See finding 3.
- npm's `bundleDependencies` (which would inline a `node_modules` tree into the
  published package) is not used, and the packed tarball contains no
  `node_modules` entries.
- Every other language's grammar is installed only by a person running
  `diffninja grammars install [--build]`. A review never downloads or builds
  anything. The command writes `package.json` and `package-lock.json` from
  `src/languages/grammar-lock.ts` into `~/.cache/diffninja/grammars` (or
  `C:\Users\<you>\.cache\diffninja\grammars` on Windows, or
  `DIFFNINJA_GRAMMAR_CACHE`) and runs `npm ci --ignore-scripts --legacy-peer-deps`
  there. npm refuses any tarball that does not match the sha512 in the lock,
  dependencies included, and no install script runs. npm gets a short allow-list
  of environment variables (`child-env.ts`), every `npm_config_*` variable, and
  the names in `DIFFNINJA_NPM_ENV`. The grammars load from the prebuilt binaries
  they ship. Kotlin and Perl ship none. `--build` then runs `npm rebuild` for
  those two packages only. That runs their install scripts (`node-gyp-build`
  compiles them, and downloads the Node headers from nodejs.org unless they are
  cached) and needs Python and a C/C++ toolchain. A `.diffninja-grammars.json`
  marker holding the lock's digest is written last, and a cache without it (or
  with another lock's) is not read. The marker holds only public data, so it is a
  consistency check, not authentication. A cache directory that belongs to
  another user, or that another user can write, is not read either, and install
  refuses it (it tightens a directory of your own to 0700). Windows skips that
  owner and mode check. The shared calldiff cache from earlier versions is never
  read.

### Updating the pinned grammars

The set is `PINS` in `scripts/pin-grammars.mjs`; `src/languages/grammar-lock.ts`
is generated from it. To move a pin, change the version there, run
`node scripts/pin-grammars.mjs`, review the generated diff (new transitive
packages appear in it), run `npm view <package>@<version> scripts maintainers` for
anything new, and check `node scripts/pin-grammars.mjs --check` passes. The pins
were resolved from registry.npmjs.org on 2026-09-28.

Their maintainers are not one group. On 2026-09-29 the registry listed several
accounts for most of them (bash, c, cpp, go, java, python, ruby, rust, php,
c-sharp, haskell and scala). It listed individuals for these:
`tree-sitter-kotlin` (fwcd), `tree-sitter-perl` (veesh), `tree-sitter-solidity`
(joranhonig), `tree-sitter-swift` (alexpinkus), `tree-sitter-elixir`
(jonatanklosko and the-mikedavis) and `tree-sitter-ocaml` (maxbrunsfeld). The lua
and zig packages under `@tree-sitter-grammars` listed amaanq, muniftanjim and
chronobserver. This is registry data as of that day, so recheck it when moving a
pin. `tree-sitter-swift` depends on `tree-sitter-cli` (0.23.2 at the pin), whose
install script downloads a binary. With `--ignore-scripts` it is installed and
never run.

### The shrinkwrap

`npm-shrinkwrap.json` is the repository's lockfile (there is no
`package-lock.json`) and ships in the tarball, so that npm installs the
dependency versions diffninja was tested with when it installs from the
registry. npm applies it to registry installs only; an install from a local
tarball, as CI does, ignores it. `test/package-shrinkwrap.test.ts` keeps it in
step with `package.json`.

## npm-side configuration (required before the workflow can publish)

Trusted publishing is a relationship between the npm package and this
repository, configured on npmjs.com once by a maintainer:

1. Open <https://www.npmjs.com/package/diffninja/access> (the package must exist
   first — see the bootstrap section).
2. In **Trusted Publisher → Select your publisher**, choose **GitHub Actions**
   and fill the fields exactly:

   | Field | Value |
   |---|---|
   | Organization or user | `marcelormendes` |
   | Repository | `diffninja` |
   | Workflow filename | `release.yml` |
   | Environment name | *(leave empty)* |
   | Allowed actions | **`npm publish`** |

   All fields are case-sensitive and checked against the OIDC claims at publish
   time. The workflow filename is the bare filename in `.github/workflows/`, not
   a path, and must include the extension.

   **The allowed action matters.** npm's documentation states that connections
   created after 2026-09-03 are automatically set to allow `npm stage publish`
   and that you choose whether to also permit direct `npm publish`; a connection
   without `npm publish` rejects this workflow's `npm publish` step. Tick
   `npm publish`.

   The environment name is empty because `.github/workflows/release.yml`
   declares no `environment:`. If you add a GitHub environment later (for
   example to require approval), the name here must match it exactly.

   Existing connections cannot be edited: the provider and required fields are
   fixed once created, so a mistake means deleting the connection and creating
   another. npm also does not validate the fields when you save them — an error
   surfaces on the next publish attempt.

3. Recommended hardening after the first successful workflow release: set the
   package's **Publishing access** to *Require two-factor authentication and
   disallow tokens*, and protect the `v*` tag pattern so only maintainers can
   create release tags. Neither step affects OIDC publishing.

`.github/workflows/release.yml` needs `id-token: write`, granted to the publish
job alone; `repository.url` in `package.json`
(`git+https://github.com/marcelormendes/diffninja.git`) already matches the
GitHub repository, which npm requires.

Prerequisites: npm CLI **11.5.1** or newer on Node **22.14.0** or newer (the
workflow pins Node 24 and refuses to publish on an older npm CLI), and
GitHub-hosted runners — npm does not accept self-hosted runners for the OIDC
exchange. OIDC covers `npm publish` and `npm stage publish` only; `npm install`,
`npm access`, `npm view` and `npm whoami` still use traditional authentication,
so CI that installs private dependencies still needs a read-only token.

The command-line equivalent, for maintainers who prefer it (npm 11.15.0 or
newer, interactive 2FA, and the package must already exist):

```bash
npm trust github diffninja --file release.yml --repo marcelormendes/diffninja --allow-publish
npm trust list diffninja   # verify
```

## First publish: the bootstrap limitation

**npm cannot configure trusted publishing for a package that does not exist
yet.** `npm trust` states it as a prerequisite ("Package must exist: The
package you're configuring must already exist on the npm registry"), and the
package settings page that hosts the trusted-publisher form only exists once the
package does. OIDC therefore cannot create the first version of a package. The
first version of `diffninja` was published by hand, and the trusted publisher was
configured after that. That step is done. What still applies to every release is
this.

1. **Verify the package, from the approved commit, before tagging.** The same
   gates the workflow runs must pass locally first: `npm ci`, `npm run build`,
   `npm run lint`, `npm test`, then `mkdir -p dist-pack`,
   `npm pack --pack-destination dist-pack` and
   `node scripts/verify-package.mjs dist-pack`. A `workflow_dispatch` run of
   `.github/workflows/release.yml` verifies the macOS and Windows consumers,
   because it runs the whole pipeline with `publish` skipped (only a pushed tag
   sets `release=true`).
2. **Bump `version`** in `package.json` and `npm-shrinkwrap.json`, and merge
   through a PR with all required checks.
3. **Tag the merged commit and push:**

   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

   npm refuses to publish a version that already exists, so a tag never reuses
   one.

The workflow's guarantee is stronger than a local build: it publishes the exact
tarball it packed, after re-checking that file's SHA-256 in the publish job. Do
not add an npm token secret to work around OIDC failures; fix the trust
configuration instead.

## What the release workflow does

Triggers: a push of a tag matching `v*`; pull requests targeting `main`; and
manual `workflow_dispatch`. PR and dispatch runs execute the same `verify`,
`install-matrix` and `minimums` jobs and skip only `publish`, which carries
`if: github.ref_type == 'tag' && needs.verify.outputs.release == 'true'`, so
neither can reach the registry.

| Job | Runner(s) | Purpose |
|---|---|---|
| `verify` | `ubuntu-latest` | metadata gate (name must be `diffninja`; sets `release`), tag gate on tags, `npm ci`, build, lint, tests, `npm pack`, artifact upload with SHA-256 |
| `install-matrix` | `ubuntu-latest`, `macos-15-intel`, `macos-latest`, `windows-latest` | install the packed tarball and run `scripts/verify-package.mjs` |
| `minimums` | `ubuntu-latest` | the same tarball on the declared floor: Node 22.18.0 with npm 11.5.1 |
| `publish` | `ubuntu-latest` | re-check the artifact digest, then `npm publish` with OIDC (`id-token: write`) |

As of this writing those labels resolve to Ubuntu 24.04 x64, macOS 15 x64,
macOS 26 arm64 and Windows Server 2025 x64; GitHub moves the `-latest` labels on
its own schedule, which is why the matrix runs the tarball check on each one
rather than trusting a label.

On a tag push the gate rejects the release when the tag is not
`v<package.json version>`, the version is not a plain `X.Y.Z`, the package name
is not `diffninja`, `private` is still set, or the tagged commit is not contained
in `main` (set `RELEASE_BRANCH` to change that branch). The publish job does not
check out the repository: it downloads the tarball `verify` uploaded, verifies
its digest, and publishes only that file.

`npm publish` is issued without `--provenance`: npm generates provenance
attestations automatically for OIDC publishes of public packages from public
repositories (it is not generated for private repositories, even for public
packages).

Troubleshooting, in the order these bite:

- `ENEEDAUTH` / "Unable to authenticate": the workflow filename in the trusted
  publisher form does not match `release.yml` exactly, `id-token: write` is
  missing from the publish job, the runner is not GitHub-hosted, or the
  connection is not allowed to run `npm publish` (stage-only).
- `EOTP` or a 2FA prompt in CI: the connection is not the one being used, or the
  package still requires token-based OTP. OIDC publishes are not prompted.
- No provenance badge after a successful publish: provenance is skipped for
  private repositories and private packages. Verify both are public.
- `Cannot implicitly apply the "latest" tag`: a higher version already exists on
  the registry. Bump `version` (and the tag), or publish with an explicit
  `--tag`.

## Platform and dependency findings

The issues below were investigated from source, from installed dependencies and
from registry tarballs. The ones with a consumer-visible workaround are
documented in [reference.md](reference.md#install-time-notes).

### 1. Windows: launching npm

Node's own documentation is explicit that on Windows `.bat` and `.cmd` files "are
not executable on their own without a terminal, and therefore cannot be launched
using `child_process.execFile()`". npm's Windows entry points are `.cmd` and
`.ps1` shims, so a direct `execFileSync("npm", ...)` cannot reach npm there.
`npmSpawnSpec()` in `src/languages/grammars.ts`, and the postinstall script's own
copy of it, resolve npm's `npm-cli.js` on Windows via `PATH` plus the Node install
directory, never the repository under review, and run it with the current Node
executable. Cache paths with spaces and percent signs then stay literal argv
values instead of being interpreted by `cmd.exe`. `diffninja setup` starts npm
the same way. `scripts/verify-package.mjs` runs `diffninja grammars install` into
a cache path with spaces on every platform, and the consumer matrix runs it on
real Windows Server.

### 2. Windows: `--open` (removed)

The terminal review mode, and with it `--open` and its per-platform browser
openers, was removed: reviews run only through the MCP server, and the
`diffninja` bin only registers it. The consumer matrix now checks that the bin
refuses a terminal review and writes no report.

### 3. Linux ARM64: mislabeled grammar prebuilds (repaired at install time)

In `tree-sitter-typescript@0.23.2` and `tree-sitter-javascript@0.23.1`,
`prebuilds/linux-arm64/*.node` is byte-identical to the x64 file (the ELF
header reports `Advanced Micro Devices X86-64`). The defect is in the two
upstream grammar packages; `tree-sitter@0.25.1` itself ships a correct
`AArch64` Linux prebuild.

The repair happens at install time. `tree-sitter-typescript` is an
`optionalDependency`, so the upstream install-script failure (`node-gyp-build`
falls back to `node-gyp rebuild`, which under Node 22 dies on a malformed
generated Makefile) no longer aborts `npm install -g diffninja`. The
`postinstall` in `scripts/ensure-native-grammar.mjs` probes the binding end to
end (require parser, `setLanguage`, `parse`). When that fails it deletes
`prebuilds/` and `build/` inside the installed package and runs
`npm rebuild tree-sitter-typescript` with `CXXFLAGS='-std=c++20'` (the Node 22+
headers require C++20 and `binding.gyp` does not request it). Because
node-gyp-build prefers `build/Release` over any prebuild, the corrected binary
is the one loaded afterwards. The script is a heal, not a gate: it always exits
0, warns when no toolchain is available, and never touches a platform whose
prebuild loads.

npm can still delete the repaired package. When install scripts run in
parallel, the package's own `node-gyp rebuild` sometimes fails on Linux ARM64
(`No rule to make target ... node_addon_api_except.stamp`). npm then marks the
optional dependency failed and removes its directory at the end of the install,
after the postinstall has already repaired it. Reproduced on
`node:24.21.0-bookworm` with npm 11.19.0, and it is what failed the consumer
matrix's ARM64 jobs from time to time. `--allow-scripts` does not change it, and
`--foreground-scripts` (serial scripts) avoids it. The same happens when
`tree-sitter-typescript` itself builds but the `tree-sitter-javascript@0.23.1`
npm nests under it fails: npm deletes the working parent too (diffninja's
`overrides` replace that nested copy only when diffninja is the root project, so
a global install still gets it). So after a successful repair, and whenever the
grammar that loads was compiled on this machine (`build/Release` holds a
`.node`), the script copies what the grammar needs at run time (its `package.json`,
`bindings/node/index.js`, the compiled `.node` and the two `node-types.json`)
into `native-grammar/tree-sitter-typescript` at diffninja's package root, a
directory npm does not track, and checks that the copy loads. When the normal
`require` fails, `loadGrammarPackage` falls back to that copy.

For grammars in the grammar cache, `src/languages/grammars.ts` also reads a
prebuild's binary header (ELF/Mach-O/PE machine type) when a load fails. If the
platform's prebuild targets another CPU, the loader refuses to load it and says
so. It does not edit the cache.

Linux ARM64 therefore needs Python and a C/C++ toolchain (build-essential) at
install time; the consumer matrix installs it and gates Linux ARM64 as a passing
platform. A host without the toolchain still completes the install and only
loses native TypeScript/TSX extraction.

The upstream fix (corrected `prebuilds/linux-arm64/*.node` in the two grammar
packages) is still worth requesting, and would remove the compile step.

### 4. Linux: `tree-sitter@0.25.1` needs a recent `libstdc++`

The x64 prebuild imports `GLIBCXX_3.4.31` (and `GLIBCXX_3.4.29`, `3.4.20`,
`3.4.18`; `GLIBC_2.17` and older). `GLIBCXX_3.4.31` comes from GCC 13.1, i.e.
libstdc++ from Ubuntu 24.04 or newer; this workstation has 3.4.33 and loads the
addon for real (native extraction passes). The limitation follows from that
symbol requirement rather than from a test on an older distribution, which was
not run: on an older libstdc++ the failure lands on first use, not at install
time. When a grammar loaded from the grammar cache fails with that symbol error,
the loader names the GCC 13.1+/Ubuntu 24.04+ requirement and the
`npm rebuild <pkg> --build-from-source` workaround. The parser and the bundled
grammars show the raw error. The matrix targets Ubuntu 24.04, not every
glibc-based distribution.

### 5. Peer ranges: an optional peer that cannot be satisfied

`tree-sitter-typescript@0.23.2` declares `peerDependencies.tree-sitter:
"^0.21.0"` with `peerDependenciesMeta.tree-sitter.optional: true`;
`tree-sitter-javascript@0.23.1` declares `^0.21.1` the same way. diffninja
depends on `tree-sitter@^0.25.1`. npm's documented non-strict behavior for a
conflicting peer is to resolve it against the nearest non-peer dependency and
print a warning, which is exactly what happens:

- Global install (verified locally, 108 packages, exit 0): npm keeps the single
  `tree-sitter@0.25.1` inside the package and prints
  `ERESOLVE overriding peer dependency`; `npm ls` then exits 1 with
  `ELSPROBLEMS` (`invalid` peer range, `extraneous` nested
  `tree-sitter-javascript`). The installed CLI, native extraction and MCP server
  all work.
- Local project install of the same tarball (verified locally, exit 0, `npm ls`
  exit 0): npm instead hoists a second `tree-sitter@0.21.1` next to diffninja's
  own `0.25.1`. That older copy has prebuilds only for darwin-arm64, darwin-x64,
  linux-x64 and win32-x64, so on Linux ARM64 or Windows ARM64 its installation
  can require a native build toolchain. diffninja's parser does not use it.

The repository's own `overrides` entry only affects this repository: npm honors
`overrides` from the root `package.json`, so consumers never see it. The fix
belongs upstream as a widened peer range in the grammar packages — not a parser
downgrade here and not `--force`/`--legacy-peer-deps` instructions for
consumers.

### 6. Grammars without a usable prebuild

`grammars install` runs `npm ci --ignore-scripts`, so a grammar loads only if its
package ships a prebuilt binary for the platform. Every pinned package has the
install script `node-gyp-build`, which is never run by `npm ci --ignore-scripts`.
Checked in the installed packages:

- `tree-sitter-perl@2.0.0` and `tree-sitter-kotlin@0.3.8` ship no prebuilds.
  They load only after `diffninja grammars install --build` compiles them, which
  needs Python and a C/C++ toolchain and downloads the Node headers from
  nodejs.org unless they are cached.
- `@tree-sitter-grammars/tree-sitter-lua@0.2.0` ships prebuilds for darwin-arm64,
  darwin-x64, linux-x64 and win32-x64 only, so it cannot load on Linux ARM64 or
  Windows ARM64.
- The other pinned packages (python, rust, go, ruby, php, bash, c, cpp, java,
  c-sharp, elixir, haskell, ocaml, scala, solidity, swift and the scoped zig
  package) ship prebuilds for all six platform directories.
- `tree-sitter-swift@0.7.1` also depends on `tree-sitter-cli@^0.23`, whose install
  script downloads an executable from GitHub Releases. With `--ignore-scripts` it
  is installed and never run.
- The obsolete unscoped `tree-sitter-zig@0.2.0` is a different package
  (nan-era, no install script, no prebuilds). `src/languages/zig.ts` requests the
  scoped `@tree-sitter-grammars/tree-sitter-zig`.

A grammar that is not installed, or cannot load, fails per file and is not fatal.
Extraction logs `warn: failed to parse <file> @ <commit>` and the review
completes with the diff and whatever call flows resolved (`callFlowAvailability`
is `"failed"` only when the analysis itself throws).

### 7. npm 12: dependency install scripts are blocked by default

npm 12 skips every dependency's `preinstall`/`install`/`postinstall` unless it
is allowed by name, and only warns. Where tree-sitter's prebuilds load nothing
visible breaks. Where they do not, nothing parses, and `diffninja-mcp` cannot
start, because the server imports the parser as it starts. Reproduced on
`node:24.21.0-bookworm` (Linux ARM64) with npm 12.2.0: after a plain
`npm install -g diffninja` the `tree-sitter` parser prebuild needs
`GLIBCXX_3.4.31` (GCC 13), which Debian 12 lacks, and the TypeScript prebuild is
the mislabeled x86-64 one (finding 3). npm 11 compiled both from source in their
install scripts; npm 12 runs none of them, nor diffninja's postinstall.

Three changes cover it:

- `diffninja setup` runs the registered global install's postinstall with
  `node` after it installs, and also when the install is already current, so
  `npm install -g diffninja` followed by setup repairs the install.
- The postinstall checks the parser and both bundled grammars and rebuilds,
  one at a time, each that does not load. Its npm commands run with
  diffninja's own directory as the project. npm 12 refuses `--allow-scripts` on
  the command line there (`EALLOWSCRIPTS`), so `package.json` carries an
  `allowScripts` field naming `tree-sitter`, `tree-sitter-javascript` and
  `tree-sitter-typescript`. npm 12 reads that field only when diffninja is the
  project, which is the case for these commands and in a checkout, never when
  diffninja is someone's dependency.
- `diffninja-mcp` imports the server lazily, so when the parser does not load it
  prints one line naming the script to run instead of a stack trace.

Verified in Docker (`node:24.21.0-bookworm`, npm 12.2.0): plain global install,
then `diffninja setup` rebuilt `tree-sitter` and `tree-sitter-typescript`, and
afterwards JavaScript and TypeScript parse and the server answers `initialize`.
The same tarball passed `scripts/verify-package.mjs` 5/5 with npm 11.19.0 and
5/5 with npm 10.9.9 (Node 22). An npx-based entry (setup's fallback) runs from
npx's own cache, which setup does not repair.

For the install itself, `diffninja setup` names what it needs:
`npm install -g --allow-scripts=diffninja,tree-sitter,tree-sitter-javascript,tree-sitter-typescript diffninja@<its version>`.
The names match a registry install's identity; a local tarball install matches
by file path instead, so the consumer matrix cannot prove this part. npm 10.9
and 11.5.1 accept the flag and ignore it. `grammars install` passes no such
flag: `npm ci --ignore-scripts` needs none, and how npm 12 treats the
`npm rebuild` that `--build` runs for Kotlin and Perl was not tested.

## Native prebuild inventory

Enumerated from the installed packages and registry tarballs on Linux x64, then
header-checked (ELF/Mach-O/PE machine type): file inventory plus each `.node`
header. Nothing in this table executed on macOS, Windows or ARM64 Linux. The
linux-arm64 mislabeling above is repaired at install time by the postinstall
script (see finding 3), and the loader's wrong-CPU header check refuses a cached
grammar built for another CPU and says so.

| Package | linux x64 | linux arm64 | macOS x64 | macOS arm64 | win x64 | win arm64 |
|---|---|---|---|---|---|---|
| `tree-sitter` 0.25.1 (direct dependency) | prebuild, **loads** | prebuild (AArch64 ELF) | prebuild (Mach-O x86-64) | prebuild (Mach-O arm64) | prebuild (PE x64) | prebuild (PE arm64) |
| `tree-sitter-typescript` 0.23.2 (optional dependency) | prebuild, **loads** | **prebuild is x86-64 code** | prebuild (Mach-O x86-64) | prebuild (Mach-O arm64) | prebuild (PE x64) | prebuild (PE arm64) |
| `tree-sitter-javascript` 0.23.1 (dependency of the above) | prebuild, **loads** | **prebuild is x86-64 code** | prebuild (Mach-O x86-64) | prebuild (Mach-O arm64) | prebuild (PE x64) | prebuild (PE arm64) |
| `tree-sitter` 0.21.1 (added only by a consumer resolver, see finding 5) | prebuild | none — builds from source | prebuild | prebuild | prebuild | none — builds from source |

## Absolute MCP paths per platform

MCP clients should launch the absolute Node executable with the absolute
`mcp-cli.js` path as its first argument, bypassing shell shims:

| Platform | Node discovery | Installed entry point |
|---|---|---|
| Linux / macOS | `node -p "process.execPath"` | output of `npm root -g` + `/diffninja/dist/review/mcp-cli.js` |
| Windows PowerShell | `node -p "process.execPath"` | `Join-Path (npm.cmd root -g) "diffninja\dist\review\mcp-cli.js"` |

Use the resulting literal paths in the client's JSON `command` and `args`;
do not put shell substitutions in JSON. Backslashes must be JSON-escaped.
[mcp-setup.md](mcp-setup.md) shows the per-client entries. Recompute paths after
changing npm prefixes or Node installations. The server accepts no CLI arguments
and reserves stdout for MCP, so a successful start waits for protocol input
rather than a banner.

## Remaining decisions

- **Upstream fixes to request:** corrected `prebuilds/linux-arm64/*.node` in
  `tree-sitter-typescript@0.23.2` and `tree-sitter-javascript@0.23.1` (diffninja
  rebuilds the mislabeled TypeScript grammar during `postinstall`, but a correct
  prebuild would skip the source compile); a `binding.gyp` that requests C++20,
  which the Node 22+ headers require; widened `tree-sitter` peer ranges in those
  packages; prebuilds (or an explicit "source build" note) for `tree-sitter-perl`,
  `tree-sitter-kotlin` and the ARM64 gaps in
  `@tree-sitter-grammars/tree-sitter-lua@0.2.0`.
- **Publishing itself:** always a maintainer's explicit action. Nothing in this
  repository's code or its agents logs in to npm, publishes, tags, pushes or
  merges without that.

## Reproducing the verification locally

```bash
npm ci
mkdir -p dist-pack
npm run build
npm pack --pack-destination dist-pack
node scripts/verify-package.mjs dist-pack
```

`scripts/verify-package.mjs` performs a real global install with an isolated
temporary prefix and npm cache; it does not modify the user's global npm
installation or populate the user's npm cache. The install runs the tarball's
own `postinstall` heal, so the ARM64 repair path is part of what it exercises.
It checks the compiled file list against current sources (catching stale
output), the installed package layout, both bin shims (plus `.cmd`, `.ps1` and
shell shims on Windows) and the absence
of a `calldiff` bin, the `diffninja` command refusing a terminal review, native
TypeScript extraction, that a Python file is refused with the exact
`grammars install` command before the grammars are installed, then
`diffninja grammars install` into a cache path containing spaces (on every
platform, proving the Windows npm invocation) and Python extraction from it,
and an MCP stdio review whose `structuredContent` matches its JSON text.
On Windows it launches `diffninja.cmd` and `diffninja-mcp.cmd` explicitly from
PowerShell, because a host may block `.ps1` shims. Any failure prevents
publication.

The consumer matrix (`.github/workflows/consumer-matrix.yml`) runs the same
script on each pull request and push to `main`: Ubuntu x64 and ARM64, macOS x64 and ARM64, Windows
x64, each on Node 22 and 24. Global installs emit the peer warnings described in
finding 5 and still exit 0.

When `/tmp` is a small tmpfs, set `TMPDIR` to a scratch directory with enough
disk space before running the consumer script. It removes its own sandbox.

For concurrent local test runs, use a private `TMPDIR`: the existing test setup
names its grammar caches by worker number beneath that directory, not by
worktree. Native source builds in this sandbox also used
`npm_config_nodedir=/usr` to reuse the matching installed Node 24 headers.
That header path is machine-specific; do not apply it to a different Node
version or assume it exists on another platform.

### Before a release

- `npm ci`, `npm run build`, `npm run lint` and `npm test` pass.
- `npm pack --dry-run` lists what ships. It should hold only the files named in
  the table at the top of this page. Nothing else should appear (no `src`, tests,
  development scripts, lockfile other than `npm-shrinkwrap.json`, or stray
  output). Run `npm pack --dry-run --ignore-scripts` after a build to skip the
  `prepack` rebuild.
- The packed tarball passes `scripts/verify-package.mjs` on a clean global
  install, locally and in the consumer matrix.
- After a change to a workflow file, `actionlint` accepts it, and the metadata
  gate still allows publication only for a tag push.

`dist-pack/` is git-ignored. It holds the tarball, its SHA-256 sidecar and the
file inventory, none of which are npm contents.

## Primary references

- [npm trusted publishers: OIDC requirements and configuration](https://docs.npmjs.com/trusted-publishers/)
- [npm trust: prerequisites and existing-package requirement](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
- [npm `package.json`: `overrides`, `bundleDependencies`, `peerDependenciesMeta`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json)
- [npm folders: prefix, global `node_modules` and the Windows prefix](https://docs.npmjs.com/cli/v11/configuring-npm/folders)
- [npm install: default resolution of conflicting `peerDependencies`](https://docs.npmjs.com/cli/v11/commands/npm-install#strict-peer-deps)
- [Node `child_process`: `.bat`/`.cmd` cannot be launched with `execFile()`](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
- [node-gyp-build: prebuilds first, node-gyp build as fallback](https://www.npmjs.com/package/node-gyp-build)
- Audited registry artifacts:
  [tree-sitter 0.25.1](https://registry.npmjs.org/tree-sitter/-/tree-sitter-0.25.1.tgz),
  [tree-sitter 0.21.1](https://registry.npmjs.org/tree-sitter/-/tree-sitter-0.21.1.tgz),
  [tree-sitter-typescript 0.23.2](https://registry.npmjs.org/tree-sitter-typescript/-/tree-sitter-typescript-0.23.2.tgz),
  [tree-sitter-javascript 0.23.1](https://registry.npmjs.org/tree-sitter-javascript/-/tree-sitter-javascript-0.23.1.tgz),
  [tree-sitter-perl 2.0.0](https://registry.npmjs.org/tree-sitter-perl/-/tree-sitter-perl-2.0.0.tgz),
  [tree-sitter-kotlin 0.3.8](https://registry.npmjs.org/tree-sitter-kotlin/-/tree-sitter-kotlin-0.3.8.tgz),
  [@tree-sitter-grammars/tree-sitter-lua 0.2.0](https://registry.npmjs.org/@tree-sitter-grammars/tree-sitter-lua/-/tree-sitter-lua-0.2.0.tgz)

