# Body Explorer: interactive 3D human anatomy

A static website for exploring the human body in 3D. Click any of the 3,031 parts (bones, muscles, organs, vessels, nerves, ligaments) to see its name, side, body system, **what it does**, and a description.

## Run it locally

The site has to be served over http, because browsers block loading models from `file://`:

```bash
python -m http.server 8080 --directory E:/humanbody
```

Then open http://localhost:8080.

## Publish it

The folder is a plain static site with no build step. Upload the whole folder to any static host (Netlify, Vercel, GitHub Pages, Cloudflare Pages, or your own server). The total size is about 15 MB. Each body system loads only when someone turns it on.

## Features

- **12 body systems**: turn each one on or off, **Ghost** it to see through it, or expand it to hide individual regions.
- **Click to learn**: shows the name, left/right/midline, a plain-language *What it does*, a fuller description, and nearby parts.
- **Search** across every part. Picking a result loads its system, ghosts the layers covering it (skin, muscle, bone) and zooms to it.
- **Isolate / Hide / Zoom to** for the selected part, plus **Explode**, preset views and **Spin**.
- **Quiz mode**: asks you to find a named part among the systems you have turned on, and keeps score.
- **Shareable links**: `index.html#Bone_Femur_Left` opens with that part selected.
- Keyboard: `Esc` deselect · `F` focus · `H` hide · `I` isolate.

## Files

| Path | What it is |
|---|---|
| `index.html`, `css/style.css` | Page and styling (light and dark mode, works on phones) |
| `js/app.js` | Three.js viewer: loading, picking, panels, search, quiz |
| `js/info.js` | Learning content: system and group overviews, plus the *What it does* rules |
| `data/parts.json` | Name, side, system, group, description and explode direction for each part (generated) |
| `models/a.glb` … `l.glb` | One Draco-compressed GLB per body system (generated) |
| `tools/` | Blender and Python scripts that regenerate `models/` and `data/` |

## Regenerating from the Blender file

```bash
"C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b human_anatomy.blend --python tools/export_glb.py -- E:/humanbody/models
"C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b human_anatomy.blend --python tools/extract_parts.py -- parts_raw.json
python tools/build_parts.py parts_raw.json data/parts.json
```

`export_glb.py` bakes the procedural colour ramps into plain colours, because glTF cannot store them.

## Credits and licence

The 3D model and descriptions come from **Z-Anatomy** (CC BY-SA 4.0), which is derived from **BodyParts3D** (CC BY-SA 2.1 JP). The descriptions are adapted from Wikipedia (CC BY-SA). If you publish this site, keep the credit line in the sidebar and share your changes to the model under the same licence.
