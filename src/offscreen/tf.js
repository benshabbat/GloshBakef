/**
 * Slim stand-in for the `@tensorflow/tfjs` meta-package.
 *
 * The build aliases `@tensorflow/tfjs` (which nsfwjs imports) to this file so the bundle
 * only carries what the MobileNetV2 classifier actually needs. Dropping tfjs-data and the
 * node-only backends takes the bundle from ~40 MB to ~4.6 MB.
 *
 * tfjs-layers is required: the nsfwjs MobileNetV2 definition has no `type: "graph"`, so
 * `NSFWJS.load()` goes through `tf.loadLayersModel`.
 */
export * from "@tensorflow/tfjs-core";
export * from "@tensorflow/tfjs-converter";
export * from "@tensorflow/tfjs-layers";

import "@tensorflow/tfjs-backend-cpu";
import "@tensorflow/tfjs-backend-webgl";
