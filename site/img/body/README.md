# Body figures

`M_*.webp` and `F_*.webp` are shaded renders of the realistic male and female bodies from the
[Blender Studio Human Base Meshes](https://www.blender.org/download/demo-files/) bundle (v1.4.1, CC0).
They are posed with a simple armature and rendered with a small numpy rasteriser. Eight views, so that every
kind of measurement has somewhere to be drawn:

| file | view |
| --- | --- |
| `*_stand` / `*_stand_back` | standing, from the front / the back |
| `*_stand_side` | standing, from the side (depths, front and back body lengths) |
| `*_reach` | standing from the side, arm stretched forward (reach from a wall) |
| `*_up` | standing from the side, arm overhead (vertical reach) |
| `*_sit` | seated from the side (sitting heights, head dimensions, lengths to the knee) |
| `*_situp` | seated, arm overhead (sitting vertical reach) |
| `*_sitleg` | seated with the leg stretched forward (buttock-heel, functional leg length) |

`site/js/bodydata.js` holds the landmarks, silhouettes and survey proportions measured on the same meshes, and
`site/js/bodymarks.js` turns them into the dimension lines, circumferences, arcs and skin-fold sites for each measure,
so the overlays in `site/js/mannequin.js` line up with the figures. Heights of body landmarks that are not visible on the
mesh (axilla, tenth rib, malleoli ...) come from the survey means themselves, as a fraction of stature or sitting height
(`scripts/body_sprites/survey_fractions.py`, from `aggregates/rollup.csv`).

To regenerate (work directory `/tmp/hm`, needs `pip install bpy numpy pillow`):

1. Download `https://download.blender.org/demo/asset-bundles/human-base-meshes/human-base-meshes-bundle-v1.4.1.zip` and unzip it into `/tmp/hm`; copy `scripts/body_sprites/*.py` there.
2. `python extract.py`, then `python rig.py -- stand sit reach up situp sitleg` (poses the meshes).
3. `python run_poses.py` (renders the front and seated sprites), `python make_sprites.py stand_side stand_back reach up situp sitleg` (the other views), `python calib.py` (silhouettes and landmarks).
4. Copy the front and seated sprites into `site/img/body`, then `python landmarks.py` and `python gen_js.py` (writes `site/js/bodydata.js` and copies every sprite).

`gridview.py` crops a sprite with a labelled grid in SVG units, which is how the head and foot landmarks in `landmarks.py` were read off the renders.
