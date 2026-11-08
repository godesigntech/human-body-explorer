import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { computeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
import { SYSTEMS, GROUPS, describeFunction } from "./info.js";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = (id) => document.getElementById(id);
const SYS = Object.fromEntries(SYSTEMS.map((s) => [s.id, s]));
const sanitize = (n) => n.replace(/\s/g, "_").replace(/[\[\]\.:\/]/g, "");

/* ---------------- State ---------------- */
let PARTS = {};                 // id -> {n,s,y,g,d,e}
const nameKey = {};             // sanitized node name -> id
const roots = new Map();        // id -> Object3D
const sysState = {};            // id -> {loaded, loading, visible, ghost, group}
const hiddenGroups = new Set();
const hiddenParts = new Set();
let isolated = null;            // Set of ids, or null
let selected = null;            // part id
let hovered = null;
let hintIds = new Set();
let explodeAmt = 0;
let mode = "explore";
let modelSize = 1.8;

/* ---------------- Renderer & scene ---------------- */
const canvas = $("viewer");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(2, 4, 3); scene.add(key);
const rim = new THREE.DirectionalLight(0xcfe6ff, 0.8); rim.position.set(-3, 2, -3); scene.add(rim);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f72, 0.6));

const camera = new THREE.PerspectiveCamera(35, 1, 0.005, 100);
camera.position.set(0, 1, 5);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
controls.minDistance = 0.05;
controls.maxDistance = 12;
controls.autoRotateSpeed = 1.2;
const world = new THREE.Group();
scene.add(world);

let needsRender = true;
const invalidate = () => (needsRender = true);
controls.addEventListener("change", invalidate);

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
  invalidate();
}
new ResizeObserver(resize).observe(canvas.parentElement);

/* Camera tween */
let tween = null;
function flyTo(target, position, ms = 700) {
  tween = { t0: performance.now(), ms: Math.max(1, ms), fromT: controls.target.clone(), toT: target.clone(), fromP: camera.position.clone(), toP: position.clone() };
}
function stepTween(now) {
  if (!tween) return;
  let k = Math.min(1, (now - tween.t0) / tween.ms);
  k = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  controls.target.lerpVectors(tween.fromT, tween.toT, k);
  camera.position.lerpVectors(tween.fromP, tween.toP, k);
  if (k >= 1) tween = null;
  invalidate();
}

function loop(now) {
  stepTween(now);
  if (controls.update()) invalidate();
  if (needsRender) { renderer.render(scene, camera); needsRender = false; }
  requestAnimationFrame(loop);
}

/* ---------------- Materials ---------------- */
const matCache = new Map();
function variant(base, kind) {
  const k = base.uuid + kind;
  if (matCache.has(k)) return matCache.get(k);
  const m = base.clone();
  if (kind === "ghost") {
    m.transparent = true; m.opacity = 0.1; m.depthWrite = false;
  } else if (kind === "sel") {
    m.emissive = new THREE.Color(0x14b8a6); m.emissiveIntensity = 0.55; m.transparent = false; m.opacity = 1; m.depthWrite = true;
  } else if (kind === "hover") {
    m.emissive = new THREE.Color(0xffffff); m.emissiveIntensity = 0.18;
  }
  matCache.set(k, m);
  return m;
}
function paint(id) {
  const root = roots.get(id);
  if (!root) return;
  const p = PARTS[id];
  const ghost = sysState[p.y]?.ghost;
  const kind = id === selected || hintIds.has(id) ? "sel" : id === hovered ? "hover" : ghost ? "ghost" : null;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.material = kind ? variant(o.userData.baseMat, kind) : o.userData.baseMat;
    o.renderOrder = kind === "ghost" ? 1 : 0;
  });
  invalidate();
}

/* ---------------- Visibility ---------------- */
function isVisible(id) {
  const p = PARTS[id];
  const s = sysState[p.y];
  if (!s || !s.visible) return false;
  if (hiddenGroups.has(p.g) || hiddenParts.has(id)) return false;
  if (isolated && !isolated.has(id)) return false;
  return true;
}
function isPickable(id) {
  return isVisible(id) && !sysState[PARTS[id].y].ghost;
}
function refreshVisibility() {
  for (const [id, root] of roots) root.visible = isVisible(id);
  pickList = null;
  invalidate();
}
let pickList = null;
function pickables() {
  if (pickList) return pickList;
  pickList = [];
  for (const [id, root] of roots) if (isPickable(id)) root.traverse((o) => o.isMesh && pickList.push(o));
  return pickList;
}

/* ---------------- Loading ---------------- */
const draco = new DRACOLoader().setDecoderPath("https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/");
const loader = new GLTFLoader().setDRACOLoader(draco);
const bvhQueue = [];
function pumpBVH() {
  const t = performance.now();
  while (bvhQueue.length && performance.now() - t < 12) {
    const g = bvhQueue.shift();
    if (!g.boundsTree) g.computeBoundsTree();
  }
  if (bvhQueue.length) setTimeout(pumpBVH, 0);
}

const v3 = new THREE.Vector3();
function loadSystem(sysId, onProgress) {
  const st = sysState[sysId];
  if (st.loaded) return Promise.resolve();
  if (st.loading) return st.loading;
  renderSidebarRow(sysId);
  st.loading = new Promise((resolve, reject) => {
    loader.load(`models/${SYS[sysId].file}`, (gltf) => {
      const g = gltf.scene;
      g.updateMatrixWorld(true);
      g.traverse((o) => {
        const id = nameKey[o.name];
        if (!id || roots.has(id)) return;
        roots.set(id, o);
        o.userData.partId = id;
        o.userData.basePos = o.position.clone();
        const e = PARTS[id].e;
        // explode direction comes from Blender (Z-up) -> three.js (Y-up)
        o.userData.explodeDir = e ? new THREE.Vector3(e[0], e[2], -e[1]) : new THREE.Vector3();
        o.traverse((m) => {
          if (!m.isMesh) return;
          m.userData.partId = id;
          const mat = m.material;
          if (mat.transparent && mat.opacity < 0.05) mat.opacity = 0.35;
          mat.side = THREE.FrontSide;
          m.userData.baseMat = mat;
          bvhQueue.push(m.geometry);
        });
      });
      st.group = g;
      world.add(g);
      st.loaded = true;
      st.loading = null;
      applyExplode();
      refreshVisibility();
      for (const [id] of roots) if (PARTS[id].y === sysId) paint(id);
      pumpBVH();
      renderSidebarRow(sysId);
      resolve();
    }, onProgress, (err) => { st.loading = null; renderSidebarRow(sysId); reject(err); });
  });
  return st.loading;
}

function applyExplode() {
  const k = explodeAmt * modelSize * 0.35;
  for (const root of roots.values()) {
    root.position.copy(root.userData.basePos).addScaledVector(root.userData.explodeDir, k);
  }
  invalidate();
}

/* ---------------- View helpers ---------------- */
function boxOf(objects) {
  const box = new THREE.Box3();
  for (const o of objects) if (o.visible !== false) box.expandByObject(o);
  return box;
}
function fitAll(dir = new THREE.Vector3(0, 0.05, 1), ms = 700) {
  const vis = [...roots.entries()].filter(([id]) => isVisible(id)).map(([, r]) => r);
  const box = boxOf(vis.length ? vis : [world]);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const r = Math.max(size.y, size.x * 1.2, size.z) * 0.5;
  const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.12;
  flyTo(c, c.clone().addScaledVector(dir.clone().normalize(), dist), ms);
}
function focusPart(id) {
  const root = roots.get(id);
  if (!root) return;
  const box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3()).length();
  const dir = camera.position.clone().sub(controls.target).normalize();
  const dist = Math.max(s * 1.8, 0.12);
  flyTo(c, c.clone().addScaledVector(dir, dist));
}

/* ---------------- Picking ---------------- */
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const ndc = new THREE.Vector2();
function pickAt(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(pickables(), false);
  return hits.length ? hits[0].object.userData.partId : null;
}

const tooltip = $("tooltip");
let downXY = null, hoverRaf = 0, lastMove = null;
canvas.addEventListener("pointerdown", (e) => { downXY = [e.clientX, e.clientY]; tween = null; stopSpin(); });
canvas.addEventListener("pointermove", (e) => {
  if (e.pointerType !== "mouse") return;
  lastMove = e;
  if (e.buttons) { setHover(null); return; }
  if (!hoverRaf) hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    const id = pickAt(lastMove.clientX, lastMove.clientY);
    setHover(id);
    if (id) {
      tooltip.hidden = false;
      tooltip.textContent = mode === "quiz" ? "?" : label(id);
      tooltip.style.left = lastMove.clientX + "px";
      tooltip.style.top = lastMove.clientY + "px";
    } else tooltip.hidden = true;
  });
});
canvas.addEventListener("pointerleave", () => { setHover(null); tooltip.hidden = true; });
canvas.addEventListener("pointerup", (e) => {
  if (!downXY) return;
  const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]);
  downXY = null;
  if (moved > 6) return;
  const id = pickAt(e.clientX, e.clientY);
  if (mode === "quiz") return quizAnswer(id);
  if (id) select(id); else select(null);
});
function setHover(id) {
  if (id === hovered) return;
  const prev = hovered;
  hovered = id;
  if (prev) paint(prev);
  if (id) paint(id);
  canvas.style.cursor = id ? "pointer" : "";
}

/* ---------------- Selection & info panel ---------------- */
const sideText = { L: "Left side of the body", R: "Right side of the body", "": "Single midline structure" };
function label(id) {
  const p = PARTS[id];
  return p.n + (p.s ? ` (${p.s === "L" ? "left" : "right"})` : "");
}
function select(id, { focus = false } = {}) {
  const prev = selected;
  selected = id;
  if (prev) paint(prev);
  if (!id) {
    $("info").hidden = true;
    document.body.classList.remove("info-open");
    history.replaceState(null, "", location.pathname + location.search);
    return;
  }
  paint(id);
  const p = PARTS[id];
  $("infoSystem").textContent = SYS[p.y].label;
  $("infoSystem").style.background = SYS[p.y].color + "33";
  $("infoGroup").textContent = GROUPS[p.g]?.[0] || p.g;
  $("infoName").textContent = p.n;
  $("infoSide").textContent = sideText[p.s];
  $("infoFunction").textContent = describeFunction(p.n, p.g, p.y);
  $("infoDesc").textContent = p.d;
  $("infoDescWrap").hidden = !p.d;
  $("btnIsolate").textContent = isolated ? "Show all" : "Isolate";
  renderRelated(id);
  $("info").hidden = false;
  $("info").scrollTop = 0;
  document.body.classList.add("info-open");
  history.replaceState(null, "", "#" + encodeURIComponent(id));
  if (focus) focusPart(id);
}

const centers = new Map();
function centerOf(id) {
  if (!centers.has(id)) centers.set(id, new THREE.Box3().setFromObject(roots.get(id)).getCenter(new THREE.Vector3()));
  return centers.get(id);
}
function renderRelated(id) {
  const p = PARTS[id];
  const c = centerOf(id);
  const seen = new Set([p.n]);
  const list = [];
  for (const [oid] of roots) {
    const q = PARTS[oid];
    if (q.g !== p.g || oid === id) continue;
    if (p.s && q.s && q.s !== p.s) continue;
    list.push([centerOf(oid).distanceToSquared(c), oid]);
  }
  list.sort((a, b) => a[0] - b[0]);
  const ul = $("related");
  ul.innerHTML = "";
  for (const [, oid] of list) {
    if (seen.has(PARTS[oid].n)) continue;
    seen.add(PARTS[oid].n);
    const li = document.createElement("li");
    li.textContent = PARTS[oid].n;
    li.onclick = () => goTo(oid);
    ul.appendChild(li);
    if (seen.size > 10) break;
  }
  $("relatedWrap").hidden = !ul.children.length;
}

// Outer layers get ghosted when jumping to something deeper inside the body.
const LAYER = { external: 0, muscular: 1, connective: 2, skeletal: 3 };
async function goTo(id, { reveal = false } = {}) {
  const p = PARTS[id];
  const st = sysState[p.y];
  if (reveal) {
    const depth = LAYER[p.y] ?? 4;
    for (const s of SYSTEMS) {
      const o = sysState[s.id];
      if (s.id !== p.y && o.visible && !o.ghost && (LAYER[s.id] ?? 4) < depth) {
        o.ghost = true;
        for (const [oid] of roots) if (PARTS[oid].y === s.id) paint(oid);
        renderSidebarRow(s.id);
      }
    }
    pickList = null;
  }
  if (!st.visible) { st.visible = true; }
  if (st.ghost) { st.ghost = false; for (const [oid] of roots) if (PARTS[oid].y === p.y) paint(oid); }
  hiddenGroups.delete(p.g);
  hiddenParts.delete(id);
  if (isolated && !isolated.has(id)) isolated = null;
  renderSidebarRow(p.y);
  await loadSystem(p.y);
  refreshVisibility();
  select(id, { focus: true });
}

$("btnCloseInfo").onclick = () => select(null);
$("btnFocus").onclick = () => selected && focusPart(selected);
$("btnHide").onclick = () => {
  if (!selected) return;
  hiddenParts.add(selected);
  if (isolated) isolated.delete(selected);
  select(null);
  refreshVisibility();
};
$("btnIsolate").onclick = () => {
  if (isolated) { isolated = null; refreshVisibility(); fitAll(camera.position.clone().sub(controls.target)); }
  else if (selected) {
    // keep both sides of a paired structure
    const n = PARTS[selected].n;
    isolated = new Set([...roots.keys()].filter((id) => PARTS[id].n === n));
    refreshVisibility();
    focusPart(selected);
  }
  $("btnIsolate").textContent = isolated ? "Show all" : "Isolate";
};
$("btnShowAll").onclick = () => {
  hiddenParts.clear(); isolated = null; hiddenGroups.clear();
  refreshVisibility(); renderSidebar();
  if (selected) $("btnIsolate").textContent = "Isolate";
};

/* ---------------- Toolbar ---------------- */
const VIEWS = { front: [0, 0.05, 1], back: [0, 0.05, -1], left: [1, 0.05, 0], right: [-1, 0.05, 0] };
document.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => fitAll(new THREE.Vector3(...VIEWS[b.dataset.view]))));
$("btnReset").onclick = () => fitAll();
$("explode").oninput = (e) => { explodeAmt = +e.target.value; applyExplode(); centers.clear(); };
function stopSpin() { controls.autoRotate = false; $("btnRotate").classList.remove("on"); }
$("btnRotate").onclick = () => { controls.autoRotate = !controls.autoRotate; $("btnRotate").classList.toggle("on", controls.autoRotate); };

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "Escape") select(null);
  else if ((e.key === "h" || e.key === "H") && selected) $("btnHide").click();
  else if ((e.key === "i" || e.key === "I") && selected) $("btnIsolate").click();
  else if (e.key === "f" || e.key === "F") selected ? focusPart(selected) : fitAll();
});

/* ---------------- Sidebar ---------------- */
const groupsBySys = {};
const countByGroup = {};
const caret = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
function renderSidebar() {
  const ul = $("systemList");
  ul.innerHTML = "";
  for (const s of SYSTEMS) {
    const li = document.createElement("li");
    li.className = "sys";
    li.id = "sys-" + s.id;
    ul.appendChild(li);
    renderSidebarRow(s.id);
  }
}
function renderSidebarRow(sysId) {
  const li = $("sys-" + sysId);
  if (!li) return;
  const s = SYS[sysId], st = sysState[sysId];
  const open = li.classList.contains("open");
  const groups = groupsBySys[sysId] || [];
  li.innerHTML = `
    <div class="sys-row">
      <button class="caret" aria-label="Show regions" ${groups.length > 1 ? "" : 'style="visibility:hidden"'}>${caret}</button>
      <span class="swatch" style="background:${s.color}"></span>
      <span class="sys-name">${s.label}${st.loading ? '<span class="spin"></span>' : ""}</span>
      <button class="mini ${st.ghost ? "on" : ""}" title="See-through" ${st.visible ? "" : "disabled"}>Ghost</button>
      <label class="toggle" title="Show / hide"><input type="checkbox" ${st.visible ? "checked" : ""} aria-label="Show ${s.label}"/><span></span></label>
    </div>
    <ul class="sub-list">${groups.map((g) => `
      <li><label><input type="checkbox" data-g="${g}" ${hiddenGroups.has(g) ? "" : "checked"}/>${GROUPS[g]?.[0] || g}</label><small>${countByGroup[g]}</small></li>`).join("")}
    </ul>`;
  li.classList.toggle("open", open);
  li.querySelector(".caret").onclick = () => li.classList.toggle("open");
  li.querySelector(".sys-name").onclick = () => li.classList.toggle("open");
  li.querySelector(".toggle input").onchange = async (e) => {
    st.visible = e.target.checked;
    if (!st.visible && st.ghost) st.ghost = false;
    renderSidebarRow(sysId);
    if (st.visible) await loadSystem(sysId).catch(() => {});
    if (!st.visible && selected && PARTS[selected].y === sysId) select(null);
    refreshVisibility();
    if (mode === "quiz") buildQuizPool();
  };
  li.querySelector(".mini").onclick = () => {
    st.ghost = !st.ghost;
    for (const [id] of roots) if (PARTS[id].y === sysId) paint(id);
    pickList = null;
    renderSidebarRow(sysId);
    if (mode === "quiz") buildQuizPool();
  };
  li.querySelectorAll(".sub-list input").forEach((cb) => (cb.onchange = () => {
    cb.checked ? hiddenGroups.delete(cb.dataset.g) : hiddenGroups.add(cb.dataset.g);
    refreshVisibility();
    if (mode === "quiz") buildQuizPool();
  }));
}
$("btnMenu").onclick = () => document.body.classList.add("side-open");
$("btnCloseSide").onclick = () => document.body.classList.remove("side-open");

/* ---------------- Search ---------------- */
let searchIndex = [];
const search = $("search"), results = $("searchResults");
let kbIndex = -1;
function buildSearch() {
  const seen = new Map();
  for (const [id, p] of Object.entries(PARTS)) {
    const k = p.n.toLowerCase();
    if (!seen.has(k)) seen.set(k, { id, n: p.n, y: p.y, lc: k });
  }
  searchIndex = [...seen.values()].sort((a, b) => a.n.length - b.n.length);
}
function runSearch() {
  const q = search.value.trim().toLowerCase();
  kbIndex = -1;
  if (q.length < 2) { results.hidden = true; return; }
  const words = q.split(/\s+/);
  const hits = [];
  for (const e of searchIndex) {
    if (words.every((w) => e.lc.includes(w))) {
      hits.push([e.lc.startsWith(q) ? 0 : e.lc.includes(" " + words[0]) ? 1 : 2, e]);
      if (hits.length > 400) break;
    }
  }
  hits.sort((a, b) => a[0] - b[0]);
  results.innerHTML = hits.length
    ? hits.slice(0, 40).map(([, e]) => `<li data-id="${e.id}"><span>${e.n}</span><small>${SYS[e.y].label}</small></li>`).join("")
    : '<li class="empty">No matching parts</li>';
  results.hidden = false;
}
search.addEventListener("input", runSearch);
search.addEventListener("focus", runSearch);
search.addEventListener("keydown", (e) => {
  const items = [...results.querySelectorAll("li[data-id]")];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    kbIndex = (kbIndex + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle("kb", i === kbIndex));
    items[kbIndex]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    const li = items[kbIndex] || items[0];
    if (li) pickResult(li.dataset.id);
  } else if (e.key === "Escape") { results.hidden = true; search.blur(); }
});
results.addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  e.preventDefault();
  pickResult(li.dataset.id);
});
function pickResult(id) {
  results.hidden = true;
  search.value = PARTS[id].n;
  search.blur();
  document.body.classList.remove("side-open");
  if (mode === "quiz") setMode("explore");
  goTo(id, { reveal: true });
}
search.addEventListener("blur", () => setTimeout(() => (results.hidden = true), 120));

/* ---------------- Quiz ---------------- */
let quizPool = [], quizTarget = null, quizScore = 0, quizTotal = 0, quizMissed = false;
function buildQuizPool() {
  const byName = new Map();
  for (const [id, root] of roots) {
    if (!isPickable(id)) continue;
    const size = new THREE.Box3().setFromObject(root).getSize(v3).length();
    if (size < modelSize * 0.04) continue; // skip tiny, hard-to-click parts
    byName.set(PARTS[id].n, id);
  }
  quizPool = [...byName.keys()];
}
function nextQuestion() {
  if (!quizPool.length) { $("quizTarget").textContent = "turn on a body system"; quizTarget = null; return; }
  let n;
  do n = quizPool[Math.floor(Math.random() * quizPool.length)]; while (quizPool.length > 1 && n === quizTarget);
  quizTarget = n;
  quizMissed = false;
  $("quizTarget").textContent = n;
}
function flash(text, good) {
  const d = document.createElement("div");
  d.className = "quiz-flash " + (good ? "good" : "bad");
  d.textContent = text;
  $("stage").appendChild(d);
  setTimeout(() => d.remove(), 1700);
}
function showHint(ms = 1400) {
  hintIds = new Set([...roots.keys()].filter((id) => PARTS[id].n === quizTarget));
  hintIds.forEach(paint);
  setTimeout(() => { const h = hintIds; hintIds = new Set(); h.forEach(paint); }, ms);
}
function quizAnswer(id) {
  if (!id || !quizTarget) return;
  if (PARTS[id].n === quizTarget) {
    if (!quizMissed) quizScore++;
    quizTotal++;
    flash("Correct! " + quizTarget, true);
    updateScore();
    nextQuestion();
  } else {
    if (!quizMissed) { quizTotal++; quizMissed = true; updateScore(); }
    flash("That's the " + PARTS[id].n, false);
  }
}
function updateScore() { $("quizScore").textContent = quizScore; $("quizTotal").textContent = quizTotal; }
$("quizSkip").onclick = () => { if (quizTarget) { if (!quizMissed) quizTotal++; updateScore(); showHint(1200); setTimeout(nextQuestion, 1200); } };
$("quizHint").onclick = () => { if (quizTarget) { quizMissed = true; showHint(); } };

function setMode(m) {
  mode = m;
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  $("quizBar").hidden = m !== "quiz";
  if (m === "quiz") {
    select(null);
    quizScore = quizTotal = 0; updateScore();
    buildQuizPool(); nextQuestion();
  }
}
document.querySelectorAll(".mode").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

/* ---------------- Boot ---------------- */
$("btnStart").onclick = () => { $("welcome").hidden = true; try { localStorage.setItem("be-welcomed", "1"); } catch {} };
try { if (localStorage.getItem("be-welcomed")) $("welcome").hidden = true; } catch {}

async function boot() {
  resize();
  requestAnimationFrame(loop);
  PARTS = await (await fetch("data/parts.json")).json();
  for (const [id, p] of Object.entries(PARTS)) {
    nameKey[sanitize(id)] = id;
    countByGroup[p.g] = (countByGroup[p.g] || 0) + 1;
    (groupsBySys[p.y] ||= new Set()).add(p.g);
  }
  for (const k in groupsBySys) groupsBySys[k] = [...groupsBySys[k]].sort();
  for (const s of SYSTEMS) sysState[s.id] = { loaded: false, loading: null, visible: s.on, ghost: false };
  buildSearch();
  renderSidebar();

  const hashId = decodeURIComponent(location.hash.slice(1));
  const initial = SYSTEMS.filter((s) => s.on).map((s) => s.id);
  const prog = {};
  const bar = $("loadBar");
  await Promise.all(initial.map((id) => loadSystem(id, (e) => {
    prog[id] = e.total ? e.loaded / e.total : 0;
    bar.style.width = (Object.values(prog).reduce((a, b) => a + b, 0) / initial.length) * 100 + "%";
  })));
  const box = boxOf([world]);
  modelSize = box.getSize(v3).y || 1.8;
  controls.maxDistance = modelSize * 6;
  fitAll(undefined, 0);
  $("loading").classList.add("done");
  if (hashId && PARTS[hashId]) goTo(hashId, { reveal: true });
}
boot().catch((err) => {
  console.error(err);
  $("loadText").textContent = "Could not load the model. Please serve this folder over http (see README).";
});
