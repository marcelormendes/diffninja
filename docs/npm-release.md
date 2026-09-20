# Publishing diffninja to npm

**Status: prepared, not published.** `diffninja@0.1.0` is packaged and its
release pipeline is written, but nothing has been published to the npm
registry, and no npm credentials were created, used or stored while preparing
this. Publishing requires an explicit maintainer action: either the manual
bootstrap below or pushing a release tag after the OIDC trust is configured.

Two things follow from that, and they are the reason this page exists:

- **Preparation is not publication.** The `package.json`, the packed tarball,
  the release workflow and the verification script below describe what a
  release *would* do. They do not mean `npm install -g diffninja` works today.
- **Untested platforms are untested.** Only Linux x64 was executed locally.
  Everything else in the matrix below is static evidence from the published
  package metadata unless the GitHub Actions matrix has run for that runner.
  Nothing here claims a platform works because a prebuild file exists.

## What is prepared

| Piece | State |
|---|---|
| `package.json` | `diffninja@0.1.0`, public, `publishConfig.access: public`, `engines.node: >=22.18.0`, bins `diffninja` and `diffninja-mcp`, `files: dist/**/*.js`, `dist/**/*.d.ts` |
| `.github/workflows/release.yml` | release pipeline: gate on a `v<version>` tag, then OIDC publish |
| `scripts/verify-package.mjs` | installs a packed tarball into a throwaway prefix and exercises the published surface |
| Tarball | `dist` JS + declarations, `package.json`, `README.md`, `LICENSE` — 105 files, roughly 150 kB packed. `src`, `test`, `scripts`, `tsconfig.json`, `vitest.config.ts` and `package-lock.json` are absent |

## npm-side configuration (required before the workflow can publish)

Trusted publishing is a relationship between the npm package and this
repository. It is configured on npmjs.com, once, by a maintainer:

1. Open <https://www.npmjs.com/package/diffninja/access> (the package must exist
   first — see the bootstrap section below).
2. In **Trusted Publisher → Select your publisher**, choose **GitHub Actions**
   and fill the fields exactly as follows:

   | Field | Value |
   |---|---|
   | Organization or user | `marcelormendes` |
   | Repository | `diffninja` |
   | Workflow filename | `release.yml` |
   | Environment name | *(leave empty)* |
   | Allowed actions | **`npm publish`** |

   All fields are case-sensitive and are checked against the OIDC claims at
   publish time. The workflow file name is the bare filename in
   `.github/workflows/`, not a path.

   **The allowed action matters.** Trusted publisher connections created on or
   after 2026-09-03 default to `npm stage publish` only; a connection that is
   not explicitly allowed to run `npm publish` will reject this workflow's
   `npm publish` step. Tick `npm publish` (leave `npm stage publish` at its
   default if you like).

   The environment name is empty because `.github/workflows/release.yml` does
   not declare `environment:`. If you add a GitHub environment later — for
   example to require manual approval before publishing — the environment name
   in this form must match it exactly.

3. Recommended hardening, per npm's own guidance, after the first successful
   workflow release: set the package's **Publishing access** to *Require
   two-factor authentication and disallow tokens*, and protect the `v*` tag
   pattern in the repository so only maintainers can create release tags.
   Neither step affects OIDC publishing.

`.github/workflows/release.yml` needs `id-token: write`, which it grants to the
publish job alone; `repository.url` in `package.json`
(`git+https://github.com/marcelormendes/diffninja.git`) already matches the
GitHub repository, which npm requires.

Prerequisites on the publishing side: npm CLI **11.5.1** or newer on Node
**22.14** or newer (the workflow pins Node 24 and refuses to publish when the
npm CLI is older than 11.5.1), and GitHub-hosted runners — self-hosted runners
are not supported by npm's OIDC exchange.

The equivalent command-line configuration, for maintainers who prefer it over
the web form (npm 11.15.0 or newer, interactive 2FA, package must exist):

```bash
npm trust github diffninja --file release.yml --repo marcelormendes/diffninja --allow-publish
npm trust list diffninja   # verify
```

## First publish: the bootstrap limitation

**npm cannot configure trusted publishing for a package that does not exist
yet.** `npm trust`'s prerequisites state it plainly — "Package must exist: The
package you're configuring must already exist on the npm registry" — and the
package settings page that hosts the trusted publisher form only exists once
the package does. OIDC therefore cannot create the very first version of
`diffninja`.

So the first release from a brand-new package name is one deliberate manual
publish, after which the workflow takes over. The order matters, because a
`v0.1.0` tag pushed at the wrong moment produces a failed run: npm refuses to
publish a version that already exists, so the tag that would publish `0.1.0`
must not be the one that starts CI.

1. After the release blockers below are resolved and the prepared checkout is
   approved, Marcelo performs the first publish interactively:

   1. Run `npm login` and complete the browser sign-in.
   2. Enable npm account 2FA for authorization and writes, if not already enabled.
   3. Run `npm publish --access public` from that checkout and complete the
      requested 2FA verification. `prepack` cleans and rebuilds the package.

   Do **not** push a `v0.1.0` tag around this: the tag would start a run whose
   publish step fails because `0.1.0` already exists.

   `npm pack` runs `prepack`, which builds `dist/` first, so this tarball has
   the same contents the workflow would have packed from the same commit. The
   workflow's guarantee is stronger than equality with a local build, though: it
   publishes the exact file it packed and verified, and re-checks that file's
   SHA-256 in the publish job before uploading it. (`npm pack` is reproducible
   for a given `dist/` here — repeated packs produced identical SHA-256 — but
   nothing in this pipeline depends on rebuilding it somewhere else.)

2. Configure the trusted publisher on npmjs.com as described above — now that
   the package exists, the settings page and `npm trust` both work.

3. Release the next version through the workflow: bump `version` in
   `package.json` (say to `0.1.1`), commit it to `main`, then tag and push:

   ```bash
   git tag v0.1.1 && git push origin v0.1.1
   ```

   The tag gate verifies the tag against `package.json`, and the publish job
   then uploads the verified tarball over OIDC.

The next release also needs a version bump in `package.json` and its lockfile.
If OIDC authentication fails, fix the trust configuration; do not add an npm
token secret as a workaround. Re-publishing an existing version fails by design.

## What the release workflow does

Trigger: a push of a tag matching `v*`. The exact shape is checked in the first
step, and everything else gates on it.

| Job | Runner(s) | Purpose |
|---|---|---|
| `verify` | `ubuntu-latest` | Tag/version gate, then `npm ci`, build, lint, tests, `npm pack`, artifact upload |
| `install-matrix` | `ubuntu-latest`, `ubuntu-24.04-arm`, `macos-15-intel`, `macos-latest`, `windows-latest` | Install the packed tarball and run `scripts/verify-package.mjs` |
| `minimums` | `ubuntu-latest` | Same tarball install on the declared floor: Node 22.18.0 with npm 11.5.1 |
| `publish` | `ubuntu-latest` | Re-check the artifact digest, then `npm publish` with OIDC (`id-token: write`) |

As of this writing those labels resolve to Ubuntu 24.04 x64, Ubuntu 24.04
arm64, macOS 15 x64, macOS 26 arm64 and Windows Server 2025 x64; GitHub moves
the `-latest` labels on its own schedule, which is why the matrix runs the
tarball check on each one rather than trusting a label.

The tag gate rejects a release when any of these is true: the tag is not
`v<package.json version>`; the version is not a plain `X.Y.Z`; the package name
is not `diffninja`; `private` is still set; or the tagged commit is not
contained in `main` (set `RELEASE_BRANCH` in the workflow to change that
branch). The publish job does not check out the repository: it downloads the
tarball uploaded by `verify`, verifies its SHA-256, and publishes only that
file. Git tags point at commits, so a tag that never passed the gate cannot
reach the registry through this workflow.

`npm publish` is issued without `--provenance`: npm generates provenance
attestations automatically for OIDC publishes of public packages from public
repositories.

Troubleshooting, in the order these actually bite:

- `ENEEDAUTH` / "Unable to authenticate": the workflow filename in the trusted
  publisher form does not match `release.yml` exactly, `id-token: write` is
  missing from the publish job, the runner is not GitHub-hosted, or the
  connection is not allowed to run `npm publish` (stage-only).
- `EOTP` or a 2FA prompt in CI: the connection is not the one being used, or
  the package still requires token-based OTP. OIDC publishes are not prompted.
- No provenance badge after a successful publish: provenance is skipped for
  private repositories and private packages. Verify both are public.
- `Cannot implicitly apply the "latest" tag`: a higher version already exists
  on the registry. Bump `version` (and the tag) or publish with an explicit
  `--tag`.

## Native packages: what ships, what is proven

The runtime and grammar dependency trees can include the following native
packages. Their prebuilds were enumerated from registry tarballs and checked
against installed dependencies:

| Package | linux x64 | linux arm64 | macOS x64 | macOS arm64 | win x64 | win arm64 |
|---|---|---|---|---|---|---|
| `tree-sitter` 0.25.1 (runtime, direct dependency) | prebuild, loads | prebuild (AArch64 ELF) | prebuild | prebuild | prebuild | prebuild |
| `tree-sitter-typescript` 0.23.2 (bundled grammar) | prebuild, loads | **prebuild is x86-64 code** | prebuild | prebuild | prebuild | prebuild |
| `tree-sitter-javascript` 0.23.1 (grammar dependency) | prebuild, loads | **prebuild is x86-64 code** | prebuild | prebuild | prebuild | prebuild |
| `tree-sitter` 0.21.1 (second copy, see below) | prebuild | none — builds from source | prebuild | prebuild | prebuild | none — builds from source |

Every cell above is static evidence: file inventory plus the executable header
of each `.node` file. Nothing has executed on macOS, Windows or arm64 Linux.

Four findings worth knowing before a release:

1. **The bundled 0.23.x grammars are mis-labeled on Linux arm64.** In
   `tree-sitter-typescript@0.23.2` and `tree-sitter-javascript@0.23.1`,
   `prebuilds/linux-arm64/*.node` is byte-identical to the x86-64 file
   (`md5` match; `readelf -h` reports `Advanced Micro Devices X86-64`). The
   load fails on an arm64 host even though the file exists, so TypeScript/TSX
   call-flow extraction cannot work on Linux arm64 with the shipped binaries.
   The TypeScript extraction smoke in `scripts/verify-package.mjs` exercises
   native loading. Linux ARM64 is a **required** release gate, not an allowed
   failure: publication stays blocked until the upstream packages ship correct
   binaries or a separately verified source-build distribution strategy exists.
   Recommended path: report the mislabeled artifacts upstream, update both
   grammars to corrected releases, then pass the ARM64 consumer gate.
   An opt-in local workaround is a source rebuild in the installed package:
   `npm rebuild --prefix /absolute/path/to/installed/diffninja tree-sitter-typescript tree-sitter-javascript --build-from-source`.
   It needs Python and a C/C++ toolchain. The rebuild path was exercised on
   Linux x64, not ARM64; it is not a substitute for the clean-install gate.

2. **`tree-sitter@0.25.1` needs a recent `libstdc++` on Linux.** Its Linux
   prebuilds import `GLIBCXX_3.4.31` (GCC 13.1 and newer; `libstdc++` from
   Ubuntu 24.04 or newer) and `GLIBC_2.17`. Loading that addon against Ubuntu
   22.04's `libstdc++` fails with `version 'GLIBCXX_3.4.31' not found`, while
   the same file loads against the local 3.4.33. The failure therefore lands on
   first use, not at install time, and it applies to Linux x64 and arm64 alike;
   `npm rebuild --prefix /absolute/path/to/installed/diffninja tree-sitter --build-from-source`
   against the host toolchain is the workaround. The matrix targets Ubuntu
   24.04, not a claim of compatibility with every glibc-based distribution.

3. **Grammar peer ranges differ from the runtime.** The bundled grammars declare
   optional peers `tree-sitter@^0.21.0` / `^0.21.1`, while diffninja requires
   `^0.25.1`. Clean local installs can add a separate `0.21.1` to satisfy them.
   The final global-prefix install on Node 22.18/npm 11.5.1 instead deduplicated
   onto `0.25.1` and printed `ERESOLVE overriding peer dependency` warnings.
   Install exited 0 and native extraction, CLI and MCP passed; `npm ls` still
   exits with `ELSPROBLEMS`, correctly marking the peer ranges invalid.

   Where the extra `0.21.1` is installed, it has no Linux ARM64 or Windows ARM64
   prebuild and needs a native build toolchain. It is not used by diffninja's
   parser, but its installation can still fail. Do not hide the mismatch with
   consumer `--force` / `--legacy-peer-deps` instructions.

   The repository's `package.json` carries an `overrides` entry that forces the
   grammar's `tree-sitter` to the root version; npm applies `overrides` in the
   root project only, so consumers never see it. Dropping that entry makes the
   repository's own install fail with `ERESOLVE` — reproduced here on Node 24
   with npm 10.9.4 and with npm 11.5.1, both reporting
   `peerOptional tree-sitter@"^0.21.0" from tree-sitter-typescript@0.23.2` against
   `Conflicting peer dependency: tree-sitter@0.21.1`. With the entry in place
   `npm ci` succeeds on both. The real fix belongs upstream, as a widened peer
   range in the grammar packages — not a parser downgrade here and not a
   peer-check bypass flag in the release pipeline.

4. **Some on-demand grammars have no prebuilds at all.** `tree-sitter-python`,
   `-rust` and `-go` ship all six, but `tree-sitter-perl@2.0.0` and
   `tree-sitter-kotlin@0.3.8` ship none, so installing them into the grammar
   cache compiles them with node-gyp — a C/C++ toolchain and Python are needed
   on first use of that language in a git-range review. `scripts/verify-package.mjs`
   does not cover that path (its on-demand case is Python, which ships
   prebuilds).

   The full suite initially had 369 passing tests and 25 Perl/Kotlin failures:
   node-gyp's Node header extraction failed with `EPERM: fchown` in this
   sandbox. All 25 passed on rerun with `npm_config_nodedir=/usr`, using the
   already-installed matching Node 24.20 headers. No product code or test was
   changed to suppress it. Hosted CI still needs to execute this gate.

   The failure mode is bounded either way: a grammar that cannot be installed
   sets `callFlowAvailability` to `"failed"` and adds a warning, and the review
   still runs on the diff alone.

## Windows npm and browser launching

Fixed in `src/languages/grammars.ts`: Windows runs npm's `npm-cli.js` with the
current absolute Node executable rather than trying to execute `npm.cmd`.
Resolution uses absolute PATH entries and the Node executable's directory;
official Node/npm layouts are supported, while custom layouts without that
entry fail with an actionable error. No shell is used, so spaces, `%`, `!` and
`&` in cache paths remain literal. The regression test executes a temporary npm
entry and checks the arguments it receives. Real Windows installation is a
required CI gate, not something executed on this Linux workstation.

The starting main branch lacked the connected-review browser fix. This branch
restores `rundll32.exe url.dll,FileProtocolHandler <file-URL>` for Windows.
A simulated-platform smoke exercised the built CLI's dispatch; a real Windows
desktop browser was not available. MCP clients bypass all command shims using
the absolute Node executable plus absolute installed `mcp-cli.js` path; see
the platform discovery commands in README.

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
installation or populate the user's npm cache.
It checks the complete compiled file list against current sources (catching
stale output), both npm bin shims and the absence of `calldiff`, a mock CLI
HTML/JSON report, native TypeScript extraction, on-demand Python installation
into a cache path with spaces, and an MCP stdio review with matching structured
and JSON-text results. The Windows gate launches the CLI's `.cmd` from
PowerShell. Any failure prevents publication.

Linux x64 consumer smoke passed on Node 24.20.0/npm 10.9.4 and on the Node
22.18.0/npm 11.5.1 floor. Global installs emit the peer warnings described above.
macOS, Windows and Linux ARM64 runtime results are still pending the hosted
matrix. The ARM64 native artifact defect is known, so do not treat preparation
as release approval. Perl/Kotlin source builds are exercised by the full test
suite, not by the Python consumer smoke.

When `/tmp` is a small tmpfs, set `TMPDIR` to a scratch directory with enough
disk space before running the consumer script. It removes its own sandbox.

## Primary references

- [npm trusted publishers: OIDC requirements and configuration](https://docs.npmjs.com/trusted-publishers/)
- [npm trust: existing-package prerequisite](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
- Audited registry artifacts:
  [tree-sitter 0.25.1](https://registry.npmjs.org/tree-sitter/-/tree-sitter-0.25.1.tgz),
  [tree-sitter 0.21.1](https://registry.npmjs.org/tree-sitter/-/tree-sitter-0.21.1.tgz),
  [tree-sitter-typescript 0.23.2](https://registry.npmjs.org/tree-sitter-typescript/-/tree-sitter-typescript-0.23.2.tgz),
  [tree-sitter-javascript 0.23.1](https://registry.npmjs.org/tree-sitter-javascript/-/tree-sitter-javascript-0.23.1.tgz).
