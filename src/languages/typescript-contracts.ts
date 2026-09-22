/**
 * TypeScript / TSX type contracts for review context.
 *
 * An interface, type alias, or enum is syntactic evidence about a shape, not a
 * callable: the entries this helper adds carry `review.kind`, no steps, and the
 * whole declaration span, and the extractor keeps them out of the callable
 * index. What they *do* carry is `review.references`: the type names written in
 * a definition's signature, body, or declaration — `Promise<Foo>`,
 * `x as Bar`, `interface A extends B`, `foo<Baz>()`, `import("m").Q` — each
 * with the module specifier and original name it was written through.
 *
 * {@link resolveTypeContracts} turns those references into snapshot-local
 * edges. Relative imports bind to snapshot paths; a bare or aliased module
 * path binds only when one snapshot file's path suffix matches it. Unresolved
 * imports stay unresolved, even when another file has a unique same-named
 * declaration. Unimported names prefer the same file, then a unique snapshot
 * candidate. These are syntactic candidates, not TypeScript symbol resolution.
 *
 * Every step is derived from the source and the snapshot declarations, so the
 * same input always yields the same edges.
 *
 * Deliberate limits: only module-level declarations are extracted; references
 * in module-level value code, class field annotations, and heritage clauses
 * belong to no definition and are dropped; re-export/barrel hops are not
 * followed; a default import is matched by its local binding name; a
 * declaration that names itself is not an edge. External types absent from
 * the snapshot remain unresolved.
 */
import type Parser from "tree-sitter";
import type { FunctionInfo } from "../types.js";

type Tree = Parser.Tree;
type SyntaxNode = Parser.SyntaxNode;

/** Declaration kinds recorded as non-callable contract nodes. */
type ContractKind = "interface" | "type" | "enum";

/** Shape of one `review.references` entry, as declared on {@link FunctionInfo}. */
type TypeReference = NonNullable<
  NonNullable<FunctionInfo["review"]>["references"]
>[number];

/** Where one written reference was found; kept out of the serialized field. */
interface ReferenceSite {
  line: number;
  written: string;
}

/**
 * Line and original spelling of each reference entry. The entry objects live
 * inside `review.references`, so the extractor's cache spreads (which copy the
 * `review` object but keep its arrays and entries) preserve the lookup.
 */
const SITE_INFO = new WeakMap<TypeReference, ReferenceSite>();


/** Declaration nodes whose `name` field names the type instead of using it. */
const NAME_FIELDS = {
  interface_declaration: true,
  type_alias_declaration: true,
  class_declaration: true,
  abstract_class_declaration: true,
  class: true,
  type_parameter: true,
  mapped_type_clause: true,
};

/** A written type reference, before it is attributed to a definition. */
interface Site {
  name: string;
  written: string;
  module?: string;
  imported?: string;
  /** Byte offset of the reference, which decides its owning definition. */
  offset: number;
  line: number;
}

/** Import provenance of one local binding: where the name came from. */
interface ImportBinding {
  module: string;
  /** Original export name, only when the local alias differs from it. */
  imported?: string;
}

/* ------------------------------------------------------------------ text */

function stringValue(literal: SyntaxNode): string {
  const fragment = literal.namedChildren.find((c) => c.type === "string_fragment");
  return fragment ? fragment.text : literal.text.replace(/^['"]|['"]$/g, "");
}

/* --------------------------------------------------------------- imports */

/** Module binding of an `import` clause: default names, namespaces, aliases. */
function readImportClause(
  clause: SyntaxNode,
  module: string,
  into: Map<string, ImportBinding>,
): void {
  for (const child of clause.namedChildren) {
    // A default import binds the module's default under a local name; the
    // original name is not written here, so only the module is recorded.
    if (child.type === "identifier") {
      into.set(child.text, { module });
      continue;
    }
    if (child.type === "namespace_import") {
      const local = child.namedChildren.find((c) => c.type === "identifier");
      if (local) into.set(local.text, { module });
      continue;
    }
    if (child.type !== "named_imports") continue;
    for (const specifier of child.namedChildren) {
      if (specifier.type !== "import_specifier") continue;
      const original = specifier.childForFieldName("name");
      const alias = specifier.childForFieldName("alias");
      const local = alias ?? original;
      if (!local) continue;
      into.set(
        local.text,
        original && original.text !== local.text
          ? { module, imported: original.text }
          : { module },
      );
    }
  }
}

/** Every named import of the file, keyed by the name the file binds. */
function fileImports(root: SyntaxNode): Map<string, ImportBinding> {
  const imports = new Map<string, ImportBinding>();
  for (const statement of root.namedChildren) {
    if (statement.type !== "import_statement") continue;
    const clause = statement.namedChildren.find((c) => c.type === "import_clause");
    if (!clause) continue; // `import "./side-effect"` brings no binding
    const source = statement.childForFieldName("source");
    if (!source) continue;
    const module = stringValue(source);
    if (module === "") continue;
    readImportClause(clause, module, imports);
  }
  return imports;
}

/* ------------------------------------------------------------ references */

/** Type parameter names declared by a node, which shadow outer types. */
function declaredTypeParameters(node: SyntaxNode): string[] {
  const params =
    node.childForFieldName("type_parameters") ??
    node.namedChildren.find((c) => c.type === "type_parameters");
  if (!params) return [];
  const names: string[] = [];
  for (const parameter of params.namedChildren) {
    if (parameter.type !== "type_parameter") continue;
    const name = parameter.childForFieldName("name");
    if (name) names.push(name.text);
  }
  return names;
}

/** `infer U` names of a conditional type, in scope for its whole subtree. */
function inferNames(node: SyntaxNode): string[] {
  const names: string[] = [];
  const walk = (current: SyntaxNode): void => {
    if (current.type === "infer_type" || current.type === "infer_type_parameter") {
      const name = current.namedChildren.find((c) => c.type === "type_identifier");
      if (name) names.push(name.text);
    }
    for (const child of current.namedChildren) walk(child);
  };
  walk(node);
  return names;
}

/** Mapped-type keys (`{ [K in ...]: Foo[K] }`) of an object type. */
function mappedKeyNames(node: SyntaxNode): string[] {
  const names: string[] = [];
  const walk = (current: SyntaxNode): void => {
    if (current.type === "mapped_type_clause") {
      const name = current.childForFieldName("name");
      if (name) names.push(name.text);
    }
    for (const child of current.namedChildren) walk(child);
  };
  walk(node);
  return names;
}

/** True when a `type_identifier` declares a name rather than references one. */
function namesDeclaration(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return Object.hasOwn(NAME_FIELDS, parent.type) && parent.childForFieldName("name") === node;
}

/**
 * The leftmost module segment and whole spelling of a qualified type name:
 * `NS.Ext` -> `NS`, `A.B.C` -> `A`. Null for a plain `type_identifier`.
 */
function qualifiedTypeRoot(
  node: SyntaxNode,
): { root: SyntaxNode; written: string } | null {
  const parent = node.parent;
  if (!parent || parent.type !== "nested_type_identifier") return null;
  if (parent.childForFieldName("name") !== node) return null;
  let module: SyntaxNode | null = parent.childForFieldName("module");
  while (
    module &&
    (module.type === "nested_type_identifier" || module.type === "nested_identifier")
  ) {
    module =
      module.childForFieldName("module") ??
      module.childForFieldName("object") ??
      module.namedChildren[0] ??
      null;
  }
  return module ? { root: module, written: parent.text } : null;
}

/** Value name named by `typeof X` / `typeof a.b` in a type position. */
function typeQueryName(node: SyntaxNode): string | null {
  const operand = node.namedChildren[0];
  if (!operand) return null;
  if (operand.type === "identifier") return operand.text;
  if (operand.type === "member_expression") {
    const property = operand.childForFieldName("property");
    return property?.type === "property_identifier" ? property.text : null;
  }
  return null;
}

/** `import("mod").Name` — a reference whose module is written in the type. */
function importTypeReference(
  node: SyntaxNode,
): { written: string; name: string; module: string } | null {
  if (node.type !== "member_expression") return null;
  const object = node.childForFieldName("object");
  if (!object || object.type !== "call_expression") return null;
  const head = object.childForFieldName("function");
  if (!head || head.type !== "import") return null;
  const args = object.childForFieldName("arguments");
  const literal = args
    ? args.namedChildren.find((c) => c.type === "string")
    : undefined;
  const property = node.childForFieldName("property");
  if (!literal || property?.type !== "property_identifier") return null;
  const module = stringValue(literal);
  if (module === "") return null;
  return { written: node.text, name: property.text, module };
}

/**
 * Every type name written in the tree, with import provenance and position.
 * A generic's own parameters, an `infer` variable, and a mapped-type key are
 * shadowed, not recorded, so `function f<T>(x: T)` never references a `T`
 * declared elsewhere.
 */
function collectSites(
  root: SyntaxNode,
  imports: ReadonlyMap<string, ImportBinding>,
): Site[] {
  const sites: Site[] = [];

  const emit = (
    node: SyntaxNode,
    written: string,
    name: string,
    explicitModule?: string,
  ): void => {
    const binding =
      explicitModule !== undefined
        ? { module: explicitModule }
        : imports.get(name);
    const site: Site = {
      name,
      written,
      offset: node.startIndex,
      line: node.startPosition.row + 1,
    };
    if (binding) {
      site.module = binding.module;
      if (binding.imported !== undefined) site.imported = binding.imported;
    }
    sites.push(site);
  };

  const walk = (node: SyntaxNode, shadows: Set<string>): void => {
    const added: string[] = [];
    const shadow = (names: readonly string[]): void => {
      for (const name of names) {
        if (shadows.has(name)) continue;
        shadows.add(name);
        added.push(name);
      }
    };

    shadow(declaredTypeParameters(node));
    if (node.type === "conditional_type") shadow(inferNames(node));
    if (node.type === "object_type") shadow(mappedKeyNames(node));

    if (node.type === "type_identifier") {
      if (!namesDeclaration(node) && !shadows.has(node.text)) {
        const qualified = qualifiedTypeRoot(node);
        if (qualified) {
          const namespace = imports.get(qualified.root.text);
          emit(
            node,
            qualified.written,
            node.text,
            namespace && namespace.imported === undefined
              ? namespace.module
              : undefined,
          );
        } else {
          emit(node, node.text, node.text);
        }
      }
    } else if (node.type === "type_query") {
      const name = typeQueryName(node);
      if (name && !shadows.has(name)) emit(node, name, name);
    } else {
      const reference = importTypeReference(node);
      if (reference) {
        emit(node, reference.written, reference.name, reference.module);
      }
    }

    for (const child of node.namedChildren) walk(child, shadows);
    for (const name of added) shadows.delete(name);
  };

  walk(root, new Set());
  return sites;
}

/* --------------------------------------------------------- declarations */

/** Peek through `declare` (and an `export` wrapper) to the declaration. */
function unwrapDeclaration(node: SyntaxNode): SyntaxNode {
  if (node.type !== "ambient_declaration") return node;
  return node.namedChildren[0] ?? node;
}

/** Module-level interfaces, type aliases, and enums, export status included. */
function topLevelDeclarations(
  root: SyntaxNode,
): {
  declaration: SyntaxNode;
  span: SyntaxNode;
  kind: ContractKind;
  exported: boolean;
}[] {
  const found: {
    declaration: SyntaxNode;
    span: SyntaxNode;
    kind: ContractKind;
    exported: boolean;
  }[] = [];
  for (const statement of root.namedChildren) {
    let declaration = statement;
    let exported = false;
    if (statement.type === "export_statement") {
      const declared = statement.childForFieldName("declaration");
      if (!declared) continue;
      declaration = declared;
      exported = true;
    }
    declaration = unwrapDeclaration(declaration);
    const kind = declaration.type === "interface_declaration" ? "interface"
      : declaration.type === "type_alias_declaration" ? "type"
      : declaration.type === "enum_declaration" ? "enum" : undefined;
    // The span keeps `export` / `declare`, so the reader sees the statement.
    if (kind) found.push({ declaration, span: statement, kind, exported });
  }
  return found;
}

/**
 * Contract node for one declaration: the whole source span, so a reader sees
 * every field (`errors` included) and the statement's modifiers, and no steps,
 * because a declaration is never called.
 */
function contractFromNode(
  file: string,
  declaration: SyntaxNode,
  span: SyntaxNode,
  kind: ContractKind,
  exported: boolean,
): FunctionInfo | null {
  const nameNode =
    declaration.childForFieldName("name") ??
    declaration.namedChildren.find(
      (c) => c.type === "type_identifier" || c.type === "identifier",
    );
  const name = nameNode?.text;
  if (!name) return null;
  const line = span.startPosition.row + 1;
  const endLine = span.endPosition.row + 1;
  const info: FunctionInfo = {
    review: { kind },
    key: name,
    label: `${kind} ${name}`,
    file,
    steps: [],
    exported,
    start: span.startIndex,
    end: span.endIndex,
    line,
  };
  if (endLine > line) info.endLine = endLine;
  return info;
}

/** The smallest-spanning definition whose source range contains an offset. */
function innermostOwner(
  owners: readonly FunctionInfo[],
  offset: number,
): FunctionInfo | null {
  let best: FunctionInfo | null = null;
  let bestSpan = Infinity;
  for (const owner of owners) {
    if (offset < owner.start || offset >= owner.end) continue;
    const span = owner.end - owner.start;
    if (span < bestSpan || (span === bestSpan && owner.start > (best?.start ?? -1))) {
      best = owner;
      bestSpan = span;
    }
  }
  return best;
}

/**
 * Record the type contracts of one file: append a non-callable definition per
 * interface / type alias / enum, then attach each written reference to the
 * innermost definition (callable or contract) whose span contains it. A
 * reference in module-level code that belongs to no definition is left out
 * rather than credited to a sibling.
 */
export function extractTypeContracts(
  file: string,
  tree: Tree,
  functions: FunctionInfo[],
): void {
  const root = tree.rootNode;
  const imports = fileImports(root);
  const sites = collectSites(root, imports);
  const contracts = topLevelDeclarations(root)
    .map(({ declaration, span, kind, exported }) =>
      contractFromNode(file, declaration, span, kind, exported),
    )
    .filter((info): info is FunctionInfo => info !== null);

  const owners = [...functions, ...contracts];
  const attributed = new Map<FunctionInfo, Map<string, TypeReference>>();
  for (const site of sites) {
    const owner = innermostOwner(owners, site.offset);
    if (!owner) continue;
    let entries = attributed.get(owner);
    if (!entries) attributed.set(owner, (entries = new Map()));
    const key = `${site.name}\0${site.module ?? ""}\0${site.imported ?? ""}\0${site.line}`;
    if (entries.has(key)) continue;
    const entry: TypeReference = { name: site.name };
    if (site.module !== undefined) entry.module = site.module;
    if (site.imported !== undefined) entry.imported = site.imported;
    entries.set(key, entry);
    SITE_INFO.set(entry, { line: site.line, written: site.written });
  }
  for (const [owner, entries] of attributed) {
    // Reuse the existing review object: a sibling helper's WeakMap keyed by it
    // (or its arrays) must keep working, and no field of theirs is displaced.
    const references = [...entries.values()];
    if (owner.review) owner.review.references = references;
    else owner.review = { references };
  }

  for (const contract of contracts) functions.push(contract);
}

/* ------------------------------------------------------------ resolution */

/** How a reference was tied to a snapshot declaration. */
type BindingBasis = "relative-import" | "module-path" | "same-file" | "unique";

/** One `owner -> target` type-contract relation for the context graph. */
export interface TypeContractEdge {
  owner: FunctionInfo;
  target: FunctionInfo;
  evidence: string;
  kind: "contract";
  /** 1-based line of the written reference, not of either definition. */
  line: number;
}

const BASIS_TEXT = {
  "relative-import": "relative import path",
  "module-path": "module path suffix",
  "same-file": "same-file declaration",
  unique: "unique snapshot declaration",
} satisfies Record<BindingBasis, string>;

/** Cross-platform join for git-style POSIX paths. */
function joinPath(directory: string, specifier: string): string {
  const parts: string[] = [];
  for (const part of `${directory}/${specifier}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts"];

const TS_EXTENSION = /\.(d\.ts|ts|tsx|mts|cts)$/;

/**
 * Candidate snapshot paths for `./x` / `../x`: the extension the specifier may
 * omit (or the `.js` ESM spelling), and the directory index.
 */
function relativeCandidates(ownerFile: string, specifier: string): string[] {
  const slash = ownerFile.lastIndexOf("/");
  const directory = slash === -1 ? "" : ownerFile.slice(0, slash);
  const base = joinPath(directory, specifier);
  if (/\.(ts|tsx|mts|cts)$/.test(base) || base.endsWith(".d.ts")) return [base];
  if (/\.(js|jsx|mjs|cjs)$/.test(base)) {
    const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
    return MODULE_EXTENSIONS.map((ext) => `${stem}${ext}`);
  }
  const candidates = MODULE_EXTENSIONS.map((ext) => `${base}${ext}`);
  for (const ext of MODULE_EXTENSIONS) candidates.push(`${base}/index${ext}`);
  return candidates;
}

/** Shortest path tail a bare or aliased specifier names, or null for a package. */
function moduleTail(specifier: string): string | null {
  const slash = specifier.indexOf("/");
  if (slash === -1) return null;
  const tail = specifier.slice(slash + 1).replace(/#.*$/, "");
  return tail === "" ? null : tail;
}

/** One snapshot declaration, plus how it was found. */
interface Binding {
  target: FunctionInfo;
  basis: BindingBasis;
}


/**
 * Resolve one reference against the snapshot. A relative specifier must name a
 * snapshot file (exact binding); a bare or aliased specifier binds only when
 * exactly one snapshot file's path ends with its tail; a name written without a
 * module binds to the file's own declaration. Only a name no module explains
 * may fall back to a globally unique declaration.
 */
export function resolveTypeContracts(
  functions: readonly FunctionInfo[],
): TypeContractEdge[] {
  const byName = new Map<string, FunctionInfo[]>();
  const byFile = new Map<string, Map<string, FunctionInfo[]>>();
  for (const info of functions) {
    if (!info.review?.kind) continue;
    const named = byName.get(info.key);
    if (named) named.push(info);
    else byName.set(info.key, [info]);
    let file = byFile.get(info.file);
    if (!file) byFile.set(info.file, (file = new Map()));
    const inFile = file.get(info.key);
    if (inFile) inFile.push(info);
    else file.set(info.key, [info]);
  }
  if (byName.size === 0) return [];
  const files = [...byFile.keys()];

  const resolve = (file: string, ref: TypeReference): Binding | null => {
    const name = ref.imported ?? ref.name;
    if (ref.module !== undefined) {
      if (ref.module.startsWith("./") || ref.module.startsWith("../")) {
        for (const candidate of relativeCandidates(file, ref.module)) {
          const target = byFile.get(candidate)?.get(name)?.[0];
          if (target) return { target, basis: "relative-import" };
        }
      } else {
        const tail = moduleTail(ref.module);
        if (tail) {
          const matches = new Set<FunctionInfo>();
          for (const snapshotFile of files) {
            const stem = snapshotFile.replace(TS_EXTENSION, "");
            if (
              stem !== tail &&
              !stem.endsWith(`/${tail}`) &&
              !stem.endsWith(`/${tail}/index`)
            ) {
              continue;
            }
            const target = byFile.get(snapshotFile)?.get(name)?.[0];
            if (target) matches.add(target);
          }
          if (matches.size === 1) {
            return { target: [...matches][0], basis: "module-path" };
          }
        }
      }
      return null;
    } else {
      const target = byFile.get(file)?.get(name)?.[0];
      if (target) return { target, basis: "same-file" };
    }
    // Only an unimported name may use a unique snapshot candidate.
    const unique = byName.get(name);
    if (unique?.length === 1) return { target: unique[0], basis: "unique" };
    return null;
  };

  const edges: TypeContractEdge[] = [];
  for (const owner of functions) {
    const references = owner.review?.references;
    if (!references) continue;
    for (const ref of references) {
      const binding = resolve(owner.file, ref);
      // A declaration naming itself adds nothing beside its own node.
      if (!binding || binding.target === owner) continue;
      const site = SITE_INFO.get(ref);
      const line = site?.line ?? owner.line ?? 1;
      const written = site?.written ?? ref.name;
      const origin = ref.module
        ? ref.imported
          ? ` (${ref.imported} as ${ref.name} from "${ref.module}")`
          : ` (from "${ref.module}")`
        : "";
      edges.push({
        owner,
        target: binding.target,
        kind: "contract",
        line,
        evidence:
          `syntactic type reference ${written}${origin} in ${owner.key}, ` +
          `not a call; bound to ${binding.target.review?.kind ?? "type"} ` +
          `${binding.target.key} by ${BASIS_TEXT[binding.basis]}`,
      });
    }
  }
  return edges;
}
