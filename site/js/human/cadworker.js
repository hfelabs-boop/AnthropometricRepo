// Web Worker of cadimport.js: converts STEP, IGES and BREP files with OpenCascade (vendor/occt, occt-import-js 0.0.23, LGPL-2.1) to triangle meshes in
// metres. A classic worker (importScripts), loaded only when such a file is imported. Message in: { id, format: "step" | "iges" | "brep", buffer }.
// Message out: { id, ok, result | error }; the position, normal and index arrays are sent as typed arrays (transferred, not copied).
/* global occtimportjs, importScripts */
importScripts(new URL("../../vendor/occt/occt-import-js.js", self.location.href).href);
let occt = null;
self.onmessage = async (ev) => {
  const { id, format, buffer } = ev.data;
  try {
    occt ??= occtimportjs({ locateFile: (p) => new URL(`../../vendor/occt/${p}`, self.location.href).href });
    const lib = await occt;
    const fn = format === "iges" ? "ReadIgesFile" : format === "brep" ? "ReadBrepFile" : "ReadStepFile";
    const res = lib[fn](new Uint8Array(buffer), { linearUnit: "meter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.001, angularDeflection: 0.5 });
    const transfer = [];
    for (const m of res.meshes ?? []) {
      for (const a of [m.attributes.position, m.attributes.normal, m.index]) {
        if (a?.array) { a.array = (a === m.index ? Uint32Array : Float32Array).from(a.array); transfer.push(a.array.buffer); }
      }
    }
    self.postMessage({ id, ok: !!res.success, result: res, error: res.success ? null : "the file could not be read" }, transfer);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
};
