import type Parser from "tree-sitter";
import type { DeclaredParams, FunctionInfo, SourceLoc } from "../types.js";
import { parameterText, textOnlyParams } from "./call-syntax.js";

export type SyntaxNode = Parser.SyntaxNode;
export type Tree = Parser.Tree;

export interface LanguageExtractor {
  /** Stable id, e.g. "typescript" | "python" | "go" */
  id: string;
  /** File extensions including dot, lowercase */
  extensions: string[];
  /** npm package providing the tree-sitter grammar */
  grammarPackage: string;
  /** Named export on the grammar package, if any (e.g. "typescript", "tsx") */
  grammarExport?: string;
  extract(file: string, source: string, tree: Tree): FunctionInfo[];
}

export function namedChildren(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}

export function childByType(node: SyntaxNode, type: string): SyntaxNode | null {
  return namedChildren(node).find((c) => c.type === type) ?? null;
}

export function collapseWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Call-site / branch span for a syntax node.
 * Uses tree-sitter 0-based rows → 1-based display lines.
 */
export function locFromNode(file: string, node: SyntaxNode): SourceLoc {
  const line = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  return endLine > line ? { file, line, endLine } : { file, line };
}

/**
 * Parameter-list containers the grammars declare. A list is a direct child of
 * the definition node, or of its declarator (`int callee(int param);`).
 */
const PARAMETER_CONTAINERS = {
  formal_parameters: true,
  parameters: true,
  parameter_list: true,
  method_parameters: true,
  function_value_parameters: true,
  lambda_parameters: true,
  parameter_clause: true,
} satisfies Record<string, true>;

/** Nodes that hold a parameter list one level below the definition. */
const PARAMETER_DECLARATORS = {
  function_declarator: true,
  declarator: true,
  method_declarator: true,
  call_signature: true,
  function_declarator_body: true,
} satisfies Record<string, true>;

function namedChildrenTyped(node: SyntaxNode, types: Record<string, true>) {
  return namedChildren(node).filter((child) => types[child.type] === true);
}

/**
 * Declared parameter list of a definition, read from the AST: the verbatim
 * list text, with no slots. Text alone keeps argument binding `unknown`, which
 * is what the extractors that do not build lexical scopes can honestly claim.
 */
export function declaredParamsOf(node: SyntaxNode): DeclaredParams | undefined {
  const direct = namedChildrenTyped(node, PARAMETER_CONTAINERS)[0];
  if (direct) return textOnlyParams(parameterText(direct));
  for (const declarator of namedChildrenTyped(node, PARAMETER_DECLARATORS)) {
    const nested = namedChildrenTyped(declarator, PARAMETER_CONTAINERS)[0];
    if (nested) return textOnlyParams(parameterText(nested));
  }
  return undefined;
}
