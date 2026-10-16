import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist", "showcase");
const showcaseFiles = [
  "index.html",
  "styles.css",
  "persona.css",
  "app.js",
  "demo-data.js",
  "chat-demo.js",
  "persona-demo.js",
  "workspace-demo.js",
  "favicon.svg",
  "assets/personas/arnold.png",
  "assets/personas/batman.png",
  "assets/personas/dwight.png",
  "assets/personas/gandalf.png",
  "assets/personas/sherlock.png",
  "assets/personas/sparrow.png",
  "assets/personas/stark.png",
  "assets/personas/yoda.png",
];

export function buildShowcase() {
  const canonicalRoot = fs.realpathSync(root);
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.realpathSync(parent) !== path.join(canonicalRoot, "dist")) {
    throw new Error("Showcase output must stay inside this repository's dist directory.");
  }
  fs.rmSync(output, { recursive: true, force: true });
  const files = [
    ...showcaseFiles.map((file) => [`showcase/${file}`, file]),
    ["LICENSE", "LICENSE"],
  ];
  for (const [source, destination] of files) {
    const sourcePath = path.join(root, source);
    if (
      !fs.lstatSync(sourcePath).isFile() ||
      fs.realpathSync(sourcePath) !== path.join(canonicalRoot, source)
    ) {
      throw new Error(`Showcase source must be a regular repository file: ${source}`);
    }
    const target = path.join(output, destination);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(sourcePath, target);
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildShowcase();
  console.log("Built static showcase in dist/showcase (18 public files).");
}
