import * as tf from "./tf.js";
import { load } from "nsfwjs/core";
import { MobileNetV2Model } from "nsfwjs/models/mobilenet_v2";
import { MSG } from "../shared/messages.js";

const MODEL_INPUT = 224;
const MAX_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;

let modelPromise;

async function getModel() {
  modelPromise ||= (async () => {
    // setBackend resolves to false rather than rejecting when a backend is unavailable.
    const webgl = await tf.setBackend("webgl").catch(() => false);
    if (!webgl) await tf.setBackend("cpu");
    await tf.ready();
    return load("MobileNetV2", { modelDefinitions: [MobileNetV2Model] });
  })();
  return modelPromise;
}

async function toBitmap(url, dataUrl) {
  const source = dataUrl || url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Extension pages hold the host permissions, so this is not subject to page CORS —
    // which is what made reading the <img> straight off the page fail in v1.
    const response = await fetch(source, {
      signal: controller.signal,
      credentials: "omit",
      cache: "force-cache"
    });
    if (!response.ok) return null;
    // Refuse on the declared length before the body is pulled into memory: the URL comes
    // from page markup, so "an image" can turn out to be a multi-gigabyte download. The
    // blob check below still covers responses that declare no length at all.
    if (Number(response.headers.get("content-length")) > MAX_BYTES) return null;
    const blob = await response.blob();
    if (blob.size === 0 || blob.size > MAX_BYTES) return null;
    if (blob.type && !blob.type.startsWith("image/")) return null;
    return await createImageBitmap(blob, {
      resizeWidth: MODEL_INPUT,
      resizeHeight: MODEL_INPUT,
      resizeQuality: "medium"
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns `{ classes }` on success and `{ classes: null, error }` otherwise. The reason
 * matters: every caller fails open on a null, so without it a model that never loads is
 * indistinguishable from a page full of harmless pictures. Only the self-test surfaces
 * `error` — the scoring path still cares about nothing but `classes`.
 */
async function classify(url, dataUrl) {
  const bitmap = await toBitmap(url, dataUrl);
  if (!bitmap) {
    return { classes: null, error: "התמונה לא נקראה — ההורדה או הפענוח נכשלו" };
  }
  try {
    const model = await getModel();
    const predictions = await model.classify(bitmap);
    return { classes: Object.fromEntries(predictions.map((p) => [p.className, p.probability])) };
  } catch (error) {
    return { classes: null, error: `המודל נכשל: ${error?.message ?? error}` };
  } finally {
    bitmap.close();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen" || message.type !== MSG.SCORE_OFFSCREEN) return false;
  classify(message.url, message.dataUrl).then(sendResponse, (error) =>
    sendResponse({ classes: null, error: `שגיאה לא צפויה: ${error?.message ?? error}` })
  );
  return true;
});
