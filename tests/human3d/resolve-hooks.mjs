import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const VENDOR = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../site/vendor/three") + path.sep);

export async function resolve(specifier, context, next) {
  if (specifier === "three") return next(new URL("three.module.min.js", VENDOR).href, context);
  if (specifier.startsWith("three/addons/")) return next(new URL("addons/" + specifier.slice("three/addons/".length), VENDOR).href, context);
  return next(specifier, context);
}
