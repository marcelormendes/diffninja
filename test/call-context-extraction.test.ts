import { describe, expect, test } from "vitest";
import { buildCallSitesFromInfo, buildCallTree } from "../src/calltree.js";
import { buildIndex, extractFunctions } from "../src/extract.js";
import { CALL_REASONS, MAX_ARGUMENT_CHARS } from "../src/types.js";

function sites(source: string, file = "caller.ts", owner = "caller") {
  const index = buildIndex(extractFunctions(file, source));
  const definition = index.get(owner);
  if (!definition) throw new Error("Missing caller definition in fixture");
  return buildCallSitesFromInfo(definition, index);
}

function context(source: string, file = "caller.ts") {
  const result = sites(source, file)[0]?.context;
  if (!result) throw new Error("Missing call context in fixture");
  return result;
}

describe("argument source fidelity", () => {
  test("pairs simple, nested and whitespace-sensitive expressions with declared parameters", () => {
    const source = [
      'function caller(arg) { callee("arg  arg", `arg ${arg}`, { arg: [1, 2] }, arg + 1); }',
      "function callee(param1, param2, param3, param4) {}",
    ].join("\n");
    const result = context(source);
    expect(result).toMatchObject({ target: "lexical", mapping: "positional", completeness: "complete" });
    expect(result.arguments?.map(arg => [arg.position, arg.expression, arg.parameter])).toEqual([
      [1, '"arg  arg"', "param1"], [2, "`arg ${arg}`", "param2"],
      [3, "{ arg: [1, 2] }", "param3"], [4, "arg + 1", "param4"],
    ]);
  });

  test("keeps both nested call sites without replacing the outer argument expression", () => {
    const result = sites([
      "function caller(arg) { callee1(callee2(arg)); }",
      "function callee1(param) {}",
      "function callee2(param) { return param; }",
    ].join("\n"));
    expect(result.map(node => node.key)).toEqual(["callee1", "callee2"]);
    expect(result[0].context?.arguments?.[0]).toMatchObject({ expression: "callee2(arg)", parameter: "param" });
    expect(result[1].context?.arguments?.[0]).toMatchObject({ expression: "arg", parameter: "param" });
    expect(result[0].context?.omittedInlineChildren).toBeUndefined();
  });

  test("keeps an argument at 120 characters and explicitly marks a longer prefix", () => {
    const exact = `"${"a".repeat(MAX_ARGUMENT_CHARS - 2)}"`;
    const longer = `"${"a".repeat(MAX_ARGUMENT_CHARS)}"`;
    const result = context(`function caller() { callee(${exact}, ${longer}); }\nfunction callee(param1, param2) {}`);
    expect(result.arguments?.[0]).toEqual({ position: 1, expression: exact, parameter: "param1" });
    expect(result.arguments?.[1]).toEqual({
      position: 2, expression: longer.slice(0, 120), parameter: "param2", truncated: true, originalLength: longer.length,
    });
    expect(result.completeness).toBe("partial");
    expect(result.reasons).toContain(CALL_REASONS.expressionTruncated);
  });

  test("counts omitted written arguments, not unfilled declared parameters", () => {
    const result = context("function caller() { callee(1,2,3,4,5,6,7,8,9,10); }\nfunction callee(...param) {}");
    expect(result.arguments?.map(arg => arg.position)).toEqual([1,2,3,4,5,6,7,8]);
    expect(result.omittedArguments).toBe(2);
    expect(result.reasons).toContain(CALL_REASONS.argumentsTruncated);
    expect(result.completeness).toBe("partial");
    const empty = context("function caller() { callee(); }\nfunction callee(param1, param2) {}");
    expect(empty.arguments).toEqual([]);
    expect(empty.omittedArguments).toBeUndefined();
  });

  test("comments do not become arguments or shift parameter positions", () => {
    const empty = context("function caller() { callee(/* arg */); }\nfunction callee(param) {}", "caller.js");
    expect(empty.arguments).toEqual([]);
    const bound = context("function caller(arg) { callee(/* arg */ arg); }\nfunction callee(/* param */ param) {}", "caller.js");
    expect(bound.arguments).toEqual([{ position: 1, expression: "arg", parameter: "param" }]);
  });

  test("unreadable argument syntax stays unavailable rather than known empty", () => {
    const result = context("function caller() { new Caller; }\nclass Caller {}");
    expect(result.arguments).toBeUndefined();
    expect(result.completeness).toBe("unavailable");
    expect(result.reasons).toContain(CALL_REASONS.argumentsUnavailable);
  });

  test("default declarations and written types do not erase parameter names", () => {
    const js = context("function caller(arg) { callee(arg); }\nfunction callee(param = 1) {}", "caller.js");
    expect(js.arguments?.[0]?.parameter).toBe("param");
    expect(js.parameters).toBe("(param = 1)");
    const ts = context('function caller(arg: number) { callee(arg, "arg"); }\nfunction callee(param1: number, ...param2: string[]) {}');
    expect(ts.parameters).toBe("(param1: number, ...param2: string[])");
    expect(ts.arguments?.map(arg => arg.parameter)).toEqual(["param1", "param2"]);
  });

  test("a spread preserves only the positional bindings known before it", () => {
    const result = context("function caller(arg) { callee(1, ...arg, arg); }\nfunction callee(param1, param2, param3) {}");
    expect(result.mapping).toBe("partial");
    expect(result.arguments?.map(arg => arg.parameter)).toEqual(["param1", undefined, undefined]);
    expect(result.reasons).toContain(CALL_REASONS.spreadArgument);
  });

  test("destructured parameters keep their declaration without inventing a name", () => {
    const result = context("function caller(arg) { callee(arg); }\nfunction callee({ param1, param2 }) {}");
    expect(result.parameters).toBe("({ param1, param2 })");
    expect(result.arguments?.[0]?.parameter).toBeUndefined();
    expect(result.mapping).toBe("partial");
  });
});

describe("Python syntactic binding", () => {
  test("keywords bind by name rather than their written order", () => {
    const result = context("def caller(arg):\n    callee(param2=arg, param1=1)\ndef callee(param1, param2=2):\n    return param1", "caller.py");
    expect(result.mapping).toBe("named");
    expect(result.arguments?.map(arg => [arg.expression, arg.parameter])).toEqual([["param2=arg", "param2"], ["param1=1", "param1"]]);
    expect(result.completeness).toBe("complete");
  });

  test("the positional-only separator does not make following slots keyword-only", () => {
    const result = context("def caller(arg):\n    callee(arg, arg)\ndef callee(param1, /, param2):\n    return param1", "caller.py");
    expect(result.arguments?.map(arg => arg.parameter)).toEqual(["param1", "param2"]);
    expect(result.mapping).toBe("positional");
    const keyword = context("def caller(arg):\n    callee(param1=arg)\ndef callee(param1, /):\n    return param1", "caller.py");
    expect(keyword.arguments?.[0]?.parameter).toBeUndefined();
    expect(keyword.mapping).toBe("partial");
  });

  test("keyword-only parameters cannot consume positional arguments", () => {
    const result = context("def caller(arg):\n    callee(arg, arg)\ndef callee(param1, *, param2):\n    return param1", "caller.py");
    expect(result.arguments?.map(arg => arg.parameter)).toEqual(["param1", undefined]);
    expect(result.mapping).toBe("partial");
  });

  test("unpacking does not pretend all unknown keywords belong to keyword-rest", () => {
    const result = context("def caller(arg):\n    callee(arg, *arg, **arg)\ndef callee(param1, param2=1, **param3):\n    return param1", "caller.py");
    expect(result.arguments?.map(arg => arg.parameter)).toEqual(["param1", undefined, undefined]);
    expect(result.mapping).toBe("partial");
    expect(result.reasons).toContain(CALL_REASONS.spreadArgument);
  });

  test("a free function's first parameter is not skipped because it is named self", () => {
    const result = context("def caller(arg):\n    callee(arg)\ndef callee(self, param):\n    return param", "caller.py");
    expect(result.arguments?.[0]?.parameter).toBe("self");
  });

  test("duplicate bindings are partial, not a complete successful mapping", () => {
    const result = context("def caller(arg):\n    callee(arg, param=arg)\ndef callee(param):\n    return param", "caller.py");
    expect(result.mapping).toBe("partial");
    expect(result.reasons).toContain(CALL_REASONS.duplicateBinding);
  });

  test("decorators do not prove the original callable or signature is retained", () => {
    const result = context("def caller(arg):\n    callee(arg)\n@arg\ndef callee(param):\n    return param", "caller.py");
    expect(result.target).toBe("candidate");
    expect(result.mapping).toBe("unknown");
  });
});

describe("conservative target association", () => {
  test.each([
    "function caller(callee) { callee(1); }",
    "function caller({callee}) { callee(1); }",
    "function caller(arg) { const {callee} = arg; callee(1); }",
    "function caller(arg) { callee = arg; callee(1); }",
    "function caller(arg) { if (arg) { function callee(param2) {} } callee(1); }",
  ])("shadowing and reassignment do not borrow a global declaration: %s", caller => {
    const result = context(`${caller}\nfunction callee(param) {}`);
    expect(result.target).toBe("candidate");
    expect(result.mapping).toBe("unknown");
    expect(result.arguments?.[0]?.parameter).toBeUndefined();
  });

  test("duplicate same-file declarations never become an arbitrary lexical target", () => {
    const result = context("function caller(arg) { callee(arg); }\nfunction callee(param1) {}\nfunction callee(param2) {}");
    expect(result.target).toBe("candidate");
    expect(result.mapping).toBe("unknown");
  });

  test("conditional and nested writes do not establish one callable signature", () => {
    const js = context("function callee(param) {}\nif (arg) { callee = arg; }\nfunction caller(arg) { callee(arg); }");
    expect(js.target).toBe("candidate");
    expect(js.mapping).toBe("unknown");
    const py = context("def callee(param):\n    return param\nif arg:\n    callee = arg\ndef caller(arg):\n    callee(arg)", "caller.py");
    expect(py.target).toBe("candidate");
    expect(py.mapping).toBe("unknown");
  });

  test("imports do not upgrade the engine's global-name heuristic to lexical resolution", () => {
    const index = buildIndex([
      ...extractFunctions("caller.ts", 'import { callee } from "./callee";\nexport function caller(arg) { callee(arg); }'),
      ...extractFunctions("callee.ts", "export function callee(param) {}"),
    ]);
    const result = buildCallSitesFromInfo(index.get("caller")!, index)[0].context!;
    expect(result.target).toBe("candidate");
    expect(result.mapping).toBe("unknown");
    expect(result.parameters).toBe("(param)");
    expect(result.arguments?.[0]?.parameter).toBeUndefined();
  });

  test("dynamic targets retain their argument expressions with unknown mappings", () => {
    const result = context("function caller(arg) { arg[0](arg); }");
    expect(result).toMatchObject({ callee: "arg[0]", target: "unresolved", mapping: "unknown", completeness: "partial" });
    expect(result.arguments).toEqual([{ position: 1, expression: "arg" }]);
  });

  test("receiver dispatch remains a candidate instead of assuming this selects one method", () => {
    const result = sites("class Caller { callee(param) {} caller(arg) { this.callee(arg); } }", "caller.ts", "Caller.caller")[0].context!;
    expect(result.target).toBe("candidate");
    expect(result.mapping).toBe("unknown");
    expect(result.arguments?.[0]?.parameter).toBeUndefined();
  });

  test("Python methods do not infer bound receivers from parameter spelling", () => {
    const result = sites("class Caller:\n    def callee(self, param):\n        return param\n    def caller(self, arg):\n        self.callee(arg)", "caller.py", "Caller.caller")[0].context!;
    expect(result.target).toBe("candidate");
    expect(result.mapping).toBe("unknown");
  });
});

describe("expansion limits", () => {
  test("counts omitted bodies at depth cuts while keeping the distinct call sites", () => {
    const index = buildIndex(extractFunctions("caller.ts", [
      "function caller() { callee(); callee(); }",
      "function callee() { callee1(); callee2(); }",
      "function callee1() {}",
      "function callee2() {}",
    ].join("\n")));
    const cut = buildCallTree("caller", index, 1);
    expect(cut.children.map(node => node.context?.omittedChildren)).toEqual([2, 2]);
    const expanded = buildCallTree("caller", index, 4);
    expect(expanded.children[0].context?.omittedChildren).toBeUndefined();
    expect(expanded.children[0].children.map(node => node.key)).toEqual(["callee1", "callee2"]);
  });

  test("recursion retains the call site and marks the expansion it cannot repeat", () => {
    const index = buildIndex(extractFunctions("caller.ts", "function caller() { caller(); }"));
    const result = buildCallTree("caller", index, 4).children[0];
    expect(result.key).toBe("caller");
    expect(result.context?.arguments).toEqual([]);
    expect(result.context?.omittedChildren).toBe(1);
  });
});
