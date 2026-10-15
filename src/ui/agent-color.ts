/**
 * agent-color.ts — agent name badges (JW-166): an agent file's `color` becomes the badge
 * background, with black or white text, whichever clears 4.5:1 contrast. Accepted: quoted
 * six-digit hex and Claude Code's eight names. Anything else renders no badge.
 */

const NAMED: Readonly<Record<string, string>> = {
  red: "#DC2626",
  blue: "#6A9BCC",
  green: "#16A34A",
  yellow: "#CA8A04",
  purple: "#827DBD",
  orange: "#D97757",
  pink: "#C46686",
  cyan: "#0891B2",
};

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Normalised `#RRGGBB`, or undefined for an unknown value. */
export function resolveAgentColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase().replace(/^["']|["']$/g, "");
  const hex = NAMED[v] ?? v;
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toUpperCase() : undefined;
}

const parse = (hex: string): Rgb => ({
  r: Number.parseInt(hex.slice(1, 3), 16),
  g: Number.parseInt(hex.slice(3, 5), 16),
  b: Number.parseInt(hex.slice(5, 7), 16),
});

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Black or white text for a background, whichever contrasts more (black wins ties). */
export function badgeTextColor(hex: string): "black" | "white" {
  const l = luminance(parse(hex));
  return contrast(l, 0) >= contrast(l, 1) ? "black" : "white";
}

/**
 * Paint `text` in the agent's colour as a truecolor FOREGROUND — the conversation viewer's
 * frame. `hex` is one `resolveAgentColor` already accepted; the reset is the foreground-only
 * one, so an enclosing background survives it.
 */
export function agentFrame(text: string, hex: string): string {
  const { r, g, b } = parse(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/** ` name ` on the agent colour (truecolor SGR), or undefined when the colour is invalid. */
export function agentBadge(name: string, color: string | undefined, bold = false): string | undefined {
  const hex = resolveAgentColor(color);
  if (hex === undefined) return undefined;
  const { r, g, b } = parse(hex);
  const fg = badgeTextColor(hex) === "black" ? "30" : "97";
  const weight = bold ? "1;" : "";
  return `\x1b[${weight}48;2;${r};${g};${b};${fg}m ${name} \x1b[0m`;
}
