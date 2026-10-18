// TEST FIXTURE: stand-in for fit.js (see rig.js here). Fits nothing: returns the synthetic body of the profile's stature and form (so it works with
// the real rig.js as well as with the stub rig). Profile id "fail-fit" throws, to test the fallback.
import { syntheticBody } from "/js/human/synthetic.js";

export function fitBody(profile, { form } = {}) {
  if (profile?.id === "fail-fit") throw new Error("test failure");
  const mm = profile?.measures?.stature?.value;
  return syntheticBody(Number.isFinite(mm) ? mm / 1000 : 1.75, form ?? "male");
}
