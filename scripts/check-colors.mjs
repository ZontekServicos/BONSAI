// Garante que a UI usa só a paleta semântica do @theme (src/index.css).
// Falha se encontrar cor fixa (hex, rgb/hsl, nome CSS), paleta padrão do
// Tailwind (red-500, neutral-400, white…) ou tokens legados (bonsai-*, --lime…).
//   pnpm lint:colors
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "src";
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(css|tsx?)$/.test(name) && !name.endsWith(".d.ts")) files.push(p);
  }
})(ROOT);

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const UTIL =
  "bg|text|border(?:-[trblxy])?|ring|ring-offset|outline|from|via|to|fill|stroke|shadow|decoration|placeholder|caret|accent|divide";
const RULES = [
  ["cor hex fixa", /#[0-9a-fA-F]{3,8}\b/g],
  ["rgb()/hsl() fixo", /\b(?:rgba?|hsla?)\(\s*\d/g],
  ["paleta padrão do Tailwind", new RegExp(`\\b(?:${UTIL})-(?:${PALETTE})-\\d{2,3}\\b`, "g")],
  ["white/black do Tailwind", new RegExp(`\\b(?:${UTIL})-(?:white|black)\\b`, "g")],
  [
    "token legado",
    /\bbonsai-(?:ink|coal|red|ember|paper)\b|var\(--(?:ink|muted|lime|line|paper)\)/g,
  ],
  ["cor nomeada CSS", /:\s*(?:white|black|red|gray|grey)\s*[;}]/g],
];

let problems = 0;
for (const file of files) {
  let text = readFileSync(file, "utf8");
  // O bloco @theme é a ÚNICA fonte de valores de cor: mascara mantendo as linhas.
  text = text.replace(/@theme\s*\{[\s\S]*?\n\}/, (m) => m.replace(/[^\n]/g, " "));
  text.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) return; // comentários
    for (const [label, re] of RULES) {
      for (const m of line.matchAll(re)) {
        problems++;
        console.error(`${relative(".", file)}:${i + 1}  ${label}: ${m[0]}`);
      }
    }
  });
}
if (problems) {
  console.error(
    `\n✗ ${problems} cor(es) fora da paleta. Use tokens: bg-surface, text-text-main, var(--color-primary)…`,
  );
  process.exit(1);
}
console.log(`✓ ${files.length} arquivos verificados: só tokens do @theme.`);
