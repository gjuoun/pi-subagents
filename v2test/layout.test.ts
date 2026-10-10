/**
 * layout.test.ts — the v2src layer fence.
 *
 * v2src is organised in four layers plus the composition root. This test walks every
 * v2src .ts file, resolves each static import/export-from to its layer, and fails on any
 * edge the Layer rules forbid. There are no exceptions.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const V2SRC = resolve(__dirname, "..", "v2src");

type Target =
  | { readonly kind: "effect" }
  | { readonly kind: "node" }
  | { readonly kind: "pi-tui" }
  | { readonly kind: "pi-coding-agent" }
  | { readonly kind: "external"; readonly spec: string }
  | { readonly kind: "layer"; readonly layer: string; readonly path: string };

/** All .ts files under v2src, relative to v2src, sorted. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(relative(root, full).split("\\").join("/"));
    }
  };
  walk(root);
  return out;
}

/** The layer folder a file sits in, or undefined when it is not in any layer. */
function layerOf(rel: string): string | undefined {
  const first = rel.split("/")[0];
  if (rel.includes("/") && ["domain", "services", "pi", "ui"].includes(first)) return first;
  if (rel === "index.ts" || rel === "layers.ts") return "root";
  return undefined;
}

function classifyTarget(fromRel: string, spec: string): Target {
  if (spec.startsWith(".")) {
    const resolved = relative(V2SRC, resolve(V2SRC, dirname(fromRel), spec))
      .split("\\")
      .join("/")
      .replace(/\.js$/, ".ts");
    return { kind: "layer", layer: layerOf(resolved) ?? "root", path: resolved };
  }
  if (spec === "effect" || spec.startsWith("effect/")) return { kind: "effect" };
  if (spec.startsWith("node:")) return { kind: "node" };
  if (spec === "@earendil-works/pi-tui") return { kind: "pi-tui" };
  if (spec === "@earendil-works/pi-coding-agent") return { kind: "pi-coding-agent" };
  return { kind: "external", spec };
}

function targetDisplay(target: Target): string {
  return target.kind === "layer" ? target.path : target.kind === "external" ? target.spec : packageName(target);
}

function packageName(target: Target): string {
  switch (target.kind) {
    case "effect":
      return "effect";
    case "node":
      return "node:*";
    case "pi-tui":
      return "@earendil-works/pi-tui";
    case "pi-coding-agent":
      return "@earendil-works/pi-coding-agent";
    default:
      return targetDisplay(target);
  }
}

const STATEMENT = /(?:^|\n)[ \t]*(import|export)[ \t]+(type[ \t]+)?([\s\S]*?)\bfrom[ \t]*["']([^"']+)["']/g;
const SIDE_EFFECT = /(?:^|\n)[ \t]*import[ \t]*["']([^"']+)["']/g;

interface Edge {
  readonly from: string;
  readonly target: Target;
  readonly isType: boolean;
}

function parseImports(fromRel: string, text: string): Edge[] {
  const edges: Edge[] = [];
  for (const match of text.matchAll(STATEMENT)) {
    if (match[1] === "import" && match[2] === undefined && /^["']/.test(match[3].trim())) continue;
    edges.push({ from: fromRel, target: classifyTarget(fromRel, match[4]), isType: match[2] !== undefined });
  }
  for (const match of text.matchAll(SIDE_EFFECT)) {
    edges.push({ from: fromRel, target: classifyTarget(fromRel, match[1]), isType: false });
  }
  return edges;
}

function ruleAllows(layer: string, target: Target, isType: boolean): boolean {
  switch (layer) {
    case "root":
      return true;
    case "domain":
      return target.kind === "effect" || (target.kind === "layer" && target.layer === "domain");
    case "services":
      if (target.kind === "effect" || target.kind === "node") return true;
      if (target.kind === "layer") return target.layer === "domain" || target.layer === "services";
      // @earendil-works/* only via import type.
      return (
        isType &&
        (target.kind === "pi-coding-agent" || target.kind === "pi-tui" || target.kind === "external")
      );
    case "pi":
      return !(target.kind === "layer" && target.layer === "ui");
    case "ui":
      if (target.kind === "effect" || target.kind === "pi-tui") return true;
      if (target.kind === "layer") return target.layer === "domain" || target.layer === "services";
      return isType && target.kind === "pi-coding-agent";
    default:
      return false;
  }
}

function collectViolations(): string[] {
  const violations: string[] = [];
  for (const rel of listFiles(V2SRC)) {
    const layer = layerOf(rel);
    if (layer === undefined) {
      violations.push(`${rel} -> (outside a layer)`);
      continue;
    }
    const text = readFileSync(join(V2SRC, rel), "utf8");
    for (const edge of parseImports(rel, text)) {
      if (!ruleAllows(layer, edge.target, edge.isType)) {
        violations.push(`${edge.from} -> ${targetDisplay(edge.target)}`);
      }
    }
  }
  return violations.sort();
}

const violations = collectViolations();
describe("v2 layer fence", () => {
  it("has no import violations", () => {
    expect(violations).toEqual([]);
  });
});
