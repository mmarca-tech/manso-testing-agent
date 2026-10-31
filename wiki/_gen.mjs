// Regenerate the wiki diagram PNGs from their Mermaid sources.
//
// Source of truth: wiki/diagrams/<page>-<n>.mmd  →  renders to <page>-<n>.png,
// which the pages embed as <img>. The wiki itself needs no network/JS to show
// diagrams. Edit a .mmd and re-run:  node wiki/_gen.mjs
import fs from "node:fs";
import { execSync } from "node:child_process";

const dir = "wiki/diagrams";
const cfg = {
  theme: "base",
  themeVariables: {
    primaryColor: "#eef2ff", primaryTextColor: "#111827", primaryBorderColor: "#818cf8",
    lineColor: "#94a3b8", secondaryColor: "#e0f2fe", tertiaryColor: "#f8fafc",
    clusterBkg: "#f8fafc", clusterBorder: "#e2e8f0",
    fontFamily: "Segoe UI, Roboto, Helvetica, Arial, sans-serif", fontSize: "14px",
    edgeLabelBackground: "#ffffff",
  },
  flowchart: { curve: "basis", htmlLabels: true, padding: 14, nodeSpacing: 55, rankSpacing: 60 },
};
fs.writeFileSync(`${dir}/_cfg.json`, JSON.stringify(cfg));

const sources = fs.readdirSync(dir).filter((f) => f.endsWith(".mmd")).sort();
for (const src of sources) {
  const out = src.replace(/\.mmd$/, ".png");
  execSync(
    `npx -p @mermaid-js/mermaid-cli@11 mmdc -i ${dir}/${src} -o ${dir}/${out} -c ${dir}/_cfg.json -b white -s 2`,
    { stdio: "inherit" },
  );
}
fs.unlinkSync(`${dir}/_cfg.json`);
console.log(`rendered ${sources.length} diagrams`);
