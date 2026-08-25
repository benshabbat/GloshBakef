/**
 * Pre-flight check: everything the manifest and the HTML pages point at must exist, and
 * every source file must parse. Cheap insurance against the failure mode where Chrome
 * silently refuses to load the extension because one path is stale.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

function requireFile(path, why) {
  if (!existsSync(join(root, path))) problems.push(`${why}: missing ${path}`);
}

/* ------------------------------------------------------------------- manifest */

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

requireFile(manifest.background.service_worker, "background");
requireFile(manifest.action.default_popup, "action.default_popup");
requireFile(manifest.options_page, "options_page");

for (const script of manifest.content_scripts ?? []) {
  for (const file of [...(script.js ?? []), ...(script.css ?? [])]) {
    requireFile(file, "content_scripts");
  }
}

for (const source of [manifest.icons, manifest.action.default_icon]) {
  for (const [size, path] of Object.entries(source ?? {})) requireFile(path, `icon ${size}`);
}

/* -------------------------------- paths referenced from code rather than the manifest */

const backgroundSource = readFileSync(join(root, manifest.background.service_worker), "utf8");
for (const [, path] of backgroundSource.matchAll(/"(src\/[\w./-]+\.(?:css|html))"/g)) {
  requireFile(path, "referenced by the service worker");
}

/* ----------------------------------------------------------------- html assets */

for (const page of [manifest.action.default_popup, manifest.options_page, "src/offscreen/offscreen.html"]) {
  requireFile(page, "html page");
  if (!existsSync(join(root, page))) continue;
  const html = readFileSync(join(root, page), "utf8");
  for (const [, asset] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    const target = resolve(join(root, dirname(page)), asset);
    if (!existsSync(target)) {
      problems.push(`${page}: references missing ${posix.normalize(relative(root, target).replace(/\\/g, "/"))}`);
    }
  }
}

/* ------------------------------------------------------------------- syntax */

function* walk(dir) {
  for (const entry of readdirSync(join(root, dir))) {
    const path = `${dir}/${entry}`;
    if (statSync(join(root, path)).isDirectory()) yield* walk(path);
    else if (/\.m?js$/.test(entry)) yield path;
  }
}

for (const file of [...walk("src"), ...walk("scripts")]) {
  try {
    await transform(readFileSync(join(root, file), "utf8"), { loader: "js", format: "esm" });
  } catch (error) {
    problems.push(`${file}: ${error.message.split("\n")[0]}`);
  }
}

/* ------------------------------------------------------------------- verdict */

if (problems.length) {
  console.error("check failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("check passed: manifest paths, page assets and syntax are all fine.");
