/**
 * layout-fence.test.ts — the architectural invariant behind src/'s domain tree: a
 * file imports only from the layers below it, lib/ is the leaf, ui/, tools/ and
 * extension/ are inward-facing, and the import graph is acyclic and fully reachable
 * from the entry.
 *
 * Until now the rule was written in README.md and "enforced" by a script that lives
 * outside this repo, in the plan notebook — so CI could not run it, and nothing here
 * failed when the tree drifted. This file is that rule as a fence test, in the same
 * shape as neverthrow-fence.test.ts: the table is stated once, and a change that
 * breaks it fails here instead of being noticed in review.
 *
 * Extending it: a new top-level directory under src/ is a structural change — add it
 * to LAYERS in the same commit, with the layers it may import. A new file inside an
 * existing layer needs no edit.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Which layers each layer may import. The tree's spine, stated once. */
const LAYERS: Record<string, string[]> = {
  index: ["lib", "config", "model", "agent", "schedule", "workflow", "ui", "extension", "tools"],
  // The composition root: the entry, what it calls to register everything, and the file that
  // builds the shared handles. `app` is as unconstrained as the entry; `bootstrap` is
  // deliberately narrower — it builds the handles, so it reaches into ui/ and stops there.
  app: ["lib", "config", "model", "agent", "schedule", "workflow", "ui", "extension", "tools", "bootstrap"],
  bootstrap: ["lib", "config", "model", "agent", "schedule", "workflow", "ui"],
  lib: [],
  config: ["lib"],
  model: ["lib"],
  agent: ["lib", "config", "model"],
  schedule: ["lib", "config", "model", "agent"],
  workflow: ["lib", "config", "model", "agent"],
  ui: ["lib", "config", "model", "agent", "schedule", "workflow"],
  extension: ["lib", "config", "model", "agent", "schedule", "workflow", "ui"],
  tools: ["lib", "config", "model", "agent", "schedule", "workflow", "ui"],
};

/**
 * The wiring layer: the entrypoint, the activation context it drives, and the tool
 * definitions. These are the only places allowed to reach into ui/, because holding
 * the live widget/fleet/manager handles and rendering tool results is their whole job.
 * Stated separately from LAYERS so that widening LAYERS cannot quietly make ui/,
 * tools/ or extension/ outward-facing.
 */
const WIRING = ["index", "app", "bootstrap", "extension", "tools"];

/** The composition roots: the only modules allowed to import the inward-facing layers. */
const REGISTRARS = ["index", "app"];

const SRC = resolve(process.cwd(), "src");
const ENTRY = "index";

type Edge = { from: string; to: string; line: number };

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

const FILES = walk(SRC);

/** The module id: its path under src/, without the extension. */
function idOf(file: string): string {
  return relative(SRC, file).replace(/\.ts$/, "");
}

/** The layer a module belongs to: its first path segment, or index for the entry. */
function layerOf(id: string): string {
  return id === ENTRY ? ENTRY : id.split("/")[0];
}

const SPECIFIER = /(?:from\s+|import\(\s*)["'](\.[^"']+)["']/g;

/**
 * Specifiers that name no file under src/. They contribute no edge, so a fence that
 * ignored them would silently lose the very import it exists to judge — asserted
 * empty rather than skipped.
 */
const UNRESOLVED: string[] = [];

/** Resolve a relative specifier to the .ts file it names, or undefined. */
function targetOf(file: string, specifier: string): string | undefined {
  const base = resolve(dirname(file), specifier);
  for (const candidate of [base.replace(/\.js$/, ".ts"), base, base + ".ts"]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** Every relative import in one file, each with the line it sits on. */
function importsOf(file: string): Edge[] {
  const source = readFileSync(file, "utf-8");
  const from = idOf(file);
  const edges: Edge[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const target = targetOf(file, match[1]);
    const line = source.slice(0, match.index ?? 0).split("\n").length;
    if (!target) {
      UNRESOLVED.push("src/" + from + ".ts:" + line + " imports " + match[1] + ", which names no file under src/");
      continue;
    }
    edges.push({ from, to: idOf(target), line });
  }
  return edges;
}

const EDGES = FILES.flatMap(importsOf);

const ADJACENCY = new Map<string, string[]>();
for (const edge of EDGES) {
  ADJACENCY.set(edge.from, [...(ADJACENCY.get(edge.from) ?? []), edge.to]);
}

/** src/agent/manager.ts:12 — the prefix every violation message carries. */
const at = (edge: Edge): string => "src/" + edge.from + ".ts:" + edge.line;
const edgeText = (edge: Edge): string => at(edge) + " imports src/" + edge.to + ".ts";

describe("layout fence — the domain tree's import rules", () => {
  it("resolves every relative specifier it judges", () => {
    expect(UNRESOLVED).toEqual([]);
  });

  it("declares a layer for every source file", () => {
    const undeclared = FILES.map(idOf)
      .filter(id => LAYERS[layerOf(id)] === undefined)
      .map(id => "src/" + id + ".ts is in no declared layer");
    expect(undeclared).toEqual([]);
  });

  it("imports only downward, and never into an inward-facing layer", () => {
    const violations: string[] = [];
    for (const edge of EDGES) {
      const from = layerOf(edge.from);
      const to = layerOf(edge.to);
      if (from === to || from === ENTRY) continue;
      if (!(LAYERS[from] ?? []).includes(to)) {
        violations.push(
          edgeText(edge) + " — " + from + "/ may import only " + (LAYERS[from]?.join(", ") || "nothing"),
        );
      }
      if (to === "ui" && !WIRING.includes(from)) {
        violations.push(edgeText(edge) + " — ui/ is inward-facing; only " + WIRING.join(", ") + " may import it");
      }
      if (to === "extension" && !REGISTRARS.includes(from)) {
        violations.push(edgeText(edge) + " — only " + REGISTRARS.join(", ") + " may import extension/");
      }
      if (to === "tools" && !REGISTRARS.includes(from)) {
        violations.push(edgeText(edge) + " — only " + REGISTRARS.join(", ") + " may import tools/");
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps lib/ a leaf", () => {
    const violations = EDGES
      .filter(edge => layerOf(edge.from) === "lib" && layerOf(edge.to) !== "lib")
      .map(edge => edgeText(edge) + " — lib/ imports nothing from another layer");
    expect(violations).toEqual([]);
  });

  it("has no import cycles", () => {
    const state = new Map<string, 0 | 1 | 2>();
    const cycles = new Set<string>();
    const visit = (node: string, path: string[]): void => {
      const seen = state.get(node);
      if (seen === 1) {
        cycles.add([...path.slice(path.indexOf(node)), node].map(id => "src/" + id + ".ts").join(" -> "));
        return;
      }
      if (seen === 2) return;
      state.set(node, 1);
      for (const next of ADJACENCY.get(node) ?? []) visit(next, [...path, node]);
      state.set(node, 2);
    };
    for (const node of ADJACENCY.keys()) visit(node, []);
    expect([...cycles]).toEqual([]);
  });

  it("reaches every module from the entry", () => {
    const seen = new Set<string>([ENTRY]);
    const queue = [ENTRY];
    while (queue.length > 0) {
      const node = queue.shift() as string;
      for (const next of ADJACENCY.get(node) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    const unreachable = FILES.map(idOf)
      .filter(id => !seen.has(id))
      .map(id => "src/" + id + ".ts is not reachable from src/index.ts");
    expect(unreachable).toEqual([]);
  });
});
