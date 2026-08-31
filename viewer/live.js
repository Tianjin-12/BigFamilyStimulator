/* 实时 viewer：边算边看。经 server.py 的 /api/new + /api/step 驱动。
   世界感：纪年/纪元、时间轴、事件流、谱系生长闪光。 */
"use strict";

const TAU = Math.PI * 2;
const C = {
  male: "#5b9bd5", female: "#d87fb0", lineage: "#e8b64c", dead: "#4a4d55",
  text: "#dcdee4", dim: "#8b8f9a", grid: "#2a2d34",
  spouseLine: "#3d4048", parentLine: "#565a63", red: "#e05555", green: "#7fbf8f",
};
const ERA_NAMES = ["洪荒", "草莱", "拓荒", "耕稼", "聚落", "邑成", "人稠", "熙攘", "鼎盛", "盈满"];
// 纪元风物志：踏入新纪时的一句时代素描
const ERA_FLAVOR = {
  "洪荒": "草昧初辟，薪火初聚。",
  "草莱": "斩草结庐，田亩初垦。",
  "拓荒": "锄声四起，阡陌渐直。",
  "耕稼": "春种秋藏，仓廪渐实。",
  "聚落": "比屋而居，鸡犬相闻。",
  "邑成": "环堵成邑，市声渐闻。",
  "人稠": "烟火日稠，井邑如画。",
  "熙攘": "车马辐辏，昼夜不息。",
  "鼎盛": "仓廪实而知礼节，此其时也。",
  "盈满": "地不足以容人，乡邻思远游。",
};

const state = {
  snap: null,            // 最新全量快照
  byId: new Map(),
  layout: new Map(),     // id -> {x,y,gen}
  maxGen: 0,
  view: { x: 0, y: 0, scale: 1 },
  drag: null,
  selected: null,
  playing: false,
  speedMs: 240,
  timer: null,
  busy: false,           // 请求互斥
  pendingYears: 0,       // 忙时点击排队的年数（完成后自动补跑）
  finished: false,
  worldSeed: 42,         // 当前世界参数（断绝卡"再开新世界"用）
  worldOverrides: {},
  worldFounder: null,
  chronicle: [],         // 村志（大事记，供"村志"标签页与导出）
  sideTab: "detail",
  kidsCache: new Map(),  // parentId -> [子女id]（每次重排重建，避免面板全表扫描）
  hlSet: new Set(),      // 直系关系光圈（定位/亲属跳转时显示）
};

// 进村志的事件种类（vital 太细碎；weddings 年年有会刷屏，只在事件流展示）
const CHRONICLE_KINDS = new Set([
  "era", "milestone", "elder_death", "coming_of_age",
  "harvest", "flavor", "extinct", "lineage_danger", "lineage_birth",
]);

const $ = id => document.getElementById(id);
const api = (path, body) => fetch(path, {
  method: body ? "POST" : "GET",
  headers: { "Content-Type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
}).then(r => r.json());

/* ---------- 世界纪年 ---------- */

function eraChip() {
  const band = Math.floor((state.snap.year || 0) / 10);
  const name = ERA_NAMES[Math.min(ERA_NAMES.length - 1, Math.floor(band / 4))];
  $("clock-year").textContent = `y ${state.snap.year}`;
  const style = NameEngine.styleOfYear(state.snap.year);
  $("era-chip").innerHTML = `第 <b>${band + 1}</b> 纪 · ${style || name}`;
  const b = (state.snap.era_bands || []).slice(-1)[0];
  if (b) {
    $("era-detail").innerHTML =
      `生育p ${b.birth_prob.toFixed(2)} · 夭折 ${(b.infant_mortality * 100).toFixed(0)}% · K ${b.carrying_capacity}`;
  } else {
    $("era-detail").textContent = "";
  }
}

function updateStats(s) {
  $("st-pop").textContent = s.pop;
  $("st-couples").textContent = s.couples;
  const linB = $("st-lin");
  linB.textContent = s.lineage_male;
  linB.classList.toggle("danger", s.lineage_male === 0);
  linB.classList.toggle("warn", s.lineage_male > 0 && s.lineage_male <= 2);
  $("st-gen").textContent = s.max_lineage_gen;
  $("st-ever").textContent = s.total_pop_ever;
  // 年度流量（最后一年，字段兜底防 undefined）
  const hist = state.snap.history;
  const last = hist.length ? hist[hist.length - 1] : null;
  if (last && last.born !== undefined) {
    const f = (v) => (v ?? 0);
    $("st-flow").textContent =
      `+${f(last.born)} −${f(last.died)} ←${f(last.emigrated)} →${f(last.immigrated)}`;
  } else {
    $("st-flow").textContent = "—";
  }
}

/* ---------- 事件流 ---------- */

// 断绝原因码 → 中文（未知码回退原码）
const REASON_TEXT = {
  E1_no_male_born: "始终没有男丁出生",
  E2_male_unbred: "男丁未婚未育",
  E3_male_early_death: "男丁早年夭折",
  E4_male_migrated: "男丁外迁离村",
  E6_married_no_child: "已婚但终生未育",
};
const reasonZh = reasons => (reasons || []).map(r => REASON_TEXT[r] || r).join("，");
// 迁移事件代表姓名：张三、李四 等 12 人
const moverNames = e => (e.names && e.names.length) ? `${e.names.join("、")} 等 ` : "";

const EV_TEXT = {
  era: e => {
    const name = ERA_NAMES[Math.min(ERA_NAMES.length - 1, Math.floor(e.band / 4))];
    return `踏入新纪（第 ${e.band + 1} 纪 · ${name}）——${ERA_FLAVOR[name] || ""}`;
  },
  harvest: e => e.text,
  flavor: e => e.text,
  elder_death: e => `村中最年长的 ${NameEngine.nameOf(e.id)}（${e.age} 岁）辞世，全村送行`,
  coming_of_age: e => `血脉男丁 ${NameEngine.nameOf(e.id)} 年满十六，行冠礼，入族谱`,
  milestone: e => `炊烟渐稠——村庄人口首破 ${e.tier}（现 ${e.pop} 人）`,
  vital: e => `${e.span && e.span > 1 ? `近 ${e.span} 年：` : ""}` +
    `出生 ${e.born} 人 · 死亡 ${e.died} 人` +
    ((e.emigrated || e.immigrated) ? ` · 迁出 ${e.emigrated || 0} · 迁入 ${e.immigrated || 0}` : ""),
  lineage_danger: e => `⚠ 血脉危急！在世血脉男丁仅剩 ${e.count} 人`,
  lineage_birth: e => {
    const l = state.layout.get(e.id);
    return `血脉添丁！${NameEngine.nameOf(e.id)} 诞生`
      + (l ? `，谱系延至第 ${l.gen + 1} 代` : "");
  },
  lineage_infant_death: e => `血脉婴儿 ${NameEngine.nameOf(e.id)} 夭折`,
  lineage_marriage: e => `血脉成婚 ${NameEngine.nameOf(e.ids[0])} ⚭ ${NameEngine.nameOf(e.ids[1])}`,
  lineage_death: e => `血脉男丁 ${NameEngine.nameOf(e.id)} 去世（${e.age} 岁）`
    + (e.children !== undefined ? `，一生 ${e.children} 子` : ""),
  lineage_migrated: e => `血脉男丁 ${NameEngine.nameOf(e.id)} 离乡`,
  weddings: e => `本年成婚 ${e.count} 对——${NameEngine.nameOf(e.ids[0])} ⚭ ${NameEngine.nameOf(e.ids[1])} 最先拜堂`,
  emigration: e => `${moverNames(e)}${e.count} 人离乡外出`,
  emigration_wave: e => `时艰！迁出潮：${moverNames(e)}${e.count} 人背井离乡`,
  immigration: e => `${e.from ? `自${e.from}来的 ` : ""}${moverNames(e)}${e.count} 名移民迁入村庄`,
  extinct: e => `血脉断绝！${reasonZh(e.reasons)}`,
};

function appendEvents(events) {
  const list = $("feed-list");
  const feed = $("feed");
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 24;
  let fresh = 0;
  for (const ev of events) {
    const fn = EV_TEXT[ev.kind];
    if (!fn) continue;
    const div = document.createElement("div");
    // 血脉主线事件（诞生/夭折/成婚/去世/外迁/断绝/危急）带金边突出
    const isMain = ev.kind.startsWith("lineage_") || ev.kind === "extinct";
    div.className = `ev k-${ev.kind.replace("lineage_", "")}${isMain ? " hl" : ""}`;
    const text = fn(ev);
    div.innerHTML = `<span class="y">y${ev.year}</span><span class="tx">${text}</span>`;
    list.appendChild(div);
    fresh++;
    if (CHRONICLE_KINDS.has(ev.kind)) {
      state.chronicle.push({ year: ev.year, text, kind: ev.kind });
      if (state.chronicle.length > 400) state.chronicle.shift();
    }
  }
  // 只保留最近 200 条 DOM
  while (list.children.length > 200) list.removeChild(list.firstChild);
  // 停在底部（或首次）→ 自动跟随最新；用户上滚翻史书时不打扰，只亮"有新事件"
  if (fresh) {
    if (nearBottom) {
      feed.scrollTop = feed.scrollHeight;
      $("feed-new").hidden = true;
    } else {
      $("feed-new").hidden = false;
    }
    // 村志页开着就实时跟上（最新在顶部）
    if (state.sideTab === "chronicle") renderChronicle();
  }
}

/* ---------- 谱系布局（增量） ---------- */

function layoutAll() {
  const { people } = state.snap;
  const gen = new Map();
  const depthOf = p => {
    if (gen.has(p.id)) return gen.get(p.id);
    gen.set(p.id, 0);
    let g = 0;
    const f = p.father !== null ? state.byId.get(p.father) : null;
    const m = p.mother !== null ? state.byId.get(p.mother) : null;
    if (f) g = Math.max(g, depthOf(f) + 1);
    if (m) g = Math.max(g, depthOf(m) + 1);
    gen.set(p.id, g);
    return g;
  };
  for (const p of people) depthOf(p);
  const byGen = new Map();
  for (const p of people) {
    const g = gen.get(p.id);
    if (!byGen.has(g)) byGen.set(g, []);
    byGen.get(g).push(p);
  }
  const X_SP = 26, Y_SP = 78;
  state.layout.clear();
  state.maxGen = 0;
  for (const [g, ps] of byGen) {
    state.maxGen = Math.max(state.maxGen, g);
    ps.sort((a, b) => (a.birth - b.birth) || (a.id - b.id));
    ps.forEach((p, i) => state.layout.set(p.id, {
      x: (i - (ps.length - 1) / 2) * X_SP, y: g * Y_SP, gen: g,
    }));
  }
  // 夫妻并排
  for (const p of people) {
    if (p.sex === "M" && p.spouse !== null && state.layout.has(p.spouse)) {
      const a = state.layout.get(p.id), b = state.layout.get(p.spouse);
      b.x = (a.x + b.x) / 2 + 12;
      a.x = b.x - 24;
    }
  }
  // 子女索引：面板/光圈/之最都走它，避免每次全表扫描
  state.kidsCache = new Map();
  for (const q of people) {
    for (const pid of [q.father, q.mother]) {
      if (pid === null) continue;
      if (!state.kidsCache.has(pid)) state.kidsCache.set(pid, []);
      state.kidsCache.get(pid).push(q.id);
    }
  }
}

function relayoutIfNeeded() {
  // 每帧全量重排：5 万人 21ms（node 实测），每年一次无压力
  if (state.snap) layoutAll();
}

/* ---------- 谱系绘制 ---------- */

const treeCanvas = $("tree");
const tctx = treeCanvas.getContext("2d");

function toScreen(l) {
  return { x: state.view.x + l.x * state.view.scale, y: state.view.y + l.y * state.view.scale };
}

function drawTree() {
  if (!state.snap) return;
  const dpr = devicePixelRatio || 1;
  const w = treeCanvas.clientWidth, h = treeCanvas.clientHeight;
  treeCanvas.width = w * dpr; treeCanvas.height = h * dpr;
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tctx.clearRect(0, 0, w, h);
  const R = Math.max(2.5, 6 * state.view.scale);
  // 边
  tctx.strokeStyle = C.spouseLine; tctx.lineWidth = 1;
  for (const p of state.snap.people) {
    if (p.sex === "M" && p.spouse !== null && state.layout.has(p.spouse)) {
      const a = toScreen(state.layout.get(p.id)), b = toScreen(state.layout.get(p.spouse));
      tctx.beginPath(); tctx.moveTo(a.x, a.y); tctx.lineTo(b.x, b.y); tctx.stroke();
    }
  }
  tctx.strokeStyle = C.parentLine;
  for (const p of state.snap.people) {
    const me = state.layout.get(p.id);
    for (const par of [p.father, p.mother]) {
      if (par === null) continue;
      const pp = state.layout.get(par);
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
  // 标签密度分级：极度缩小只标血脉；中等标血脉+在世者；放大全标
  const labelMode = state.view.scale > 1.4 ? 2 : state.view.scale > 0.35 ? 1 : 0;
  // 节点
  for (const p of state.snap.people) {
    const l = state.layout.get(p.id);
    if (!l) continue;
    const s = toScreen(l);
    if (s.x < -20 || s.x > w + 20 || s.y < -20 || s.y > h + 20) continue;
    let color = p.sex === "M" ? C.male : C.female;
    if (p.lineage) color = C.lineage;
    if (p.death !== null || p.migrated) color = C.dead;
    if (state.selected === p.id) {
      tctx.beginPath(); tctx.arc(s.x, s.y, R + 3.5, 0, TAU);
      tctx.strokeStyle = "#fff"; tctx.lineWidth = 1.5; tctx.stroke();
    } else if (state.hlSet && state.hlSet.has(p.id)) {
      // 直系关系光圈（定位/亲属跳转时点亮）
      tctx.beginPath(); tctx.arc(s.x, s.y, R + 5.5, 0, TAU);
      tctx.strokeStyle = "rgba(232,182,76,.55)"; tctx.lineWidth = 1.2; tctx.stroke();
    }
    tctx.beginPath(); tctx.arc(s.x, s.y, R, 0, TAU);
    tctx.fillStyle = color; tctx.fill();
    // 标签：全部用姓名（不再显示 #id）。mode0 只标血脉，mode1 + 在世者，mode2 全部
    const alive = p.death === null && !p.migrated;
    const show = p.lineage || (labelMode >= 2) || (labelMode === 1 && alive);
    if (show && state.view.scale > 0.2) {
      tctx.fillStyle = p.lineage ? C.lineage : C.dim;
      tctx.font = `${Math.min(11, 6 * state.view.scale + 4)}px sans-serif`;
      tctx.textAlign = "center";
      tctx.fillText(NameEngine.nameOf(p.id), s.x, s.y - R - 3);
    }
  }
  // 世代标尺：行距被压缩到放不下标签时跳着标，保证间距 ≥13px 不互相重叠
  tctx.fillStyle = C.dim; tctx.font = "11px sans-serif"; tctx.textAlign = "left";
  const rowPx = 78 * state.view.scale;
  const skip = Math.max(1, Math.ceil(13 / rowPx));
  for (let g = 0; g <= state.maxGen; g += skip) {
    const y = state.view.y + g * 78 * state.view.scale;
    if (y > 14 && y < h - 6) tctx.fillText(`第${g}代`, 6, y - 6);
  }
}

function fitToPoints(pts, padX = 60, padY = 90) {
  if (!pts.length) return;
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const l of pts) {
    minX = Math.min(minX, l.x); maxX = Math.max(maxX, l.x);
    minY = Math.min(minY, l.y); maxY = Math.max(maxY, l.y);
  }
  const cw = treeCanvas.clientWidth, ch = treeCanvas.clientHeight;
  const s = Math.min(cw / (maxX - minX + padX), ch / (maxY - minY + padY), 2.2);
  state.view.scale = s;
  state.view.x = cw / 2 - ((minX + maxX) / 2) * s;
  state.view.y = ch / 2 - ((minY + maxY) / 2) * s + 20;
}

function fitView() {
  if (state.layout.size) fitToPoints([...state.layout.values()]);
}

/* 聚焦：把某人平移到画布中心，视野过小时放大到可读；同时点亮直系上下代光圈 */
function focusPerson(id, minScale = 1.2) {
  const l = state.layout.get(id);
  if (!l) return;
  const s = Math.max(state.view.scale, minScale);
  state.view.scale = s;
  state.view.x = treeCanvas.clientWidth / 2 - l.x * s;
  state.view.y = treeCanvas.clientHeight / 2 - l.y * s;
  state.hlSet = relatedHalo(id);
  drawTree();
}

/* 直系关系网：上两层尊亲（父母/祖辈）+ 下两层子孙 */
function relatedHalo(id) {
  const set = new Set();
  let cur = [id];
  for (let d = 0; d < 2; d++) {
    const nxt = [];
    for (const pid of cur) {
      const q = state.byId.get(pid);
      if (!q) continue;
      for (const par of [q.father, q.mother]) {
        if (par !== null && !set.has(par)) { set.add(par); nxt.push(par); }
      }
    }
    cur = nxt;
  }
  cur = [id];
  for (let d = 0; d < 2; d++) {
    const nxt = [];
    for (const pid of cur) {
      for (const c of (state.kidsCache.get(pid) || [])) {
        if (!set.has(c)) { set.add(c); nxt.push(c); }
      }
    }
    cur = nxt;
  }
  set.delete(id);
  return set;
}

function zoomBy(k) {
  const mx = treeCanvas.clientWidth / 2, my = treeCanvas.clientHeight / 2;
  state.view.x = mx - (mx - state.view.x) * k;
  state.view.y = my - (my - state.view.y) * k;
  state.view.scale = Math.min(4, Math.max(0.08, state.view.scale * k));
  drawTree();
}

function fitLineage() {
  const pts = [];
  for (const [id, l] of state.layout) {
    const p = state.byId.get(id);
    if (p && p.lineage) pts.push(l);
  }
  if (!pts.length) { flashToast("谱系中暂无血脉成员"); return; }
  fitToPoints(pts, 80, 60);
}

/* 出生闪光：谱系上新出现的人头顶冒字 */
function flashBirths(deltaPeople) {
  if (!deltaPeople) return;
  if (window.Meta && !Meta.settings.flashBirths) return;   // 设置里可关
  const wrap = treeCanvas.parentElement;
  for (const p of deltaPeople) {
    if (!p.lineage) continue;
    const l = state.layout.get(p.id);
    if (!l) continue;
    const s = toScreen(l);
    if (s.x < 0 || s.x > wrap.clientWidth || s.y < 0 || s.y > wrap.clientHeight) continue;
    const el = document.createElement("div");
    el.className = "flash";
    el.textContent = `♂ ${NameEngine.nameOf(p.id)}`;
    el.style.left = `${s.x - 26}px`; el.style.top = `${s.y - 18}px`;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }
}

/* 姓氏排行（在世）：水平条 */
function drawSurnames() {
  const c = $("ch-surnames");
  if (!c) return;
  const { ctx, w, h } = setupCanvas(c);
  const cur = state.snap.year;
  const livingIds = [];
  for (const p of state.snap.people) {
    if (p.death === null && !p.migrated && p.birth <= cur) livingIds.push(p.id);
  }
  const rank = NameEngine.surnameRank(livingIds).slice(0, 12);
  if (!rank.length) return drawPlaceholder(ctx, w, h);
  const max = rank[0][1];
  const bh = Math.min(13, (h - 6) / rank.length);
  ctx.font = "11px sans-serif";
  rank.forEach(([name, count], i) => {
    const y = 3 + i * bh;
    const isFocus = false; // 焦点姓 = 创始者之姓
    // 焦点家族姓高亮：取血脉始祖（lineage=true 且 father=null）的姓
    ctx.fillStyle = C.dim;
    ctx.textAlign = "right";
    ctx.fillText(name, 30, y + bh - 3);
    ctx.textAlign = "left";
    ctx.fillStyle = isFocus ? C.lineage : "rgba(91,155,213,.6)";
    ctx.fillRect(34, y + 1.5, ((count / max) * (w - 90)), bh - 4);
    ctx.fillStyle = C.dim;
    ctx.fillText(count, 38 + (count / max) * (w - 90), y + bh - 3);
  });
  // 焦点姓氏标金
  const focus = state.snap.people.find(p => p.lineage && p.father === null);
  if (focus) {
    const fs = NameEngine.nameOf(focus.id).slice(0, 1);
    const idx = rank.findIndex(r => r[0] === fs);
    if (idx >= 0) {
      const y = 3 + idx * bh;
      ctx.fillStyle = C.lineage;
      ctx.fillRect(34, y + 1.5, (rank[idx][1] / max) * (w - 90), bh - 4);
      ctx.fillStyle = "#14161a";
      ctx.fillText(rank[idx][1], 38, y + bh - 3);
      ctx.fillStyle = C.lineage; ctx.textAlign = "right";
      ctx.fillText(fs, 30, y + bh - 3);
    }
  }
}

/* 画布交互 */
treeCanvas.addEventListener("mousedown", e => {
  state.drag = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y, moved: false };
  treeCanvas.classList.add("dragging");
});
addEventListener("mousemove", e => {
  if (!state.drag) return;
  const dx = e.clientX - state.drag.x, dy = e.clientY - state.drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) state.drag.moved = true;
  state.view.x = state.drag.vx + dx; state.view.y = state.drag.vy + dy;
  drawTree();
});
addEventListener("mouseup", () => { state.drag = null; treeCanvas.classList.remove("dragging"); });
treeCanvas.addEventListener("wheel", e => {
  e.preventDefault();
  const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const r = treeCanvas.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  state.view.x = mx - (mx - state.view.x) * k;
  state.view.y = my - (my - state.view.y) * k;
  state.view.scale = Math.min(4, Math.max(0.08, state.view.scale * k));
  drawTree();
}, { passive: false });
treeCanvas.addEventListener("click", e => {
  if (state.drag && state.drag.moved) return;
  if (!state.layout.size) return;
  const r = treeCanvas.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  let best = null, bestD = 14 * 14;
  for (const [id, l] of state.layout) {
    const s = toScreen(l);
    const d = (s.x - mx) ** 2 + (s.y - my) ** 2;
    if (d < bestD) { bestD = d; best = id; }
  }
  state.selected = best;
  state.hlSet = new Set();   // 直接点选他人即清除上一组直系光圈
  renderSide(best);
  drawTree();
});

/* ---------- 侧栏：人物 / 村志 ---------- */

function relLink(id) {
  const p = state.byId.get(id);
  return p ? `<span class="rel-link" data-id="${id}">${NameEngine.nameOf(id)} ${p.sex === "M" ? "♂" : "♀"}</span>` : "";
}

// 在世最长寿者 id（按 年份+人数 缓存，避免每次渲染全表扫描）
let _oldestCache = { key: "", id: null };
function oldestLivingId() {
  const y = state.snap.year;
  const key = `${y}:${state.snap.people.length}`;
  if (_oldestCache.key === key) return _oldestCache.id;
  let best = null, bestAge = -1;
  for (const q of state.snap.people) {
    if (q.death !== null || q.migrated || q.birth > y) continue;
    const age = y - q.birth;
    if (age > bestAge) { bestAge = age; best = q.id; }
  }
  _oldestCache = { key, id: best };
  return best;
}

function renderSide(id) {
  const side = $("side");
  if (id === null || !state.byId.has(id)) {
    side.innerHTML = `<div style="color:var(--dim)">点击谱系中的人物查看详情</div>`;
    return;
  }
  const p = state.byId.get(id);
  const curYear = state.snap.year;
  const alive = p.death === null && !p.migrated;
  const age = alive ? curYear - p.birth : (p.death ?? curYear) - p.birth;
  const kids = state.kidsCache.get(p.id) || [];
  const sons = kids.filter(k => state.byId.get(k)?.sex === "M").length;
  const daughters = kids.length - sons;
  // 一行小传：生卒/去向 + 配偶 + 子女构成
  let bio = `生于 y${p.birth}`;
  bio += p.migrated ? "，后离村远行" : p.death !== null ? `，卒于 y${p.death}` : "，现居村中";
  if (p.spouse !== null) bio += `，配 ${NameEngine.nameOf(p.spouse)}`;
  if (kids.length) bio += `，育 ${sons} 子 ${daughters} 女`;
  bio += alive ? `。现年 ${age} 岁。` : "。";
  const l = state.layout.get(p.id);
  side.innerHTML = `
    <h2><span class="person-sex-${p.sex}">${NameEngine.nameOf(p.id)} ${p.sex === "M" ? "♂" : "♀"}</span>
      <span style="color:var(--dim);font-size:11px">#${p.id}</span>
      ${p.lineage && p.father === null ? `<span class="tag lineage">始祖</span>` : ""}
      ${p.lineage && p.father !== null ? `<span class="tag lineage">血脉</span>` : ""}
      ${p.founder && !p.lineage ? `<span class="tag">创始</span>` : ""}
      ${p.migrated ? `<span class="tag">外迁</span>` : ""}
      ${oldestLivingId() === p.id && age >= 60 ? `<span class="tag honor">在世最长寿</span>` : ""}
      ${p.children_born >= 5 ? `<span class="tag honor">儿女满堂·${p.children_born}</span>` : ""}
      <button id="side-focus" class="side-focus" title="在谱系中定位此人并点亮直系">定位</button>
    </h2>
    <div class="bio">${bio}</div>
    <div class="kv">
      <span class="k">状态</span><span class="v">${p.migrated ? "外迁" : p.death !== null ? `卒于 y${p.death}` : "在世"}</span>
      <span class="k">年龄</span><span class="v">${age} 岁（生 y${p.birth}）</span>
      <span class="k">世代</span><span class="v">${l ? `第 ${l.gen} 代` : "?"}</span>
      <span class="k">生育力</span><span class="v">${Math.exp(p.ln_fertility || 0).toFixed(2)}×</span>
      <span class="k">脆弱度</span><span class="v">${Math.exp(p.ln_vulnerability || 0).toFixed(2)}×</span>
      <span class="k">终身生育</span><span class="v">${p.children_born}（含夭折）</span>
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
    // 亲属跳转 = 选中 + 聚焦定位（目标多半在视野外，不平移会像没反应）
    el.addEventListener("click", () => {
      state.selected = +el.dataset.id;
      renderSide(state.selected);
      focusPerson(state.selected);
    });
  });
  const focusBtn = $("side-focus");
  if (focusBtn) focusBtn.onclick = () => focusPerson(p.id);
}

/* ---------- 村志标签页与导出 ---------- */

function setSideTab(t) {
  state.sideTab = t;
  $("tab-detail").classList.toggle("on", t === "detail");
  $("tab-chronicle").classList.toggle("on", t === "chronicle");
  $("side").style.display = t === "detail" ? "" : "none";
  $("side-chronicle").hidden = t !== "chronicle";
  if (t === "chronicle") renderChronicle();
}

function renderChronicle() {
  const el = $("side-chronicle");
  // 村庄之最：从快照即时聚合（人口大时走 kidsCache 之外的单次线性扫描，开页才算）
  let elP = null, elAge = -1, pro = null;
  const surnameCount = new Map();
  const y = state.snap.year;
  for (const q of state.snap.people) {
    const age = q.death !== null ? q.death - q.birth : (!q.migrated ? y - q.birth : -1);
    if (age > elAge) { elAge = age; elP = q; }
    if (q.children_born > (pro?.children_born ?? -1)) pro = q;
    const s = q.name.slice(0, Math.max(1, q.surname_len || 1));
    surnameCount.set(s, (surnameCount.get(s) || 0) + 1);
  }
  let bigS = null, bigN = -1;
  for (const [s, n] of surnameCount) if (n > bigN) { bigN = n; bigS = s; }
  const gen = state.snap.stats?.max_lineage_gen ?? state.snap.max_lineage_gen ?? 0;
  const kv = (k, v) => `<div class="bk"><span>${k}</span><b>${v}</b></div>`;
  const bestHtml = `
    <div id="side-best">
      <h4>村庄之最</h4>
      <div class="best-grid">
        ${kv("史上最寿", elP ? `${NameEngine.nameOf(elP.id)}（${Math.max(0, elAge)} 岁）` : "—")}
        ${kv("儿女最多", pro && pro.children_born > 0 ? `${NameEngine.nameOf(pro.id)}（${pro.children_born} 胎）` : "—")}
        ${kv("第一大姓", bigS ? `${bigS} 氏 · 累计 ${bigN} 人` : "—")}
        ${kv("血脉世传", `第 ${gen} 代`)}
      </div>
    </div>`;
  const listHtml = state.chronicle.length
    ? state.chronicle.slice().reverse().map(c =>
        `<div class="cr"><span class="y">y${c.year}</span><span class="tx">${c.text}</span></div>`).join("")
    : `<div style="color:var(--dim)">尚无大事——推进世界，大事自会入志。</div>`;
  el.innerHTML = bestHtml + listHtml;
  $("side-wrap").scrollTop = 0;   // 新事在顶部，刷新后回到最新
}

function exportChronicle() {
  if (!state.chronicle.length) { flashToast("村志还是空的——先推进几年世界"); return; }
  const lines = state.chronicle.map(c => `y${c.year}\t${c.text}`);
  const header = `=== 村志 · seed ${state.worldSeed} · 共 ${state.chronicle.length} 条 ===\n`;
  const blob = new Blob([header + lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `村志_seed${state.worldSeed}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  flashToast("村志已导出");
}

$("tab-detail").addEventListener("click", () => setSideTab("detail"));
$("tab-chronicle").addEventListener("click", () => setSideTab("chronicle"));
$("btn-export-log").addEventListener("click", exportChronicle);

/* ---------- 图表 ---------- */

function setupCanvas(c) {
  const dpr = devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 清底 + 统一背景（避免"黑屏"观感：空图也有暗色面板底）
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/* 空数据占位：居中提示，代替黑屏 */
function drawPlaceholder(ctx, w, h, msg = "按播放后出现") {
  ctx.fillStyle = "#3a3d45";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(msg, w / 2, h / 2 + 4);
  ctx.strokeStyle = "#26282f";
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  ctx.setLineDash([]);
}

function drawPop() {
  const { ctx, w, h } = setupCanvas($("ch-pop"));
  const hist = state.snap.history;
  if (!hist.length) return drawPlaceholder(ctx, w, h);
  const pad = { l: 28, r: 4, t: 4, b: 14 };
  const maxY = Math.max(10, ...hist.map(r => r.pop)) * 1.05;
  const maxX = Math.max(1, hist[hist.length - 1].year);
  const X = y => pad.l + (y / maxX) * (w - pad.l - pad.r);
  const Y = v => h - pad.b - (v / maxY) * (h - pad.t - pad.b);
  ctx.strokeStyle = C.grid; ctx.fillStyle = C.dim; ctx.font = "9px sans-serif";
  for (let i = 0; i <= 2; i++) {
    const v = maxY * i / 2;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
    ctx.fillText(Math.round(v), 2, Y(v) + 3);
  }
  ctx.beginPath();
  hist.forEach((r, i) => i ? ctx.lineTo(X(r.year), Y(r.pop)) : ctx.moveTo(X(r.year), Y(r.pop)));
  ctx.lineTo(X(maxX), h - pad.b); ctx.lineTo(X(0), h - pad.b); ctx.closePath();
  ctx.fillStyle = "rgba(91,155,213,.15)"; ctx.fill();
  ctx.beginPath();
  hist.forEach((r, i) => i ? ctx.lineTo(X(r.year), Y(r.pop)) : ctx.moveTo(X(r.year), Y(r.pop)));
  ctx.strokeStyle = C.male; ctx.lineWidth = 1.4; ctx.stroke();
  const lmMax = Math.max(10, ...hist.map(r => r.lineage_male));
  const Y2 = v => h - pad.b - (v / lmMax) * (h - pad.t - pad.b);
  ctx.beginPath();
  hist.forEach((r, i) => i ? ctx.lineTo(X(r.year), Y2(r.lineage_male)) : ctx.moveTo(X(r.year), Y2(r.lineage_male)));
  ctx.strokeStyle = C.lineage; ctx.lineWidth = 1.6; ctx.stroke();
  if (state.snap.extinct_year !== null) {
    ctx.strokeStyle = C.red; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(state.snap.extinct_year), pad.t); ctx.lineTo(X(state.snap.extinct_year), h - pad.b); ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawPyramid() {
  const { ctx, w, h } = setupCanvas($("ch-pyr"));
  const cur = state.snap.year;
  let any = false;
  for (const p of state.snap.people) {
    if (p.death === null && !p.migrated && p.birth <= cur) { any = true; break; }
  }
  if (!any) return drawPlaceholder(ctx, w, h);
  const buckets = new Array(11).fill(0).map(() => [0, 0]); // [男,女] 10 岁一档
  for (const p of state.snap.people) {
    if (p.death !== null || p.migrated || p.birth > cur) continue;
    const age = Math.min(100, cur - p.birth);
    const b = Math.floor(age / 10);
    buckets[b][p.sex === "M" ? 0 : 1]++;
  }
  const max = Math.max(1, ...buckets.map(b => Math.max(b[0], b[1])));
  const mid = w / 2, bh = (h - 14) / 11;
  for (let i = 0; i < 11; i++) {
    const y = h - 14 - (i + 1) * bh;
    const [m, f] = buckets[i];
    const mw = (m / max) * (mid - 14), fw = (f / max) * (mid - 14);
    ctx.fillStyle = C.male; ctx.fillRect(mid - mw, y, mw, bh - 1);
    ctx.fillStyle = C.female; ctx.fillRect(mid, y, fw, bh - 1);
    ctx.fillStyle = C.dim; ctx.font = "8px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(`${i * 10}`, mid - 2, y + bh - 2);
  }
  ctx.textAlign = "center";
  ctx.fillStyle = C.dim; ctx.font = "9px sans-serif";
  ctx.fillText(`男 ←`, mid - 34, h - 4); ctx.fillText(`→ 女`, mid + 30, h - 4);
}

function drawEra() {
  const { ctx, w, h } = setupCanvas($("ch-era"));
  const bands = state.snap.era_bands || [];
  if (!bands.length) return drawPlaceholder(ctx, w, h);
  const pad = { l: 26, r: 30, t: 4, b: 14 };
  const maxY = Math.max(0.4, ...bands.map(b => b.birth_prob), ...bands.map(b => b.infant_mortality));
  const maxK = Math.max(...bands.map(b => b.carrying_capacity));
  const X = i => pad.l + (i / (bands.length - 1 || 1)) * (w - pad.l - pad.r);
  const Y = v => h - pad.b - (v / maxY) * (h - pad.t - pad.b);
  const Y2 = v => h - pad.b - (v / maxK) * (h - pad.t - pad.b);
  ctx.strokeStyle = C.grid; ctx.fillStyle = C.dim; ctx.font = "9px sans-serif";
  for (let i = 0; i <= 2; i++) {
    const v = maxY * i / 2;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
    ctx.fillText(v.toFixed(2), 2, Y(v) + 3);
  }
  ctx.beginPath();
  bands.forEach((b, i) => i ? ctx.lineTo(X(i), Y2(b.carrying_capacity)) : ctx.moveTo(X(i), Y2(b.carrying_capacity)));
  ctx.strokeStyle = C.green; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.beginPath();
  bands.forEach((b, i) => i ? ctx.lineTo(X(i), Y(b.infant_mortality)) : ctx.moveTo(X(i), Y(b.infant_mortality)));
  ctx.strokeStyle = C.red; ctx.lineWidth = 1.1; ctx.stroke();
  ctx.beginPath();
  bands.forEach((b, i) => i ? ctx.lineTo(X(i), Y(b.birth_prob)) : ctx.moveTo(X(i), Y(b.birth_prob)));
  ctx.strokeStyle = C.lineage; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.textAlign = "left";
  ctx.fillStyle = C.lineage; ctx.fillText("生育p", 3, 10);
  ctx.fillStyle = C.red; ctx.fillText("夭折", 42, 10);
  ctx.fillStyle = C.green; ctx.fillText("K", 70, 10);
}

/* 人口流量：净增长分解（生 - 死 ± 迁移）——绝对量小，改相对视角
   上层：年度净变化柱（正绿负红）+ 5 年滚动均线
   底层：出生/死亡双细线做背景参照 */
function drawFlow() {
  const { ctx, w, h } = setupCanvas($("ch-flow"));
  const hist = state.snap.history.filter(r => r.born !== undefined);
  if (!hist.length) return drawPlaceholder(ctx, w, h);
  const pad = { l: 24, r: 4, t: 10, b: 12 };
  const win = hist.slice(-120);
  const f = v => v ?? 0;
  const net = r => f(r.born) - f(r.died) + f(r.immigrated) - f(r.emigrated);
  const maxY = Math.max(4, ...win.map(r => Math.abs(net(r))));
  const mid = pad.t + (h - pad.t - pad.b) / 2;
  const half = (h - pad.t - pad.b) / 2;
  const Y = v => mid - (v / maxY) * half;
  const bw = (w - pad.l - pad.r) / win.length;
  // 零线
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.l, mid); ctx.lineTo(w - pad.r, mid); ctx.stroke();
  ctx.fillStyle = C.dim; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`+${maxY}`, 2, mid - half + 8);
  ctx.fillText(`−${maxY}`, 2, mid + half);
  // 出生/死亡背景参照（细线，半透明）
  const bMax = Math.max(4, ...win.map(r => Math.max(f(r.born), f(r.died))));
  const Yb = v => mid - (v / bMax) * half;
  const line = (get, color) => {
    ctx.beginPath();
    win.forEach((r, i) => i ? ctx.lineTo(pad.l + i * bw + bw / 2, Yb(get(r)))
                            : ctx.moveTo(pad.l + i * bw + bw / 2, Yb(get(r))));
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
  };
  line(r => f(r.born), "rgba(91,155,213,.4)");
  line(r => f(r.died), "rgba(74,77,85,.7)");
  // 净变化柱
  win.forEach((r, i) => {
    const v = net(r);
    const x = pad.l + i * bw + bw / 2;
    ctx.fillStyle = v >= 0 ? "rgba(127,191,143,.85)" : "rgba(224,85,85,.85)";
    const y0 = Y(Math.max(0, v)), y1 = Y(Math.min(0, v));
    ctx.fillRect(x - Math.max(0.6, bw / 2 - 0.5), y0, Math.max(1.2, bw - 1), Math.max(1, y1 - y0));
    if (r.wave) {  // 迁出潮年标记
      ctx.fillStyle = C.red;
      ctx.fillRect(x - Math.max(0.6, bw / 2 - 0.5), pad.t - 6, Math.max(1.2, bw - 1), 3);
    }
  });
  // 5 年滚动均线
  ctx.beginPath();
  let acc = 0;
  win.forEach((r, i) => {
    acc += net(r);
    if (i >= 5) acc -= net(win[i - 5]);
    const ma = acc / Math.min(i + 1, 5);
    const x = pad.l + i * bw + bw / 2;
    i ? ctx.lineTo(x, Y(ma)) : ctx.moveTo(x, Y(ma));
  });
  ctx.strokeStyle = C.lineage; ctx.lineWidth = 1.6; ctx.stroke();
  // 图例
  ctx.textAlign = "left"; ctx.font = "9px sans-serif";
  ctx.fillStyle = "rgba(127,191,143,1)"; ctx.fillText("净增", 26, 8);
  ctx.fillStyle = "rgba(224,85,85,1)"; ctx.fillText("净减", 44, 8);
  ctx.fillStyle = C.lineage; ctx.fillText("5年均线", 62, 8);
  ctx.fillStyle = "rgba(91,155,213,.8)"; ctx.fillText("出生(参照)", 102, 8);
}

/* 累计迁移：迁入累计（蓝）+ 迁出累计（金）+ 净迁移累计（绿）三轨 + 潮年事件条
   解决"看不到变化"：累计曲线从 0 出发的斜率变化即迁移强度 */
function drawMig() {
  const { ctx, w, h } = setupCanvas($("ch-mig"));
  const hist = state.snap.history.filter(r => r.born !== undefined);
  if (!hist.length) return drawPlaceholder(ctx, w, h);
  const pad = { l: 24, r: 4, t: 12, b: 12 };
  const f = v => v ?? 0;
  let cumOut = 0, cumIn = 0, cumNet = 0;
  const series = hist.map(r => {
    cumOut += f(r.emigrated);
    cumIn += f(r.immigrated);
    cumNet = cumIn - cumOut;
    return { year: r.year, out: cumOut, in: cumIn, net: cumNet, wave: r.wave };
  });
  const lo = Math.min(0, ...series.map(s => s.net));
  const hi = Math.max(1, ...series.map(s => s.out), ...series.map(s => s.in), ...series.map(s => s.net));
  const maxX = Math.max(1, hist[hist.length - 1].year);
  const X = y => pad.l + (y / maxX) * (w - pad.l - pad.r);
  const Y = v => h - pad.b - ((v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  // 网格
  ctx.strokeStyle = C.grid; ctx.fillStyle = C.dim; ctx.font = "9px sans-serif";
  for (let i = 0; i <= 2; i++) {
    const v = lo + (hi - lo) * i / 2;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillText(Math.round(v), 2, Y(v) + 3);
  }
  // 零线（净迁移为 0 处）
  if (lo < 0) {
    ctx.strokeStyle = "#4a4d55";
    ctx.beginPath(); ctx.moveTo(pad.l, Y(0)); ctx.lineTo(w - pad.r, Y(0)); ctx.stroke();
  }
  // 迁入累计（蓝色）
  ctx.beginPath();
  series.forEach((s, i) => i ? ctx.lineTo(X(s.year), Y(s.in)) : ctx.moveTo(X(s.year), Y(s.in)));
  ctx.strokeStyle = "#5b9bd5"; ctx.lineWidth = 1.4; ctx.stroke();
  // 迁出累计（金色阶梯）
  ctx.beginPath();
  series.forEach((s, i) => i ? ctx.lineTo(X(s.year), Y(s.out)) : ctx.moveTo(X(s.year), Y(s.out)));
  ctx.strokeStyle = "#c9a15f"; ctx.lineWidth = 1.6; ctx.stroke();
  // 净迁移累计（绿色）
  ctx.beginPath();
  series.forEach((s, i) => i ? ctx.lineTo(X(s.year), Y(s.net)) : ctx.moveTo(X(s.year), Y(s.net)));
  ctx.strokeStyle = C.green; ctx.lineWidth = 1.4; ctx.stroke();
  // 潮年事件条（顶部红条 + 迁出线上的点）
  ctx.fillStyle = C.red;
  for (const s of series) {
    if (s.wave) {
      ctx.fillRect(X(s.year) - 1, pad.t - 8, 2, 5);
      ctx.beginPath(); ctx.arc(X(s.year), Y(s.out), 2.5, 0, TAU); ctx.fill();
    }
  }
  // 图例
  ctx.textAlign = "left"; ctx.font = "9px sans-serif";
  ctx.fillStyle = "#5b9bd5"; ctx.fillText(`迁入 ${cumIn}`, 26, 10);
  ctx.fillStyle = "#c9a15f"; ctx.fillText(`迁出 ${cumOut}`, 76, 10);
  ctx.fillStyle = C.green; ctx.fillText(`净 ${cumNet}`, 126, 10);
}

/* 死亡率曲线：当前年的年龄→年死亡概率（对数 Y 轴更直观） */
function drawMort() {
  const c = $("ch-mort");
  if (!c) return;
  const { ctx, w, h } = setupCanvas(c);
  const mc = state.snap.mortality_curve;
  if (!mc || !mc.curve || !mc.curve.length) return drawPlaceholder(ctx, w, h, "推进后出现");
  const pad = { l: 30, r: 6, t: 10, b: 14 };
  const qs = mc.curve.map(d => d.q).filter(q => q > 0);
  const lo = Math.log10(Math.max(1e-5, Math.min(...qs)));
  const hi = Math.log10(Math.max(0.5, Math.max(...qs)));
  const maxAge = Math.max(...mc.curve.map(d => d.age));
  const X = a => pad.l + (Math.log10(a + 1) / Math.log10(maxAge + 1)) * (w - pad.l - pad.r);
  const Y = q => h - pad.b - ((Math.log10(Math.max(q, 1e-5)) - lo) / (hi - lo)) * (h - pad.t - pad.b);
  // 网格（10 的幂）
  ctx.strokeStyle = C.grid; ctx.fillStyle = C.dim; ctx.font = "8px sans-serif";
  for (let p = Math.ceil(lo); p <= Math.floor(hi); p++) {
    const y = Y(10 ** p);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.textAlign = "left";
    const lbl = p >= -2 ? (10 ** p).toFixed(2) : (10 ** p).toExponential(0);
    ctx.fillText(lbl, 2, y + 3);
  }
  for (const a of [0, 10, 30, 60, 90]) {
    ctx.textAlign = "center";
    ctx.fillText(a, X(a), h - 4);
  }
  // 曲线 + 填充
  ctx.beginPath();
  mc.curve.forEach((d, i) => i ? ctx.lineTo(X(d.age), Y(d.q)) : ctx.moveTo(X(d.age), Y(d.q)));
  ctx.strokeStyle = C.red; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.lineTo(X(maxAge), h - pad.b);
  ctx.lineTo(X(0), h - pad.b);
  ctx.closePath();
  ctx.fillStyle = "rgba(224,85,85,.15)"; ctx.fill();
  // 标注
  ctx.textAlign = "left"; ctx.font = "9px sans-serif";
  ctx.fillStyle = C.red;
  const modeTxt = { transition: "过渡", ancient: "恒古代", modern: "恒现代" }[mc.mode] || mc.mode;
  ctx.fillText(`×${mc.scale.toFixed(2)}（时期乘数）· ${modeTxt}`, pad.l, 8);
}

/* 时艰度 hardship */
function drawHardship() {
  const { ctx, w, h } = setupCanvas($("ch-hard"));
  const bands = state.snap.era_bands || [];
  if (!bands.length || bands[0].hardship === undefined)
    return drawPlaceholder(ctx, w, h, "时期参数待生成");
  const pad = { l: 26, r: 4, t: 6, b: 14 };
  const X = i => pad.l + (i / (bands.length - 1 || 1)) * (w - pad.l - pad.r);
  const Y = v => h - pad.b - (v / 1.0) * (h - pad.t - pad.b);
  ctx.strokeStyle = C.grid; ctx.fillStyle = C.dim; ctx.font = "9px sans-serif";
  ctx.beginPath(); ctx.moveTo(pad.l, Y(0)); ctx.lineTo(w - pad.r, Y(0)); ctx.stroke();
  ctx.fillText("0", 2, Y(0) + 3); ctx.fillText("1.0", 2, Y(1.0) + 3);
  // 填充面积
  ctx.beginPath();
  bands.forEach((b, i) => i ? ctx.lineTo(X(i), Y(b.hardship)) : ctx.moveTo(X(i), Y(b.hardship)));
  ctx.lineTo(X(bands.length - 1), Y(0)); ctx.lineTo(X(0), Y(0)); ctx.closePath();
  ctx.fillStyle = "rgba(224,85,85,.2)"; ctx.fill();
  ctx.beginPath();
  bands.forEach((b, i) => i ? ctx.lineTo(X(i), Y(b.hardship)) : ctx.moveTo(X(i), Y(b.hardship)));
  ctx.strokeStyle = C.red; ctx.lineWidth = 1.4; ctx.stroke();
  const avg = bands.reduce((s, b) => s + b.hardship, 0) / bands.length;
  ctx.textAlign = "left"; ctx.fillStyle = C.dim;
  ctx.fillText(`均值 ${avg.toFixed(2)} —— 越高越容易触发迁出潮`, 2, 10);
}

/* ---------- 时间轴（时期带着色 + 断绝标记 + 点击跳跃） ---------- */

const tl = $("timeline");

function drawTimeline() {
  const { ctx, w, h } = setupCanvas(tl);
  const params = state.snap.params;
  const total = params ? params.end_year : 1000;
  const cur = state.snap.year;
  // 时期带底色：按生育概率着色（绿肥红瘦）
  const bands = state.snap.era_bands || [];
  const X = y => (y / total) * (w - 2) + 1;
  if (bands.length) {
    const bMin = Math.min(...bands.map(b => b.birth_prob));
    const bMax = Math.max(...bands.map(b => b.birth_prob));
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      const t = (b.birth_prob - bMin) / (bMax - bMin || 1);
      const nextStart = (i + 1 < bands.length) ? bands[i + 1].start_year : b.start_year + params.band_years;
      ctx.fillStyle = `rgba(${Math.round(224 - t * 130)},${Math.round(85 + t * 100)},${Math.round(85 + t * 30)},.45)`;
      ctx.fillRect(X(b.start_year), 8, Math.max(2, X(nextStart) - X(b.start_year)), h - 22);
    }
  }
  // 人口迷你曲线（灰）
  const hist = state.snap.history;
  if (hist.length > 1) {
    const maxP = Math.max(...hist.map(r => r.pop));
    ctx.beginPath();
    hist.forEach((r, i) => i ? ctx.lineTo(X(r.year), h - 12 - (r.pop / maxP) * (h - 24)) : ctx.moveTo(X(r.year), h - 12 - (r.pop / maxP) * (h - 24)));
    ctx.strokeStyle = "rgba(220,222,228,.5)"; ctx.lineWidth = 1; ctx.stroke();
  }
  // 血脉男丁线（金）
  const lmMax = Math.max(5, ...hist.map(r => r.lineage_male));
  ctx.beginPath();
  hist.forEach((r, i) => i ? ctx.lineTo(X(r.year), h - 12 - (r.lineage_male / lmMax) * (h - 24)) : ctx.moveTo(X(r.year), h - 12 - (r.lineage_male / lmMax) * (h - 24)));
  ctx.strokeStyle = C.lineage; ctx.lineWidth = 1.6; ctx.stroke();
  // 当前时间游标
  ctx.fillStyle = "#fff";
  ctx.fillRect(X(cur) - 1, 4, 2, h - 12);
  ctx.fillStyle = C.dim; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`y${cur} / ${total}`, 4, 11);
  // 断绝标记：文字放底部并夹在画布内，避免与左上角年份/游标重叠
  if (state.snap.extinct_year !== null) {
    ctx.fillStyle = C.red;
    ctx.fillRect(X(state.snap.extinct_year) - 1, 4, 2, h - 12);
    ctx.textAlign = "center";
    const lx = Math.min(Math.max(X(state.snap.extinct_year), 30), w - 30);
    ctx.fillText("血脉断绝", lx, h - 3);
  }
}

/* 点击时间轴 → 提示无法回溯（模拟无历史回滚），或跳过提示 */
tl.addEventListener("click", e => {
  const r = tl.getBoundingClientRect();
  const frac = (e.clientX - r.left) / r.width;
  const target = Math.round(frac * (state.snap.params ? state.snap.params.end_year : 1000));
  if (target <= state.snap.year) {
    flashToast("时间不能倒流 —— 只能奔向未来");
    return;
  }
  jumpTo(target);
});

function flashToast(msg) {
  const el = document.createElement("div");
  el.textContent = msg;
  // 居中显示：避开顶部时间轴与左列图表
  el.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--panel2);"
    + "border:1px solid var(--line);border-radius:8px;padding:8px 18px;z-index:99;color:var(--fg);font-size:13px;";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

/* 断绝操作卡：常驻树画布顶部，提供"继续观察 / 再开新世界"两个出口 */
function showExtinctCard(year) {
  setPlay(false);
  const wrap = treeCanvas.parentElement;
  const old = wrap.querySelector(".extinct-card");
  if (old) old.remove();
  const el = document.createElement("div");
  el.className = "extinct-card";
  el.innerHTML = `<div class="tx">☠ 血脉断绝于 y${year} · ${reasonZh(state.snap.extinct_reasons)}</div>`
    + `<div class="ec-btns"><button id="ec-watch">继续观察村庄</button>`
    + `<button id="ec-again">✦ 再开新世界</button></div>`;
  wrap.appendChild(el);
  $("ec-watch").onclick = () => el.remove();
  $("ec-again").onclick = () => {
    const seed = state.worldSeed + 1;
    el.remove();
    newWorld(seed, state.worldOverrides, state.worldFounder);
    flashToast(`已开启新世界 seed=${seed}（参数与始祖姓名不变）`);
  };
}

/* ---------- 数据流：new / step / 快照同步 ---------- */

function ingestSnapshot(snap) {
  state.snap = snap;
  state.byId = new Map(snap.people.map(p => [p.id, p]));
  state.selected = null;
  NameEngine.setPeople(snap.people);
  relayoutIfNeeded();
  fitView();
  redrawAll();
}

function redrawAll() {
  eraChip();
  if (state.snap.stats) updateStats(state.snap.stats);
  drawPop(); drawFlow(); drawMig(); drawPyramid(); drawSurnames(); drawEra(); drawMort(); drawHardship();
  drawTimeline(); drawTree();
  renderSide(state.selected);
}

function mergeStep(resp) {
  const snap = state.snap;
  snap.year = resp.year;
  // history_tail 可能与已有重叠：以年份去重合并
  for (const row of resp.history_tail || []) {
    if (!snap.history.length || row.year > snap.history[snap.history.length - 1].year) {
      snap.history.push(row);
    }
  }
  for (const b of resp.era_new || []) {
    // 去重合并（以 band 号为准）
    if (!snap.era_bands.some(x => x.band === b.band)) snap.era_bands.push(b);
  }
  if (resp.delta_people) {
    for (const p of resp.delta_people) {
      const old = state.byId.get(p.id);
      if (old) Object.assign(old, p);
      else { snap.people.push(p); state.byId.set(p.id, p); }
      NameEngine.upsertPerson(state.byId.get(p.id));
    }
    // 新生者先入布局再闪光，否则拿不到坐标、闪光永远不出现
    relayoutIfNeeded();
    flashBirths(resp.delta_people.filter(p => state.byId.get(p.id).death === null));
  }
  if (resp.world_events?.length) appendEvents(resp.world_events);
  if (resp.extinct_year !== null && snap.extinct_year === null) {
    snap.extinct_year = resp.extinct_year;
    snap.extinct_reasons = resp.extinct_reasons;
    showExtinctCard(resp.extinct_year);
  }
  snap.stats = resp.stats;
  if (resp.mortality_curve) snap.mortality_curve = resp.mortality_curve;
  if (resp.termination && resp.termination !== "EXTINCT_BLOOD") state.finished = true;
  // 元系统钩子：成就判定 / 自动存档
  if (window.Meta) Meta.gameTick({ events: resp.world_events || [] });
}

function updateBusyUi() {
  $("btn-step").classList.toggle("busy", state.busy);
  $("btn-10").classList.toggle("busy", state.busy);
  $("btn-10").textContent = state.pendingYears > 0 ? `+10 年（队 ${state.pendingYears}）` : "+10 年";
}

async function stepYears(n) {
  if (!state.snap) return;
  if (state.busy) {
    // 忙时点击不再丢弃：累计年数，本批跑完后自动补跑
    state.pendingYears = Math.min(200, state.pendingYears + n);
    updateBusyUi();
    return;
  }
  state.busy = true;
  updateBusyUi();
  try {
    let want = Math.min(200, n);
    while (want > 0 && !state.finished) {
      const batch = Math.min(want, 50);
      const resp = await api("/api/step", { years: batch });
      if (resp.error) { stopPlay(); return; }
      mergeStep(resp);
      want -= batch;
      // 吸收排队期间的新点击
      if (state.pendingYears > 0) {
        want = Math.min(200, want + state.pendingYears);
        state.pendingYears = 0;
      }
    }
    state.pendingYears = 0;
    relayoutIfNeeded();
    redrawAll();
  } finally {
    state.busy = false;
    updateBusyUi();
  }
  // 排队兜底：最后一批等待期间又有点击进来
  if (state.pendingYears > 0 && !state.finished) {
    const extra = state.pendingYears;
    state.pendingYears = 0;
    await stepYears(extra);
  }
}

async function jumpTo(year) {
  setPlay(false);
  const batch = 25;
  while (state.snap && state.snap.year < year && !state.finished) {
    await stepYears(Math.min(batch, year - state.snap.year));
  }
  // 断绝后继续跳（观察全村）
  while (state.snap && state.snap.year < year) {
    await stepYears(Math.min(batch, year - state.snap.year));
  }
}

async function newWorld(seed, overrides, founder) {
  setPlay(false);
  state.finished = false;
  state.pendingYears = 0;
  state.worldSeed = seed;
  state.worldOverrides = overrides || {};
  state.worldFounder = founder || null;
  state.chronicle = [];
  state.hlSet = new Set();
  const card = treeCanvas.parentElement.querySelector(".extinct-card");
  if (card) card.remove();
  $("feed-list").innerHTML = "";
  $("feed-new").hidden = true;
  const snap = await api("/api/new", {
    seed, overrides,
    founder_surname: founder?.surname || "",
    founder_given: founder?.given || "",
  });
  if (snap && snap.error) { flashToast(snap.error); return; }
  serverHasWorld = true;
  ingestSnapshot(snap);
  // 元系统：登记世界上下文（成就/自动存档从此续算），并收起封面
  if (window.Meta) Meta.worldStarted(seed, overrides || {}, founder || null);
  // 注意：不手动造"踏入新纪"——世界首步自会发出 y0 纪元事件，手造会重复入志
}

/* ---------- 播放控制 ---------- */

function setPlay(on) {
  state.playing = on;
  $("btn-play").textContent = on ? "⏸ 暂停" : "▶ 播放";
  $("btn-play").classList.toggle("primary", !on);
  clearInterval(state.timer);
  if (on) {
    state.timer = setInterval(async () => {
      if (!state.busy && !state.finished) await stepYears(1);
      else if (state.finished) setPlay(false);
    }, state.speedMs);
  }
}

$("btn-play").addEventListener("click", () => setPlay(!state.playing));
$("btn-step").addEventListener("click", () => stepYears(1));
$("btn-10").addEventListener("click", () => stepYears(10));
$("tt-zin").addEventListener("click", () => zoomBy(1.3));
$("tt-zout").addEventListener("click", () => zoomBy(1 / 1.3));
$("tt-fit").addEventListener("click", () => fitView());
$("tt-lineage").addEventListener("click", () => fitLineage());
$("tt-selected").addEventListener("click", () => {
  if (state.selected !== null) focusPerson(state.selected);
  else flashToast("先在谱系中点选一个人");
});
$("feed-new").addEventListener("click", () => {
  const feed = $("feed");
  feed.scrollTop = feed.scrollHeight;
  $("feed-new").hidden = true;
});
$("speed-group").addEventListener("click", e => {
  const btn = e.target.closest("button");
  if (!btn) return;
  state.speedMs = +btn.dataset.ms;
  $("speed-group").querySelectorAll("button").forEach(b => b.classList.toggle("on", b === btn));
  if (state.playing) setPlay(true);  // 重启定时器
});
addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  // 封面或对话框打开时，不抢占空格/方向键
  if (document.querySelector(".cover:not(.gone)") || document.querySelector("dialog[open]")) return;
  if (e.code === "Space") { e.preventDefault(); setPlay(!state.playing); }
  else if (e.code === "ArrowRight") stepYears(e.shiftKey ? 10 : 1);
});

/* ---------- 新世界对话框 ---------- */

const dlg = $("dlg-new");
$("btn-new").addEventListener("click", () => dlg.showModal());
$("dlg-cancel").addEventListener("click", () => dlg.close());
$("dlg-go").addEventListener("click", () => {
  const overrides = {
    founder_village_size: +$("in-village").value,
    parity_cap_base: +$("in-cap").value,
    ban_kin_side: +$("in-kin").value,
    anchor_mode: $("in-anchor").value,
    era_k_mean: +$("in-k").value,
  };
  const fert = +$("in-fert").value, mort = +$("in-mort").value;
  if (fert !== 1.0) overrides.era_log_birth_mean = Math.log(0.25 * fert);
  if (mort !== 1.0) overrides.era_adult_mort_scale_mean = mort;
  const waveP = +$("in-hardship").value;
  if (waveP !== 0.08) overrides.hardship_wave_prob = waveP;
  const match = $("in-match").value;
  if (match !== "none") overrides.matchmaking_per_year = +match;
  const prot = +$("in-prot").value;
  if (prot !== 1.0) overrides.lineage_emigration_protect = prot;
  // 创始者姓名：留空随机；填了则校验汉字格式
  const fsur = $("in-fsurname").value.trim(), fgiv = $("in-fgiven").value.trim();
  const reHanSur = /^[\u4e00-\u9fa5]{1,2}$/, reHanGiv = /^[\u4e00-\u9fa5]{1,2}$/;
  if ((fsur || fgiv) && !(reHanSur.test(fsur) && reHanGiv.test(fgiv))) {
    $("fname-err-tx").textContent = "姓名需为汉字：姓 1-2 字、名 1-2 字（或都留空随机起名）";
    $("fname-err-row").hidden = false;
    return;   // 不关对话框，留在输入处修正
  }
  $("fname-err-row").hidden = true;
  dlg.close();
  newWorld(+$("in-seed").value, overrides, { surname: fsur, given: fgiv });
});

addEventListener("resize", () => { if (state.snap) redrawAll(); });

/* ---------- 元系统接线（封面 / 存档 / 成就 / 设置） ---------- */

let serverHasWorld = false;   // 本会话内服务器是否有活世界（续游戏优先走它）

// 给元系统的存档数据体：种子+参数+年份 的完整恢复凭据，附统计快照
function collectSaveData() {
  if (!state.snap) return null;
  const s = state.snap;
  let maxKids = 0, oldest = 0;
  for (const p of s.people) {
    if ((p.children_born || 0) > maxKids) maxKids = p.children_born;
    const endAge = p.death !== null ? p.death
      : (!p.migrated && p.birth <= s.year ? s.year : null);
    if (endAge !== null && endAge - p.birth > oldest) oldest = endAge - p.birth;
  }
  const founderP = s.people.find(p => p.lineage && p.father === null);
  const bloodName = founderP
    ? founderP.name.slice(0, Math.max(1, founderP.surname_len || 1)) : "";
  // 世界元信息以 Meta._run 为准（「继续游戏」不经过 newWorld，state.worldSeed 不可靠）
  const run = (window.Meta && Meta._run) || {};
  return {
    format: "family-sim-save", version: 1,
    world: {
      seed: run.seed ?? state.worldSeed,
      overrides: run.overrides ?? (state.worldOverrides || {}),
      founder: run.founder ?? (state.worldFounder || null),
      bloodName,
    },
    year: s.year,
    stats: Object.assign({}, s.stats || {}, {
      max_kids: maxKids, oldest_age: oldest,
      end_year: s.params?.end_year ?? 1000,
    }),
    outcome: {
      extinct_year: s.extinct_year ?? null,
      reasons: s.extinct_reasons || [],
      finished: !!state.finished,
    },
  };
}

/* 应用设置里的「默认播放速度」 */
function applySettings(st) {
  if (!st || !st.speedMs) return;
  state.speedMs = +st.speedMs;
  $("speed-group").querySelectorAll("button")
    .forEach(b => b.classList.toggle("on", +b.dataset.ms === state.speedMs));
  if (state.playing) setPlay(true);
}

/* 读档 = 确定性重放：新世界 → 快进到存档年份，逐字节还原 */
async function restoreFromSave(data) {
  if (!data || !data.world) return;
  const seed = Math.max(0, Math.floor(+data.world.seed || 42));
  const overrides = window.Meta
    ? Meta.sanitizeOverrides(data.world.overrides) : (data.world.overrides || {});
  await newWorld(seed, overrides, data.world.founder || null);
  if (!state.snap) return;
  const targetYear = Math.max(0, Math.min(Math.floor(+data.year || 0),
                                          state.snap.params.end_year || 1000));
  if (state.snap.year < targetYear) await jumpTo(targetYear);
  redrawAll();
}

/* 封面「开始游戏」：服务器活世界直接回；否则重放最新自动存档 */
async function enterContinue() {
  document.querySelector("#cover")?.classList.add("gone");
  if (serverHasWorld && state.snap) {
    // state.worldSeed 等已在启动探测时从快照 world_meta 对齐
    if (window.Meta) Meta.worldStarted(state.worldSeed, state.worldOverrides, state.worldFounder);
    serverHasWorld = true;
    return;
  }
  const auto = window.Meta ? Meta.latestAuto() : null;
  if (auto) { await restoreFromSave(auto.data); return; }
  $("dlg-new").showModal();
}

if (window.Meta) {
  Meta.host = {
    hasServerWorld: () => serverHasWorld,
    isPlaying: () => !!state.snap && !document.querySelector("#cover:not(.gone)"),
    getSaveData: collectSaveData,
    enterGame: enterContinue,
    enterSave: entry => restoreFromSave(entry.data),
    goCover: () => {
      setPlay(false);
      document.querySelector("#cover")?.classList.remove("gone");
      if (window.Meta) Meta.refreshCoverInfo();
    },
  };
  Meta.onSettingsChanged = applySettings;
}

/* ---------- 启动 ---------- */

(async () => {
  if (window.Meta) applySettings(Meta.settings);
  const snap = await api("/api/snapshot");
  if (snap && !snap.error && snap.people?.length) {
    // 服务器带着世界创建凭据（seed/参数/始祖）——对齐后再预热，点「开始游戏」可瞬时回场
    const wm = snap.world_meta || {};
    state.worldSeed = wm.seed ?? state.worldSeed;
    state.worldOverrides = wm.overrides || {};
    state.worldFounder = wm.founder || null;
    ingestSnapshot(snap);
    serverHasWorld = true;
    if (window.Meta) { Meta._bootServerWorld = true; Meta.refreshCoverInfo(); }
  } else {
    if (window.Meta) Meta.refreshCoverInfo();
  }
})();
