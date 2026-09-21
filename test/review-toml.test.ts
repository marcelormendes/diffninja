import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { removeTomlTable, upsertTomlTable } from "../src/review/toml.js";

const TARGET = ["mcp_servers", "diffninja"];
const LABEL = "config.toml";
const VALUES = {
  command: "node",
  args: ["/usr/lib/node_modules/diffninja/dist/review/mcp-cli.js"],
  env_vars: ["TYPESAFE_API_KEY"],
};
const BLOCK = [
  "[mcp_servers.diffninja]",
  'command = "node"',
  'args = ["/usr/lib/node_modules/diffninja/dist/review/mcp-cli.js"]',
  'env_vars = ["TYPESAFE_API_KEY"]',
  "",
].join("\n");

/** Value shapes the diffninja table holds in these documents. */
type ServerValue = string | string[];

/** The diffninja table as a TOML parser reads the document back. */
function serverOf(text: string): Record<string, ServerValue> | undefined {
  // SAFETY: every document in this suite registers diffninja as a table of strings and string arrays.
  const servers = parse(text).mcp_servers as Record<string, ServerValue> | undefined;
  return servers?.diffninja;
}

describe("upsertTomlTable", () => {
  it("writes the table into an empty document", () => {
    const edit = upsertTomlTable("", LABEL, TARGET, VALUES);
    expect(edit.changed).toBe(true);
    expect(edit.text).toBe(BLOCK);
  });

  it("appends after existing content, separated by one blank line", () => {
    const edit = upsertTomlTable('model = "gpt"\n', LABEL, TARGET, VALUES);
    expect(edit.text).toBe(`model = "gpt"\n\n${BLOCK}`);
  });

  it("terminates a document that does not end in a newline", () => {
    const edit = upsertTomlTable('model = "gpt"', LABEL, TARGET, VALUES);
    expect(edit.text).toBe(`model = "gpt"\n\n${BLOCK}`);
  });

  it("replaces the table and keeps every neighbor", () => {
    const before = [
      'model = "gpt"',
      "",
      "[mcp_servers.diffninja]",
      'command = "stale"',
      'args = ["stale"]',
      "",
      "[mcp_servers.diffninja.env]",
      'FAKE_KEY = "stale"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
      "[mcp_servers]",
      "request_timeout_ms = 5000",
      "",
    ].join("\n");
    const edit = upsertTomlTable(before, LABEL, TARGET, VALUES);
    expect(edit.changed).toBe(true);
    expect(edit.text).toContain('model = "gpt"');
    expect(edit.text).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(edit.text).toContain("[mcp_servers]\nrequest_timeout_ms = 5000");
    expect(edit.text).not.toContain("stale");
    expect(serverOf(edit.text)).toEqual(VALUES);
  });

  it("reports no change when the table already matches", () => {
    const before = `model = "gpt"\n\n${BLOCK}`;
    const edit = upsertTomlTable(before, LABEL, TARGET, VALUES);
    expect(edit.changed).toBe(false);
    expect(edit.text).toBe(before);
  });

  it("replaces a table whose name is quoted, without duplicating it", () => {
    const before = 'model = "gpt"\n\n[mcp_servers."diffninja"]\ncommand = "stale"\n';
    const edit = upsertTomlTable(before, LABEL, TARGET, VALUES);
    expect(edit.changed).toBe(true);
    expect(edit.text.match(/^\[mcp_servers/gm)).toHaveLength(1);
    expect(edit.text).not.toContain("stale");
    expect(serverOf(edit.text)).toEqual(VALUES);
  });

  it("replaces an indented table header", () => {
    const before = '  [mcp_servers.diffninja]\n  command = "stale"\n';
    const edit = upsertTomlTable(before, LABEL, TARGET, VALUES);
    expect(edit.changed).toBe(true);
    expect(edit.text).not.toContain("stale");
    expect(serverOf(edit.text)).toEqual(VALUES);
  });

  it("ignores header-like text in comments and multiline strings", () => {
    const before = [
      "# [mcp_servers.diffninja] is registered by hand",
      'note = """',
      "[mcp_servers.diffninja]",
      'command = "not a table"',
      '"""',
      "",
      "literal = '''",
      "[mcp_servers.diffninja]",
      "'''",
      "",
    ].join("\n");
    const edit = upsertTomlTable(before, LABEL, TARGET, VALUES);
    expect(edit.changed).toBe(true);
    expect(edit.text).toContain("# [mcp_servers.diffninja] is registered by hand");
    expect(edit.text).toContain('command = "not a table"');
    expect(edit.text).toContain("literal = '''\n[mcp_servers.diffninja]\n'''");
    expect(serverOf(edit.text)).toEqual(VALUES);
  });

  it("ignores a header-like line inside an array value", () => {
    const before = ['lines = [', '  "# [mcp_servers.diffninja]",', "]", 'model = "gpt"', ""].join("\n");
    const edit = upsertTomlTable(before, LABEL, TARGET, VALUES);
    expect(edit.text).toContain('model = "gpt"');
    expect(serverOf(edit.text)).toEqual(VALUES);
  });

  it("rewrites a table defined with an inline value", () => {
    const before = [
      "[mcp_servers]",
      'diffninja = { command = "stale" }',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
    ].join("\n");
    const edit = upsertTomlTable(before, LABEL, TARGET, VALUES);
    expect(edit.changed).toBe(true);
    expect(edit.text).not.toContain("stale");
    expect(edit.text).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(serverOf(edit.text)).toEqual(VALUES);
  });

  it("rewrites dotted keys into one inline table", () => {
    const before = 'mcp_servers.diffninja.command = "stale"\nmcp_servers.diffninja.args = []\n';
    const edit = upsertTomlTable(before, LABEL, TARGET, VALUES);
    expect(edit.changed).toBe(true);
    expect(edit.text).not.toContain("stale");
    expect(edit.text.split("\n")[0]).toBe(
      'mcp_servers.diffninja = { command = "node", args = ["/usr/lib/node_modules/diffninja/dist/review/mcp-cli.js"], env_vars = ["TYPESAFE_API_KEY"] }',
    );
    expect(serverOf(edit.text)).toEqual(VALUES);
  });

  it("refuses a table that lives inside another table's inline value", () => {
    const before = 'mcp_servers = { diffninja = { command = "stale" } }\n';
    expect(() => upsertTomlTable(before, LABEL, TARGET, VALUES)).toThrow(
      /Cannot rewrite config\.toml: mcp_servers\.diffninja is defined inside another table/,
    );
  });

  it("refuses to rewrite a subtree that is split across the file", () => {
    const before = [
      "[mcp_servers.diffninja]",
      'command = "stale"',
      "",
      "[other]",
      "y = 1",
      "",
      "[mcp_servers.diffninja.env]",
      'FAKE_KEY = "value"',
      "",
    ].join("\n");
    expect(() => upsertTomlTable(before, LABEL, TARGET, VALUES)).toThrow(
      /Cannot rewrite config\.toml: mcp_servers\.diffninja is split across the file/,
    );
  });

  it("reports malformed input instead of editing it", () => {
    expect(() => upsertTomlTable("[mcp_servers.diffninja]\ncommand =\n", LABEL, TARGET, VALUES)).toThrow(
      /^Cannot use config\.toml: not valid TOML/,
    );
    expect(() => upsertTomlTable("[a]\n[a]\n", LABEL, TARGET, VALUES)).toThrow(/trying to redefine/u);
    expect(() => upsertTomlTable('model = "unterminated\n', LABEL, TARGET, VALUES)).toThrow(
      /^Cannot use config\.toml: not valid TOML/,
    );
    expect(() => removeTomlTable('model = "unterminated\n', LABEL, TARGET)).toThrow(
      /^Cannot use config\.toml: not valid TOML/,
    );
  });

  it("escapes values that need it and parses them back unchanged", () => {
    const values = {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ['C:\\Users\\a "b"\\diffninja\\mcp-cli.js', "line\nbreak"],
    };
    const edit = upsertTomlTable("", LABEL, TARGET, values);
    expect(edit.text).toContain('"C:\\\\Program Files\\\\nodejs\\\\node.exe"');
    expect(serverOf(edit.text)).toEqual(values);
  });

  it("writes into a document holding values only smol-toml accepts", () => {
    const before = 'ratio = nan\nlast_updated = 2026-09-21 12:00:00Z\n';
    const edit = upsertTomlTable(before, LABEL, TARGET, VALUES);
    expect(edit.text).toBe(`${before}\n${BLOCK}`);
    expect(serverOf(edit.text)).toEqual(VALUES);
  });
});

describe("removeTomlTable", () => {
  it("removes the table, its nested tables, and its arrays of tables", () => {
    const before = [
      "[mcp_servers.other]",
      'command = "other"',
      "",
      "[mcp_servers.diffninja]",
      'command = "node"',
      "",
      "[mcp_servers.diffninja.env]",
      'FAKE_KEY = "value"',
      "",
      "[[mcp_servers.diffninja.env.extra]]",
      "n = 1",
      "",
      "[mcp_servers.last]",
      'command = "last"',
      "",
    ].join("\n");
    const edit = removeTomlTable(before, LABEL, TARGET);
    expect(edit.changed).toBe(true);
    expect(edit.text).not.toContain("diffninja");
    expect(edit.text).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(edit.text).toContain('[mcp_servers.last]\ncommand = "last"');
    expect(serverOf(edit.text)).toBeUndefined();
  });

  it("removes a quoted table and a dotted-key table", () => {
    const quoted = '[mcp_servers."diffninja"]\ncommand = "node"\n';
    expect(removeTomlTable(quoted, LABEL, TARGET).text).toBe("");
    const dotted = '[mcp_servers]\ndiffninja = { command = "node" }\n';
    const edit = removeTomlTable(dotted, LABEL, TARGET);
    expect(edit.changed).toBe(true);
    expect(edit.text).toBe("[mcp_servers]\n");
  });

  it("keeps a comment that only looks like the table", () => {
    const before = '# [mcp_servers.diffninja]\nmodel = "gpt"\n';
    const edit = removeTomlTable(before, LABEL, TARGET);
    expect(edit.changed).toBe(false);
    expect(edit.text).toBe(before);
  });

  it("reports no change when the table is absent", () => {
    const edit = removeTomlTable('model = "gpt"\n', LABEL, TARGET);
    expect(edit.changed).toBe(false);
    expect(edit.text).toBe('model = "gpt"\n');
  });

  it("spares a neighboring table that shares the prefix", () => {
    const before = '[mcp_servers.diffninja]\ncommand = "node"\n\n[mcp_servers.diffninja-tools]\ncommand = "tools"\n';
    const edit = removeTomlTable(before, LABEL, TARGET);
    expect(edit.text).toBe("[mcp_servers.diffninja-tools]\ncommand = \"tools\"\n");
  });

  it("removes descendants that unrelated tables sit between", () => {
    const before = [
      "[mcp_servers.diffninja]",
      'command = "node"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
      "[mcp_servers.diffninja.env]",
      'FAKE_KEY = "value"',
      "",
    ].join("\n");
    const edit = removeTomlTable(before, LABEL, TARGET);
    expect(edit.changed).toBe(true);
    expect(edit.text).toBe('[mcp_servers.other]\ncommand = "other"\n');
  });

  it("removes dotted keys that unrelated keys sit between", () => {
    const before = 'mcp_servers.diffninja.command = "old"\nmodel = "gpt"\nmcp_servers.diffninja.args = []\n';
    const edit = removeTomlTable(before, LABEL, TARGET);
    expect(edit.changed).toBe(true);
    expect(edit.text).toBe('model = "gpt"\n');
    const underHeader = '[mcp_servers]\ndiffninja.command = "old"\nother = "x"\ndiffninja.args = []\n';
    expect(removeTomlTable(underHeader, LABEL, TARGET).text).toBe('[mcp_servers]\nother = "x"\n');
  });

  it("removes an inline parent table's entry and keeps its siblings", () => {
    const before = 'mcp_servers = { diffninja = { command = "old" }, other = { command = "o" } }\n';
    const edit = removeTomlTable(before, LABEL, TARGET);
    expect(edit.changed).toBe(true);
    expect(edit.text).toBe('mcp_servers = { other = { command = "o" } }\n');
    const alone = 'mcp_servers = { diffninja = { command = "old" } }\n';
    expect(removeTomlTable(alone, LABEL, TARGET).text).toBe("mcp_servers = {}\n");
  });

  it("removes a dotted entry of an inline parent table", () => {
    const before = 'mcp_servers = { diffninja.command = "old", other = "o" }\n';
    const edit = removeTomlTable(before, LABEL, TARGET);
    expect(edit.text).toBe('mcp_servers = { other = "o" }\n');
  });

  it("removes an entry nested inside an inline parent table", () => {
    const before = 'mcp_servers = { diffninja = { env = { A = "b" } }, keep = { command = "o" } }\n';
    const edit = removeTomlTable(before, LABEL, [...TARGET, "env"]);
    expect(edit.changed).toBe(true);
    expect(edit.text).toBe('mcp_servers = { diffninja = {}, keep = { command = "o" } }\n');
  });

  it("leaves an inline table that belongs to another table alone", () => {
    const before = '[other]\nmcp_servers = { diffninja = { command = "old" } }\n';
    const edit = removeTomlTable(before, LABEL, TARGET);
    expect(edit.changed).toBe(false);
    expect(edit.text).toBe(before);
  });

  it("removes the table from a document holding values only smol-toml accepts", () => {
    const values = [
      "ratio = nan",
      "high = inf",
      "low = -inf",
      "day = 1979-05-27",
      "wake = 07:32:00",
      "opened = 1979-05-27 07:32:00",
      "shifted = 1979-05-27 00:32:00.999999-07:00",
      "last_updated = 2026-09-21 12:00:00Z # set by the tool",
    ];
    const before = [...values, "", "[mcp_servers.diffninja]", 'command = "node"', ""].join("\n");
    const edit = removeTomlTable(before, LABEL, TARGET);
    expect(edit.changed).toBe(true);
    expect(edit.text).toBe(`${values.join("\n")}\n`);
    // SAFETY: the document holds exactly the values written above.
    const parsed = parse(edit.text) as { high: number; low: number; ratio: number; last_updated: Date };
    expect(parsed.ratio).toBeNaN();
    expect(parsed.high).toBe(Infinity);
    expect(parsed.low).toBe(-Infinity);
    expect(parsed.last_updated).toBeInstanceOf(Date);
  });
});
