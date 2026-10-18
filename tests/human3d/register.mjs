// Lets Node resolve the browser's import map: `import "three"` and `import "three/addons/..."` load the vendored files.
// Usage: node --import ./tests/human3d/register.mjs --test tests/human3d/
import { register } from "node:module";
register("./resolve-hooks.mjs", import.meta.url);
