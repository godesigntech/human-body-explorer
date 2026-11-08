import json, re, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src, encoding="utf-8"))
SYS = {"A": "external", "B": "skeletal", "C": "muscular", "D": "cardiovascular", "E": "respiratory", "F": "digestive",
       "G": "nervous", "H": "urinary", "I": "lymphatic", "J": "endocrine", "K": "reproductive", "L": "connective"}

def clean(t, name):
    t = (t or "").strip()
    if t.startswith("The phalanx (Ancient Greek"):
        return ("The phalanges are the small bones of the fingers and toes. Each finger and the four lesser toes have three "
                "(proximal, middle and distal); the thumb and big toe have two. They form hinge joints that let the digits bend and grip.")
    if "No description has been found" in t or t.lower() in ("inconstant",):
        return ""
    t = re.sub(r"https?://\S+", "", t)
    t = re.sub(r"\bFeneis\s+[\d.]+", "", t)
    t = re.sub(r"\(English:\s*\)", "", t)
    # strip ALL-CAPS heading prefix like "POPlITEAL FASCIA The ..."
    m = re.match(r"^([A-Z][A-Za-z\- ]{3,80}?)\s+(The|A|An|It|This)\s", t)
    if m and sum(c.isupper() for c in m.group(1)) > len(m.group(1).replace(" ", "")) * 0.6:
        t = t[len(m.group(1)):].strip()
    t = re.sub(r"taht", "that", t)
    t = re.sub(r"\(\s*[,;]\s*", "(", t)
    t = re.sub(r"\s*\(\s*\)", "", t)
    t = re.sub(r"\s+([,.;])", r"\1", t)
    t = re.sub(r"\(\s+", "(", t)
    t = re.sub(r"\s+\)", ")", t)
    t = re.sub(r"\s{2,}", " ", t).strip()
    return t

def fixname(n):
    n = re.sub(r"\s*\(//[^)]*\)?$", "", n.strip())
    n = {"Lat_Fis-ant-Horizont": "Lateral fissure (anterior horizontal ramus)",
         "Lat_Fis-ant-Vertical": "Lateral fissure (anterior ascending ramus)",
         "Lat_Fis-post": "Lateral fissure (posterior ramus)",
         "Sulcus interm_prim-Jensen": "Intermediate sulcus of Jensen"}.get(n, n)
    if n.startswith("(") and n.endswith(")"): n = n[1:-1]
    if n.count("(") > n.count(")"): n += ")"
    return n.replace("*", "").strip()

out = {}
for k, v in d.items():
    g = v["group"]
    out[k] = {"n": fixname(v["name"]), "s": {"left": "L", "right": "R"}.get(v["side"], ""),
              "y": SYS.get(g[:1], ""), "g": g, "d": clean(v["desc"], v["name"]), "e": v["explode"]}
json.dump(out, open(dst, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(len(out))
import collections
print(sorted(set(v["g"] for v in out.values())))
ex = [v["e"] for v in out.values()]
print("explode sample", ex[:5], max(abs(c) for e in ex for c in e))
