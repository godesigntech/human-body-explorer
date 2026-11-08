import bpy, json, sys, os
outdir = sys.argv[-1]
os.makedirs(outdir, exist_ok=True)
SYSTEMS = ["A_External_Body", "B_Skeletal_System", "C_Muscular_System", "D_Cardiovascular_System",
           "E_Respiratory_System", "F_Digestive_System", "G_Nervous_System", "H_Urinary_System",
           "I_Lymphatic_System", "J_Endocrine_System", "K_Reproductive_Optional", "L_Connective_Tissue_Ligaments"]

def all_objs(col):
    objs = list(col.objects)
    for ch in col.children:
        objs += all_objs(ch)
    return objs

def leaf_group(o):
    return o.users_collection[0].name if o.users_collection else ""

dg = bpy.context.evaluated_depsgraph_get()
vl = bpy.context.view_layer
# make sure all collections are included in view layer
def enable(lc):
    lc.exclude = False
    lc.hide_viewport = False
    for c in lc.children: enable(c)
enable(vl.layer_collection)
for c in bpy.data.collections: c.hide_viewport = False

# glTF can't export procedural colour ramps: bake their mid colour into the Base Color and unlink.
for m in bpy.data.materials:
    if not (m.use_nodes and m.node_tree):
        continue
    for nd in m.node_tree.nodes:
        if nd.type != 'BSDF_PRINCIPLED':
            continue
        bc = nd.inputs['Base Color']
        if bc.links:
            src = bc.links[0].from_node
            if src.type == 'VALTORGB':
                col = list(src.color_ramp.evaluate(0.5))
                bc.default_value = col
            m.node_tree.links.remove(bc.links[0])
            print("BAKED", m.name, [round(c, 2) for c in bc.default_value], flush=True)

manifest = {}
for sysname in SYSTEMS:
    col = bpy.data.collections[sysname]
    objs = [o for o in all_objs(col) if o.type == 'MESH' and not o.hide_render]
    bpy.ops.object.select_all(action='DESELECT')
    polys = 0
    for o in objs:
        o.hide_set(False); o.hide_viewport = False
        o.select_set(True)
        o["group"] = leaf_group(o)
        ev = o.evaluated_get(dg)
        try: polys += len(ev.data.polygons)
        except Exception: pass
    fn = sysname.split("_", 1)[0].lower() + ".glb"
    bpy.ops.export_scene.gltf(filepath=os.path.join(outdir, fn), export_format='GLB', use_selection=True,
        export_apply=True, export_extras=False, export_cameras=False, export_lights=False,
        export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
        export_draco_position_quantization=14, export_draco_normal_quantization=10,
        export_animations=False, export_skins=False, export_morph=False,
        export_yup=True, export_image_format='WEBP')
    manifest[sysname] = {"file": fn, "count": len(objs), "polys": polys,
                         "groups": sorted(set(leaf_group(o) for o in objs))}
    print("EXPORTED", sysname, len(objs), polys, flush=True)
json.dump(manifest, open(os.path.join(outdir, "_manifest.json"), "w"), indent=1)
