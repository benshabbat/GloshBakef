import { build, context } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const dev = watch || process.argv.includes("--dev");

/**
 * nsfwjs imports the `@tensorflow/tfjs` meta-package, which drags in tfjs-data and the
 * node backends. Aliasing it to our slim re-export keeps the offscreen bundle at ~4.6 MB
 * instead of ~40 MB.
 */
const alias = { "@tensorflow/tfjs": join(root, "src/offscreen/tf.js") };

const shared = {
  bundle: true,
  format: "iife",
  target: "chrome116",
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  legalComments: "none",
  logLevel: "info",
  absWorkingDir: root
};

const targets = [
  { entryPoints: ["src/content/index.js"], outfile: "dist/content.js", ...shared },
  { entryPoints: ["src/offscreen/index.js"], outfile: "dist/offscreen.js", alias, ...shared }
];

if (watch) {
  const contexts = await Promise.all(targets.map(context));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("watching for changes…");
} else {
  await Promise.all(targets.map(build));
  for (const { outfile } of targets) {
    const kb = statSync(join(root, outfile)).size / 1024;
    console.log(`${outfile.padEnd(20)} ${kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(2)} MB`}`);
  }
}
