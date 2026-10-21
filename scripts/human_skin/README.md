# Realistic skin assets

Builds `site/assets/human/skin-M.*` and `skin-F.*`, read by `site/js/human/realskin.js` (the "Realistic" skin of the Digital human tab).

Source: Blender Studio **Human Base Meshes** bundle v1.4.1 (CC0), bodies `GEO-body_male_realistic` and `GEO-body_female_realistic`
with their eyeballs, at multires level 1 (42,342 vertices each). Unpack the bundle anywhere under `/tmp/hm` (or set `HSKIN_BUNDLE`).

```
node --import ./tests/human3d/register.mjs scripts/human_skin/template.mjs /tmp/hm/skin   # template bodies (US Army P50 man, woman)
python3 scripts/human_skin/rig_mesh.py                                                    # needs the bpy module: rig, neutral pose
python3 scripts/human_skin/pack.py                                                        # writes site/assets/human/
node --import ./tests/human3d/register.mjs --test tests/human3d/realskin.test.mjs
```

Re-run all three steps after changing `skeleton.js` joints, the fit of the template bodies, or the region rules in `realskin.js`.
