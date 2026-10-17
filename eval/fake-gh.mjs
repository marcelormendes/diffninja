#!/usr/bin/env node
// A stand-in for `gh` during an eval run. It answers only the read calls
// diffninja makes to load one pull request, from files the runner recorded
// beforehand, and reports the pull request as open so the PR-link review runs.
// Every other call, and every write, fails: an eval run cannot post anything.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = process.env.EVAL_GH_FIXTURE;
const args = process.argv.slice(2);

function refuse() {
  process.stderr.write(`gh (diffninja eval stand-in): refused: gh ${args.join(" ")}\nThis eval run has no GitHub access.\n`);
  process.exit(1);
}

function read(name) {
  return readFileSync(join(fixture, name), "utf8");
}

function hasArg(value) {
  return args.includes(value);
}

if (args[0] === "--version") {
  process.stdout.write("gh version 2.80.0 (diffninja-eval)\n");
  process.exit(0);
}
if (fixture === undefined || fixture === "") refuse();
// No write of any kind: no POST/PUT/PATCH/DELETE, no request body, no mutation.
const method = args.indexOf("-X") >= 0 ? args[args.indexOf("-X") + 1] : "GET";
if (method !== "GET" || hasArg("--input") || args.some(arg => arg.includes("mutation"))) refuse();

const meta = JSON.parse(read("pr.json"));
const prPath = `repos/${meta.repo}/pulls/${meta.number}`;
const last = args.at(-1);

if (args[0] === "pr" && args[1] === "view" && args[2] === meta.url) {
  process.stdout.write(read("view.json"));
} else if (args[0] === "api" && last === "user") {
  process.stdout.write(JSON.stringify({ login: "diffninja-eval", id: 1 }));
} else if (args[0] === "api" && last === prPath && hasArg("Accept: application/vnd.github.diff")) {
  process.stdout.write(read("pr.diff"));
} else if (args[0] === "api" && last === `${prPath}/files?per_page=100`) {
  process.stdout.write(read("files.json"));
} else if (args[0] === "api" && last === `${prPath}/reviews?per_page=100`) {
  process.stdout.write("[]");
} else if (args[0] === "api" && hasArg("graphql") && args.some(arg => arg.startsWith("query=") && arg.includes("viewerViewedState"))) {
  const nodes = JSON.parse(read("files.json")).map(file => ({ path: file.filename, viewerViewedState: "UNVIEWED" }));
  process.stdout.write(JSON.stringify({ data: { node: { files: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } }));
} else {
  refuse();
}
