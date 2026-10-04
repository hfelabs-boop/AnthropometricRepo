# Body figures

`M_*.webp` and `F_*.webp` are shaded renders of the realistic male and female bodies from the
[Blender Studio Human Base Meshes](https://www.blender.org/download/demo-files/) bundle (v1.4.1, CC0).
They are posed with a simple armature (arms down; seated for the side view) and rendered with a small numpy rasteriser.
`site/js/bodydata.js` holds the landmarks and silhouettes measured on the same meshes, so the measurement overlays in
`site/js/mannequin.js` line up with the figures.

To regenerate (work directory `/tmp/hm`, needs `pip install bpy numpy pillow`):

1. Download `https://download.blender.org/demo/asset-bundles/human-base-meshes/human-base-meshes-bundle-v1.4.1.zip` and unzip it into `/tmp/hm`.
2. Run, in order: `extract.py`, `rig.py`, `run_poses.py`, `calib.py`, `gen_js.py` (all in `scripts/body_sprites/`).
