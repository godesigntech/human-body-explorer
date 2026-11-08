import bpy, json, sys
out = {}
for o in bpy.data.objects:
    if o.type == 'MESH' and not o.hide_render:
        g = lambda k, d="": o[k] if k in o.keys() else d
        ed = g("explode_dir", None)
        out[o.name] = {"name": g("anatomy_name", o.name), "side": g("anatomy_side"), "system": g("system_label"),
                       "group": o.users_collection[0].name if o.users_collection else "",
                       "desc": g("description"), "explode": [round(float(x), 3) for x in ed] if ed is not None else None}
json.dump(out, open(sys.argv[-1], "w"), indent=0, ensure_ascii=False)
