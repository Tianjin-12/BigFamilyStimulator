/* 家族模拟器 viewer：谱系树 + 人口曲线 + 时期参数 + 个人侧栏
   数据格式：cli.py --json-out 导出的 run JSON。无服务器，纯前端。 */
"use strict";

const TAU = Math.PI * 2;
const COLORS = {
  male: "#5b9bd5", female: "#d87fb0", lineage: "#e8b64c",
  dead: "#4a4d55", text: "#d8dae0", dim: "#8b8f98", grid: "#2a2d34",
  spouseLine: "#3d4048", parentLine: "#565a63",
};

const state = {
  data: null,          // {people, history, era_bands, ...}
  byId: new Map(),
  layout: null,        // [{id, x, y, gen}]
  selected: null,
  view: { x: 0, y: 0, scale: 1 },
  drag: null,
};

/* ---------- 数据加载 ---------- */

async function loadData(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  state.data = data;
  state.byId = new Map(data.people.map(p => [p.id, p]));
  state.selected = null;
  await NameEngine.load();
  NameEngine.setPeople(data.people);
  computeLayout();
  resetView();
  drawAll();
  renderMeta();
  renderSide(null);
}

function renderMeta() {
  const d = state.data;
  const meta = document.getElementById("meta");
  const ext = d.extinct_year !== null
    ? `血脉断绝于 y${d.extinct_year}（${d.extinct_reasons.join(", ")}）`
    : "血脉未断绝";
  meta.textContent =
    `seed ${d.seed} · ${ext} · 存续 ${d.max_lineage_gen} 代 · 村庄累计 ${d.total_pop_ever} 人 · 终止态 ${d.termination}`;
}

/* ---------- 谱系布局：世代 y 轴 + 同代婚配聚簇 ---------- */

function computeLayout() {
  const { people } = state.data;
  // 世代深度：沿父母链最深路径（创始者=0）
  const gen = new Map();
  const idOf = id => state.byId.get(id);

  function depthOf(p) {
    if (gen.has(p.id)) return gen.get(p.id);
    gen.set(p.id, 0); // 防环（数据不应有环）
    let d = 0;
    const f = p.father !== null ? idOf(p.father) : null;
    const m = p.mother !== null ? idOf(p.mother) : null;
    if (f) d = Math.max(d, depthOf(f) + 1);
    if (m) d = Math.max(d, depthOf(m) + 1);
    gen.set(p.id, d);
    return d;
  }
  for (const p of people) depthOf(p);

  // 同代分组，代内按出生年排序
  const byGen = new Map();
  for (const p of people) {
    if (!byGen.has(gen.get(p.id))) byGen.set(gen.get(p.id), []);
    byGen.get(gen.get(p.id)).push(p);
  }
  const X_SPACING = 26, Y_SPACING = 78;
  const layout = [];
  let maxGen = 0;
  for (const [g, ps] of [...byGen.entries()].sort((a, b) => a[0] - b[0])) {
    maxGen = Math.max(maxGen, g);
    ps.sort((a, b) => (a.birth - b.birth) || (a.id - b.id));
    ps.forEach((p, i) => layout.push({ id: p.id, x: (i - (ps.length - 1) / 2) * X_SPACING, y: g * Y_SPACING, gen: g }));
  }
  // 夫妻并排：把配偶拉到本人旁边（右移 12px，代内局部扰动可接受，简单稳定）
  const pos = new Map(layout.map(l => [l.id, l]));
  for (const p of people) {
    if (p.spouse !== null && p.sex === "M" && pos.has(p.spouse)) {
      const a = pos.get(p.id), b = pos.get(p.spouse);
      b.x = (a.x + b.x) / 2 + 12; // 妻子靠近丈夫
      a.x = b.x - 24;
    }
  }
  state.layout = layout;
  state.layoutPos = pos;
  state.maxGen = maxGen;
}

/* ---------- 谱系渲染（canvas，缩放平移） ---------- */

const treeCanvas = document.getElementById("tree");
const tctx = treeCanvas.getContext("2d");

function resetView() {
  state.view = { x: 0, y: 0, scale: 1 };
  fitToContent();
}

function fitToContent() {
  if (!state.layout) return;
  const xs = state.layout.map(l => l.x), ys = state.layout.map(l => l.y);
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  const w = maxX - minX + 60, h = maxY - minY + 80;
  const cw = treeCanvas.clientWidth, ch = treeCanvas.clientHeight;
  const s = Math.min(cw / w, ch / h, 2.2);
  state.view.scale = s;
  state.view.x = cw / 2 - ((minX + maxX) / 2) * s;
  state.view.y = ch / 2 - ((minY + maxY) / 2) * s + 20;
  drawTree();
}

function toScreen(l) {
  return { x: state.view.x + l.x * state.view.scale, y: state.view.y + l.y * state.view.scale };
}

function personRadius() { return Math.max(2.5, 6 * state.view.scale); }

function drawTree() {
  const dpr = window.devicePixelRatio || 1;
  const w = treeCanvas.clientWidth, h = treeCanvas.clientHeight;
  treeCanvas.width = w * dpr; treeCanvas.height = h * dpr;
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tctx.clearRect(0, 0, w, h);
  if (!state.layout) return;

  const pos = state.layoutPos;
  const R = personRadius();

  // 婚姻边
  tctx.strokeStyle = COLORS.spouseLine; tctx.lineWidth = 1;
  for (const p of state.data.people) {
    if (p.sex === "M" && p.spouse !== null && pos.has(p.id) && pos.has(p.spouse)) {
      const a = toScreen(pos.get(p.id)), b = toScreen(pos.get(p.spouse));
      tctx.beginPath(); tctx.moveTo(a.x, a.y); tctx.lineTo(b.x, b.y); tctx.stroke();
    }
  }
  // 亲子边
  tctx.strokeStyle = COLORS.parentLine;
  for (const p of state.data.people) {
    const me = pos.get(p.id);
    for (const par of [p.father, p.mother]) {
      if (par === null) continue;
      const pp = pos.get(par);
      if (!pp) continue;
      const a = toScreen(me), b = toScreen(pp);
      tctx.beginPath();
      tctx.moveTo(a.x, a.y);
      tctx.lineTo(a.x, b.y + (a.y - b.y) / 2);
      tctx.lineTo(b.x, b.y + (a.y - b.y) / 2);
      tctx.lineTo(b.x, b.y);
      tctx.stroke();
    }
  }
  // 节点
  for (const l of state.layout) {
    const p = state.byId.get(l.id);
    const s = toScreen(l);
    if (s.x < -20 || s.x > w + 20 || s.y < -20 || s.y > h + 20) continue;
    let color = p.sex === "M" ? COLORS.male : COLORS.female;
    if (p.lineage) color = COLORS.lineage;
    if (p.death !== null || p.migrated) color = COLORS.dead;
    if (state.selected === p.id) {
      tctx.beginPath(); tctx.arc(s.x, s.y, R + 3.5, 0, TAU);
      tctx.strokeStyle = "#fff"; tctx.lineWidth = 1.5; tctx.stroke();
    }
    tctx.beginPath(); tctx.arc(s.x, s.y, R, 0, TAU);
    tctx.fillStyle = color; tctx.fill();
    // 血脉男丁描边增强
    if (p.lineage && !(p.death !== null || p.migrated)) {
      tctx.beginPath(); tctx.arc(s.x, s.y, R + 1.5, 0, TAU);
      tctx.strokeStyle = "rgba(232,182,76,.4)"; tctx.lineWidth = 1; tctx.stroke();
    }
    const alive = p.death === null && !p.migrated;
    const show = p.lineage || (state.view.scale > 1.4) || (state.view.scale > 0.35 && alive);
    if (show && state.view.scale > 0.2) {
      tctx.fillStyle = p.lineage ? COLORS.lineage : COLORS.dim;
      tctx.font = `${Math.min(11, 6 * state.view.scale + 4)}px sans-serif`;
      tctx.textAlign = "center";
      tctx.fillText(NameEngine.nameOf(p.id), s.x, s.y - R - 3);
    }
  }
}

/* 画布交互：拖动平移 + 滚轮缩放 + 点击选中 */
treeCanvas.addEventListener("mousedown", e => {
  state.drag = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y, moved: false };
  treeCanvas.classList.add("dragging");
});
window.addEventListener("mousemove", e => {
  if (!state.drag) return;
  const dx = e.clientX - state.drag.x, dy = e.clientY - state.drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) state.drag.moved = true;
  state.view.x = state.drag.vx + dx; state.view.y = state.drag.vy + dy;
  drawTree();
});
window.addEventListener("mouseup", () => { state.drag = null; treeCanvas.classList.remove("dragging"); });
treeCanvas.addEventListener("wheel", e => {
  e.preventDefault();
  const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const rect = treeCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  state.view.x = mx - (mx - state.view.x) * k;
  state.view.y = my - (my - state.view.y) * k;
  state.view.scale = Math.min(4, Math.max(0.08, state.view.scale * k));
  drawTree();
}, { passive: false });
treeCanvas.addEventListener("click", e => {
  if (state.drag && state.drag.moved) return;
  if (!state.layout) return;
  const rect = treeCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  let best = null, bestD = 14 * 14;
  for (const l of state.layout) {
    const s = toScreen(l);
    const d = (s.x - mx) ** 2 + (s.y - my) ** 2;
    if (d < bestD) { bestD = d; best = l.id; }
  }
  state.selected = best;
  renderSide(best);
  drawTree();
});

/* ---------- 侧栏 ---------- */

function relLink(id) {
  const p = state.byId.get(id);
  if (!p) return "";
  return `<span class="rel-link" data-id="${id}">${NameEngine.nameOf(id)} ${p.sex === "M" ? "♂" : "♀"}</span>`;
}

function renderSide(id) {
  const side = document.getElementById("side");
  if (id === null || !state.byId.has(id)) {
    side.innerHTML = `<div style="color:var(--dim)">点击谱系中的人物查看详情</div>`;
    return;
  }
  const p = state.byId.get(id);
  const age = p.death !== null ? p.death - p.birth : (state.data.final_year - p.birth);
  const fert = Math.exp(p.ln_fertility || 0).toFixed(2);
  const vuln = Math.exp(p.ln_vulnerability || 0).toFixed(2);
  const kids = state.data.people.filter(q => q.father === p.id || q.mother === p.id).map(q => q.id);
  const status = p.migrated ? "外迁" : p.death !== null ? `卒 y${p.death}` : "在世";
  const tags = [
    p.lineage ? `<span class="tag lineage">血脉</span>` : "",
    p.founder ? `<span class="tag">创始</span>` : "",
    p.migrated ? `<span class="tag">外迁</span>` : "",
  ].join("");
  side.innerHTML = `
    <h2><span class="person-sex-${p.sex}">${NameEngine.nameOf(p.id)} ${p.sex === "M" ? "♂" : "♀"}</span>
      <span style="color:var(--dim);font-size:11px">#${p.id}</span></h2>
    <div style="margin-bottom:8px">${tags}</div>
    <div class="kv">
      <span class="k">生卒</span><span class="v">y${p.birth} — ${p.death !== null ? "y" + p.death : "?"}（${age} 岁，${status}）</span>
      <span class="k">世代</span><span class="v">${state.layoutPos ? state.layoutPos.get(p.id)?.gen ?? "?" : "?"}</span>
      <span class="k">生育力</span><span class="v">${fert}×（ln=${p.ln_fertility?.toFixed(3)}）</span>
      <span class="k">脆弱度</span><span class="v">${vuln}×（ln=${p.ln_vulnerability?.toFixed(3)}）</span>
      <span class="k">亲生子女</span><span class="v">${p.children_born}</span>
    </div>
    <div class="rel-sec">
      <h4>父母</h4>
      <div>${p.father !== null ? relLink(p.father) : "—"} ${p.mother !== null ? relLink(p.mother) : "—"}</div>
      <h4>配偶</h4>
      <div>${p.spouse !== null ? relLink(p.spouse) : "—"}</div>
      <h4>子女（${kids.length}）</h4>
      <div>${kids.length ? kids.map(relLink).join("") : "—"}</div>
    </div>`;
  side.querySelectorAll(".rel-link").forEach(el => {
    el.addEventListener("click", () => {
      state.selected = +el.dataset.id;
      renderSide(state.selected);
      drawTree();
    });
  });
}

/* ---------- 图表：人口曲线 / 世代直方图 / 时期参数 ---------- */

function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawPopChart() {
  const c = document.getElementById("ch-pop");
  const { ctx, w, h } = setupCanvas(c);
  const hist = state.data.history;
  if (!hist.length) return;
  const pad = { l: 30, r: 6, t: 6, b: 16 };
  const maxY = Math.max(...hist.map(r => r.pop)) * 1.05;
  const maxX = hist[hist.length - 1].year;
  const X = y => pad.l + (y / maxX) * (w - pad.l - pad.r);
  const Y = v => h - pad.b - (v / maxY) * (h - pad.t - pad.b);
  // 网格
  ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
  ctx.fillStyle = COLORS.dim; ctx.font = "10px sans-serif";
  for (let i = 0; i <= 3; i++) {
    const v = maxY * i / 3;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
    ctx.fillText(Math.round(v), 2, Y(v) + 3);
  }
  // 村庄人口（填充）
  ctx.beginPath();
  hist.forEach((r, i) => i ? ctx.lineTo(X(r.year), Y(r.pop)) : ctx.moveTo(X(r.year), Y(r.pop)));
  ctx.lineTo(X(maxX), h - pad.b); ctx.lineTo(X(0), h - pad.b); ctx.closePath();
  ctx.fillStyle = "rgba(91,155,213,.18)"; ctx.fill();
  // 人口线
  ctx.beginPath();
  hist.forEach((r, i) => i ? ctx.lineTo(X(r.year), Y(r.pop)) : ctx.moveTo(X(r.year), Y(r.pop)));
  ctx.strokeStyle = COLORS.male; ctx.lineWidth = 1.5; ctx.stroke();
  // 血脉男丁线（右轴固定 0-30）
  const lmMax = Math.max(10, ...hist.map(r => r.lineage_male));
  const Y2 = v => h - pad.b - (v / lmMax) * (h - pad.t - pad.b);
  ctx.beginPath();
  hist.forEach((r, i) => i ? ctx.lineTo(X(r.year), Y2(r.lineage_male)) : ctx.moveTo(X(r.year), Y2(r.lineage_male)));
  ctx.strokeStyle = COLORS.lineage; ctx.lineWidth = 1.8; ctx.stroke();
  // 断绝标记
  if (state.data.extinct_year !== null) {
    ctx.strokeStyle = "#e05555"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(state.data.extinct_year), pad.t); ctx.lineTo(X(state.data.extinct_year), h - pad.b); ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawGenHistogram() {
  const box = document.getElementById("ch-gen");
  const note = document.getElementById("gen-note");
  box.innerHTML = "";
  const { people } = state.data;
  if (!state.layoutPos) return;
  const counts = new Map();
  let lineageCount = new Map();
  for (const p of people) {
    const g = state.layoutPos.get(p.id)?.gen;
    if (g === undefined) continue;
    counts.set(g, (counts.get(g) || 0) + 1);
    if (p.lineage) lineageCount.set(g, (lineageCount.get(g) || 0) + 1);
  }
  const gens = [...counts.keys()].sort((a, b) => a - b);
  const maxC = Math.max(...counts.values());
  note.textContent = `共 ${gens.length} 代（竖条=血脉男丁）`;
  for (const g of gens) {
    const bar = document.createElement("div");
    bar.className = "hist-bar";
    const total = counts.get(g);
    const lin = lineageCount.get(g) || 0;
    bar.style.height = `${(total / maxC) * 100}%`;
    bar.title = `第 ${g} 代：共 ${total} 人，血脉男丁 ${lin}`;
    // 血脉占比作为底部色块
    const sub = document.createElement("div");
    sub.style.cssText = `position:absolute;bottom:0;left:0;right:0;height:100%;border-top:${Math.max(0,(lin/maxC)*100)}% solid var(--lineage);box-sizing:border-box;pointer-events:none;border-bottom:none;border-left:none;border-right:none;`;
    if (g % 2 === 0) bar.appendChild(sub);
    else bar.style.background = "var(--female)";
    if (lin) bar.style.outline = "1px solid var(--lineage)";
    const lbl = document.createElement("div");
    lbl.className = "lbl"; lbl.textContent = g;
    bar.appendChild(lbl);
    box.appendChild(bar);
  }
}

function drawEraChart() {
  const c = document.getElementById("ch-era");
  const { ctx, w, h } = setupCanvas(c);
  const bands = state.data.era_bands;
  if (!bands || !bands.length) return;
  const pad = { l: 30, r: 34, t: 6, b: 16 };
  const maxY = Math.max(...bands.map(b => b.birth_prob), 0.5);
  const maxK = Math.max(...bands.map(b => b.carrying_capacity));
  const X = i => pad.l + (i / (bands.length - 1 || 1)) * (w - pad.l - pad.r);
  const Y = v => h - pad.b - (v / maxY) * (h - pad.t - pad.b);
  const Y2 = v => h - pad.b - (v / maxK) * (h - pad.t - pad.b);
  ctx.strokeStyle = COLORS.grid; ctx.fillStyle = COLORS.dim; ctx.font = "10px sans-serif";
  for (let i = 0; i <= 2; i++) {
    const v = maxY * i / 2;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
    ctx.fillText(v.toFixed(2), 2, Y(v) + 3);
  }
  // K（右轴）
  ctx.beginPath();
  bands.forEach((b, i) => i ? ctx.lineTo(X(i), Y2(b.carrying_capacity)) : ctx.moveTo(X(i), Y2(b.carrying_capacity)));
  ctx.strokeStyle = "#7fbf8f"; ctx.lineWidth = 1.3; ctx.stroke();
  ctx.fillStyle = "#7fbf8f"; ctx.textAlign = "left";
  ctx.fillText(`K=${maxK}`, w - pad.r + 3, Y2(maxK) + 3);
  // 生育概率
  ctx.beginPath();
  bands.forEach((b, i) => i ? ctx.lineTo(X(i), Y(b.birth_prob)) : ctx.moveTo(X(i), Y(b.birth_prob)));
  ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 1.6; ctx.stroke();
  // 夭折率（同左轴 0-0.5 域）
  ctx.beginPath();
  bands.forEach((b, i) => i ? ctx.lineTo(X(i), Y(b.infant_mortality)) : ctx.moveTo(X(i), Y(b.infant_mortality)));
  ctx.strokeStyle = "#e05555"; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.textAlign = "center";
  ctx.fillStyle = COLORS.dim;
  ctx.fillText(`y${bands[0].start_year}`, pad.l, h - 4);
  ctx.fillText(`y${bands[bands.length - 1].start_year}`, w - pad.r, h - 4);
  // 图例（文字）
  ctx.textAlign = "left"; ctx.font = "10px sans-serif";
  ctx.fillStyle = COLORS.accent; ctx.fillText("生育p", w - 62, 12);
  ctx.fillStyle = "#e05555"; ctx.fillText("夭折", w - 40, 12);
}

function drawAll() {
  if (!state.data) return;
  drawPopChart();
  drawGenHistogram();
  drawEraChart();
  drawTree();
}

/* ---------- 文件加载入口 ---------- */

document.getElementById("btn-load").addEventListener("click", () =>
  document.getElementById("file-input").click());
document.getElementById("file-input").addEventListener("change", e => {
  if (e.target.files[0]) loadData(e.target.files[0]);
});
document.getElementById("btn-reset").addEventListener("click", () => {
  if (state.data) { resetView(); drawAll(); }
});
window.addEventListener("resize", () => { if (state.data) drawAll(); });

/* 拖拽加载 */
const overlay = document.getElementById("drop-overlay");
window.addEventListener("dragover", e => { e.preventDefault(); overlay.classList.add("on"); });
overlay.addEventListener("dragleave", () => overlay.classList.remove("on"));
window.addEventListener("drop", e => {
  e.preventDefault();
  overlay.classList.remove("on");
  if (e.dataTransfer.files[0]) loadData(e.dataTransfer.files[0]);
});

/* 无参启动时也支持 ?src=run7.json（本地服务器场景） */
const params = new URLSearchParams(location.search);
if (params.get("src")) {
  fetch(params.get("src"))
    .then(r => r.text())
    .then(t => loadData(new Blob([t], { type: "application/json" })))
    .catch(() => {});
}
