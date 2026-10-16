import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildShowcase } from "./build-showcase.mjs";

test("static showcase includes its local links, without private or stale files", () => {
  const output = buildShowcase();
  fs.writeFileSync(path.join(output, "stale-private-file.txt"), "Never publish stale output.");
  fs.writeFileSync(path.join(output, "product-presentation.md"), "Removed private slides.");
  buildShowcase();
  const files = fs
    .readdirSync(output, { recursive: true })
    .filter((file) => fs.statSync(path.join(output, file)).isFile());
  assert.equal(files.length, 18);
  assert.equal(files.filter((file) => file.endsWith(".png")).length, 8);
  for (const excluded of [
    "stale-private-file.txt",
    ".env",
    "server.mjs",
    "README.md",
    "generation.json",
    "product-presentation.md",
  ]) {
    assert.ok(!files.some((file) => path.basename(file) === excluded), `${excluded} stays private`);
  }
  for (const file of files.filter((file) => /\.(html|js)$/.test(file))) {
    const source = fs.readFileSync(path.join(output, file), "utf8");
    const references = [
      ...source.matchAll(/(?:href|src)="(\.\/[^"#]+)"/g),
      ...source.matchAll(/from "(\.\/[^"#]+)"/g),
    ];
    for (const [, reference] of references) {
      assert.ok(
        fs.existsSync(path.resolve(output, path.dirname(file), reference)),
        `${file}: ${reference} must work below a GitHub Pages project path`,
      );
    }
  }
  assert.equal(
    path.dirname(output),
    fileURLToPath(new URL("../dist/", import.meta.url)).replace(/[\\/]$/, ""),
  );
});

test("static showcase rejects source directories redirected into private repository data", async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "showcase-build-"));
  t.after(() => {
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(fixture, "scripts"));
  fs.mkdirSync(path.join(fixture, "private"));
  fs.writeFileSync(path.join(fixture, "private", "index.html"), "Private fixture content.");
  fs.copyFileSync(
    new URL("./build-showcase.mjs", import.meta.url),
    path.join(fixture, "scripts", "build-showcase.mjs"),
  );
  try {
    fs.symlinkSync(
      path.join(fixture, "private"),
      path.join(fixture, "showcase"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error.code === "EPERM") return t.skip("Creating directory links is not permitted.");
    throw error;
  }
  const { buildShowcase: buildFixture } = await import(
    pathToFileURL(path.join(fixture, "scripts", "build-showcase.mjs"))
  );
  assert.throws(() => buildFixture(), /regular repository file: showcase\/index.html/);
  assert.ok(!fs.existsSync(path.join(fixture, "dist", "showcase", "index.html")));
});
