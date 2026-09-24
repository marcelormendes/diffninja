# Publishing diffninja to npm

**Status: prepared, not published.** `diffninja@0.1.0` is packaged and its
release pipeline is written, but nothing has been published to the npm registry,
and no npm credentials were created, used or stored while preparing this.
(`https://registry.npmjs.org/diffninja` answered 404 when checked: no public
package metadata was available. This does not guarantee the name is publishable.)

Publishing requires an explicit maintainer action: the manual bootstrap below,
then the trusted-publisher configuration, then tags. Two consequences follow:

- **Preparation is not publication.** `package.json`, the packed tarball, the
  release workflow and the verification script describe what a release *would*
  do. They do not mean `npm install -g diffninja` works today.
- **Platforms are verified by CI.** `.github/workflows/consumer-matrix.yml`
  packs once and runs `scripts/verify-package.mjs` against a real global
  install on Ubuntu x64 and ARM64, macOS x64 and ARM64, and Windows x64, on
  Node 22 and 24. It runs on every pull request and on demand.

## What is prepared

| Piece | State |
|---|---|
| `package.json` | `diffninja@0.1.0`, `publishConfig.access: public`, `engines.node: >=22.18.0`, bins `diffninja` and `diffninja-mcp` (no `calldiff` bin), `files: ["dist/**/*.js", "dist/**/*.d.ts"]`, no `bundleDependencies` |
| Packed tarball contents | `dist` JavaScript + declarations, `package.json`, `README.md`, `LICENSE`; no `src`, `test`, `scripts`, `tsconfig.json`, `vitest.config.ts` or lockfile, and no `node_modules` |
| `.github/workflows/release.yml` | one workflow: metadata gate, tag gate on tag pushes, build/lint/test/pack, four-runner install matrix, minimum-toolchain job, OIDC publish job |
| `.github/workflows/consumer-matrix.yml` | pack once, then a 5-OS x 2-Node consumer matrix (Ubuntu x64/ARM64, macOS x64/ARM64, Windows x64; Node 22/24) that globally installs the tarball and runs `scripts/verify-package.mjs`; runs on PRs and on demand |
| `scripts/verify-package.mjs` | installs the packed tarball into a throwaway prefix and exercises the installed surface |

## What a consumer actually installs

The published tarball carries compiled JavaScript, type declarations and package
metadata/documentation. Grammar support comes from npm dependencies:

- `tree-sitter@^0.25.1` is a direct `dependency`; `tree-sitter-typescript@^0.23.2`
  is an `optionalDependency`; `tree-sitter-javascript@0.23.1` is
  tree-sitter-typescript's own dependency. npm installs all three from the
  registry next to diffninja.
- Declaring tree-sitter-typescript optional is what keeps a broken prebuild from
  aborting the install: npm ignores the failure of an optional dependency's
  install script instead of exiting non-zero. The `postinstall` heal
  (`scripts/ensure-native-grammar.mjs`, shipped in the tarball) then loads the
  binding for real and, on failure, deletes the package's shipped prebuild
  directory and recompiles the grammar from source — see finding 3.
- npm's `bundleDependencies`/`bundleDependencies: true` — which would inline a
  `node_modules` tree into the published package — is not used, and the packed
  tarball contains no `node_modules` entries. "Bundled grammar" in older drafts
  meant the first bullet; it was never npm bundling.
- Every other language's grammar is fetched on demand into
  `CALLDIFF_GRAMMAR_CACHE` (default `~/.cache/calldiff/grammars`, or
  `C:\Users\<you>\.cache\calldiff\grammars` on Windows) by running
  `npm install --prefix <cache> --no-save --no-fund --no-audit
  --legacy-peer-deps <spec>`. A grammar already present in the cache is loaded
  from disk without npm running at all.

JavaScript is a transitive dependency, not a direct dependency of diffninja.
If npm nests it under `tree-sitter-typescript`, the loader cannot resolve it
directly and instead installs `tree-sitter-javascript` into the grammar cache.
The local `npm ci` layout exercised this fallback. Thus JavaScript/JSX can
require on-demand installation too; on Windows preinstall it with `npm.cmd`
using the same cache recipe as other on-demand grammars.

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
yet.** `npm trust` states it as a prerequisite — "Package must exist: The
package you're configuring must already exist on the npm registry" — and the
package settings page that hosts the trusted-publisher form only exists once the
package does. OIDC therefore cannot create the first version of `diffninja`.

So the first release is one deliberate manual publish, after which the workflow
takes over. The order matters: npm refuses to publish a version that already
exists, so the tag that would publish `0.1.0` must not be the one that starts CI.

1. **Verify the package, from the approved commit, before logging in.** The same
   gates the workflow runs must pass locally first: `npm ci`, `npm run build`,
   `npm run lint`, `npm test`, then `mkdir -p dist-pack`,
   `npm pack --pack-destination dist-pack` and
   `node scripts/verify-package.mjs dist-pack`. A `workflow_dispatch` run of
   `.github/workflows/release.yml` is the way to verify the macOS and Windows
   consumers before the first publish, because it runs the whole pipeline with
   `publish` skipped (only a pushed tag sets `release=true`).
2. **Marcelo publishes interactively:**
   1. `npm login` and complete the browser sign-in.
   2. Enable npm account 2FA for authorization and writes, if not already on.
   3. `npm publish --access public` from that checkout, completing the 2FA
      prompt. `prepack` cleans and rebuilds `dist/` first, so the tarball has the
      same contents the workflow would pack from the same commit.
   4. Do **not** push a `v0.1.0` tag around this: the tag would start a run whose
      publish step fails because `0.1.0` already exists.
3. **Configure the trusted publisher** as described above — now that the package
   exists, both the settings page and `npm trust` work.
4. **Release the next version through the workflow:** bump `version` in
   `package.json` (and the lockfile), commit to `main`, then tag and push:

   ```bash
   git tag v0.1.1 && git push origin v0.1.1
   ```

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

The issues below were investigated from source, from the installed dependencies
on this workstation and from registry tarballs. None of them is a runtime change
in this branch; the ones with a consumer-visible workaround are documented in
README.md.

### 1. Windows: the on-demand grammar install (fixed)

`src/languages/grammars.ts` used to install a missing grammar with
`execFileSync("npm", ["install", "--prefix", cacheDir, …])`. Node's own
documentation is explicit that on Windows `.bat` and `.cmd` files "are not
executable on their own without a terminal, and therefore cannot be launched
using `child_process.execFile()`" — the supported forms are `spawn` with
`shell: true`, `exec`, or spawning `cmd.exe`. npm's Windows entry points are
`.cmd`/`.ps1` shims, so this call could not reach npm on Windows. Linux and
macOS are unaffected because `npm` is an executable script there.

Fixed: `npmSpawnSpec()` now resolves npm's `npm-cli.js` on Windows (via `PATH`
plus the Node install directory, never the repository being reviewed) and runs
it with the current Node executable, so cache paths with spaces and percent
signs stay literal argv values instead of being interpreted by `cmd.exe`.
`scripts/verify-package.mjs` exercises the on-demand Python extraction on
Windows, and the consumer matrix runs it on real Windows Server. The `npm.cmd`
preinstall recipe in README.md remains as the offline option.

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

Fixed twice over, on purpose:

- **Install time (this release).** `tree-sitter-typescript` is an
  `optionalDependency`, so the upstream install-script failure — `node-gyp-build`
  falls back to `node-gyp rebuild`, which under Node 22 dies on a malformed
  generated Makefile — no longer aborts `npm install -g diffninja`. The
  `postinstall` in `scripts/ensure-native-grammar.mjs` probes the binding end to
  end (require parser, `setLanguage`, `parse`), and when that fails deletes
  `prebuilds/` and `build/` inside the installed package and runs
  `npm rebuild tree-sitter-typescript` with `CXXFLAGS='-std=c++20'` (the Node 22+
  headers require C++20 and `binding.gyp` does not request it). Because
  node-gyp-build prefers `build/Release` over any prebuild, the corrected binary
  is the one loaded afterwards. The script is a heal, not a gate: it always exits
  0, warns when no toolchain is available, and never touches a platform whose
  prebuild loads.
- **First use (existing).** `src/languages/grammars.ts` reads a prebuild's binary
  header (ELF/Mach-O/PE machine type) before trusting it. When the platform's
  prebuild exists but targets another CPU, the loader removes the bad artifact
  from diffninja's own grammar cache and lets node-gyp-build fall back to
  compiling from source. The installed copy is never modified by this path.

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
time. The loader now detects the `GLIBCXX`/`GLIBC_` symbol error and says so
plainly, naming the GCC 13.1+/Ubuntu 24.04+ requirement and the
`npm rebuild <pkg> --build-from-source` workaround. The matrix targets Ubuntu
24.04, not every glibc-based distribution.

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

### 6. On-demand grammars without a usable prebuild

`node-gyp-build` falls back to a source build when no prebuild matches the
platform, and several grammar packages have nothing to match. From registry
tarballs (this session):

| Package | Prebuilds | Install script |
|---|---|---|
| `tree-sitter-python`, `-rust`, `-go`, `-ruby`, `-php`, `-bash`, `-c`, `-cpp`, `-java`, `-c-sharp`, `-elixir`, `-haskell`, `-ocaml`, `-scala`, `-solidity`, `-swift`, `@tree-sitter-grammars/tree-sitter-zig` (1.1.2) | all six platform/arch directories | `node-gyp-build` |
| `@tree-sitter-grammars/tree-sitter-lua@0.2.0` | darwin-arm64, darwin-x64, linux-x64, win32-x64 only | `node-gyp-build` |
| `tree-sitter-perl@2.0.0` | none | `node-gyp-build` |
| `tree-sitter-kotlin@0.3.8` | none | `node-gyp-build` |

So Perl and Kotlin always compile from source on first use, Lua cannot use a
prebuild on Linux ARM64 or Windows ARM64, and all of those need a C/C++
toolchain and Python. The obsolete unscoped `tree-sitter-zig@0.2.0` is a
different package (nan-era, no install script, no prebuilds); `src/languages/zig.ts`
deliberately requests the scoped `@tree-sitter-grammars/tree-sitter-zig`.

Prebuilds do not imply a registry-only installation. `tree-sitter-swift@0.7.1`
also depends on `tree-sitter-cli@^0.23`; that dependency's install script
downloads an executable from GitHub Releases. In this workstation's network
environment, the 0.23.2 downloader hung through the proxy and failed with
`EPROTO` without it. The grammar install now retries up to three times with
backoff and a five-minute per-attempt timeout, and a failed Swift install says
plainly that the GitHub Releases download needs network access to github.com.
The grammar can load from an already populated cache without that CLI
executable, but a complete on-demand install needs the GitHub download to
succeed.

Two grammars are pinned by `installSpecFor` and a manual preinstall must use the
same spec: `tree-sitter-c-sharp@0.23.1` and
`@tree-sitter-grammars/tree-sitter-lua@0.2.0`; everything else installs at its
latest version.

Failure is per file and non-fatal: extraction logs
`warn: failed to parse <file> @ <commit>` and the review completes with the
diff and whatever call flows resolved (`callFlowAvailability` is `"failed"` only
when the analysis itself throws). Install and load failures now carry the real
prerequisite (toolchain, network, libstdc++) instead of npm's raw stderr.
Verified locally with a deliberately broken `npm`: a mock git-range Ruby review
exited 0, wrote both report files, and warned per revision.

### 7. npm 12: dependency install scripts are blocked by default

npm 12 skips every dependency's `preinstall`/`install`/`postinstall` unless it
is allowed by name, and only warns. Where tree-sitter has a prebuild for the
platform nothing visible breaks, but the Linux ARM64 repair (finding 3) and any
grammar that compiles from source or downloads at install (finding 6, Swift)
would silently not run. Two install paths name what they need:

- `diffninja setup` runs `npm install -g --allow-scripts=diffninja,tree-sitter,tree-sitter-javascript,tree-sitter-typescript diffninja`.
  The names match a registry install's identity; a local tarball install
  matches by file path instead, so the consumer matrix cannot prove this part.
- The on-demand grammar install is a project-scoped install into the cache,
  where npm 12 rejects `--allow-scripts` (flag, environment and all) with
  `EALLOWSCRIPTS`. The cache's `package.json` gains an `allowScripts` entry
  for each grammar before it is installed instead.

npm 10.9 and 11.5.1 accept the flag and ignore the field; both were checked
with the same commands.

## Native prebuild inventory

Enumerated from the installed packages and registry tarballs on Linux x64, then
header-checked (ELF/Mach-O/PE machine type): file inventory plus each `.node`
header. Nothing in this table executed on macOS, Windows or ARM64 Linux. The
linux-arm64 mislabeling above is now repaired before first use (see finding 3):
the install-time postinstall rebuilds the grammar from source, and the loader's
wrong-CPU header check still repairs the on-demand grammar cache.

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
README's **Absolute paths for MCP client configuration** section includes
PowerShell's `ConvertTo-Json` recipe. Recompute paths after changing npm prefixes
or Node installations. The server accepts no CLI arguments and reserves stdout
for MCP, so a successful start waits for protocol input rather than a banner.

## Remaining decisions

- **Upstream fixes to request:** corrected `prebuilds/linux-arm64/*.node` in
  `tree-sitter-typescript@0.23.2` and `tree-sitter-javascript@0.23.1` (diffninja
  rebuilds the mislabeled TypeScript grammar during `postinstall`, but a correct
  prebuild would skip the source compile); a `binding.gyp` that requests C++20,
  which the Node 22+ headers require; widened `tree-sitter` peer ranges in those
  packages;
  prebuilds (or an explicit "source build" note) for `tree-sitter-perl`,
  `tree-sitter-kotlin` and the ARM64 gaps in
  `@tree-sitter-grammars/tree-sitter-lua@0.2.0`.
- **Whether to pin every on-demand grammar** rather than only the two in
  `installSpecFor`.
- **The first manual publish itself:** still blocked on the maintainer's explicit
  go-ahead and credential use. Nothing in this branch logs in, publishes, tags,
  pushes or merges.

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
of a `calldiff` bin, the setup-only `diffninja` refusing a terminal review, native
TypeScript extraction, on-demand grammar extraction into a cache path
containing spaces (on every platform, proving the Windows npm invocation),
and an MCP stdio review whose `structuredContent` matches its JSON text.
On Windows it launches `diffninja.cmd` and `diffninja-mcp.cmd` explicitly from
PowerShell, because a host may block `.ps1` shims. Any failure prevents
publication.

Results so far: Linux x64 passes on Node 24.20.0/npm 10.9.4 and on the declared
floor, Node 22.18.0/npm 11.5.1. Global installs emit the peer warnings described
in finding 5 and still exit 0. Every other platform result comes from the
consumer matrix (`.github/workflows/consumer-matrix.yml`), which runs on each
pull request: Ubuntu x64 and ARM64, macOS x64 and ARM64, Windows x64, each on
Node 22 and 24.

When `/tmp` is a small tmpfs, set `TMPDIR` to a scratch directory with enough
disk space before running the consumer script. It removes its own sandbox.

For concurrent local test runs, use a private `TMPDIR`: the existing test setup
names its grammar caches by worker number beneath that directory, not by
worktree. Native source builds in this sandbox also used
`npm_config_nodedir=/usr` to reuse the matching installed Node 24 headers.
That header path is machine-specific; do not apply it to a different Node
version or assume it exists on another platform.

### Local preparation verification

- `npm ci`, `npm run build` and `npm run lint` passed.
- The unchanged full suite passed: **393 tests in 46 files**, using
  `npm test -- --maxWorkers=2` with a private `TMPDIR`, matching local Node
  headers, and all 21 on-demand grammars available to both workers. The native
  grammars were real packages, including locally compiled Perl/Kotlin; no test
  assertions or runtime code were changed. Earlier runs used a shared cache
  and/or encountered Swift's download timeout described above; this passing run
  proves cached native behavior, not reliable cold Swift installation through
  this workstation's proxy.
- `npm pack --dry-run` and the final real pack contain **105 files**:
  `LICENSE`, `README.md`, `package.json`, 51 JavaScript files and 51 declarations.
  The final tarball is 153,906 bytes; no stale `tmp-report.js`, source, tests,
  development scripts or lockfile is included.
- The final tarball passed clean-room global installation on Linux x64 with
  Node 24.20.0/npm 10.9.4 and Node 22.18.0/npm 11.5.1: both installed command
  shims, mock CLI reports, native TypeScript/Python and an MCP stdio review.
  A minimum-toolchain install initially hit the consumer script's network
  timeout; a fresh-prefix rerun passed.
- npm's real shim generator produced correctly targeted `.cmd` and `.ps1`
  files for both bins. These were inspected on Linux, not executed on Windows.
- `actionlint` 1.7.12 accepted the workflow. Executed metadata-gate checks
  allowed publication only for a tag push, denied PR/manual-dispatch events,
  and rejected a tag/version mismatch. The hosted workflow itself was not run.

Temporary test caches and downloaded validation tooling were removed. The
ignored `dist-pack/` directory retains the tarball, its SHA-256 sidecar and the
complete `pack-files.txt` inventory for inspection; these are not npm contents.

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
