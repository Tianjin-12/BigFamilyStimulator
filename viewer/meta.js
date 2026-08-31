/* 元系统：封面 / 设置 / 成就殿堂 / 存档馆（JSON 导出导入 + 总览统计）+ 分享图。
   与 live.js 解耦：live.js 在启动后注入 Meta.host = {enterGame, enterSave,
   goCover, isPlaying, getSaveData}；本文件自足，不直接引用游戏内部状态。
   存储：localStorage（键前缀 fjs1_*）。存档本体只含「种子+参数+年份」，
   读档靠确定性重放逐字节还原——文件极小、天然跨设备可分享。 */
"use strict";

(() => {

/* ---------- 工具 ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad2 = n => String(n).padStart(2, "0");
const fmtDT = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtShort = ts => {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const jget = (path, body) => fetch(path, {
  method: body ? "POST" : "GET",
  headers: { "Content-Type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
}).then(r => r.json());
function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

/* 存储层：损坏时静默回退默认值 */
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const v = JSON.parse(raw);
      return v ?? fallback;
    } catch { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch { toast(`⚠ 本地存储写入失败（可能已满）`); return false; }
  },
};

/* ---------- 成就定义（10 枚，全部单局内可达） ----------
   阈值取「跳一跳够得着」：即爽 2 枚 → 短线 3 枚 → 中线 3 枚 → 长线 2 枚 */
const ACHV = [
  { id: "first_world", icon: "✦", name: "开天辟地", tier: 1,
    desc: "创造第一个属于你的世界" },
  { id: "first_birth", icon: "🌱", name: "初见添丁", tier: 1,
    desc: "首次见证血脉新丁呱呱坠地" },
  { id: "males5", icon: "🔥", name: "人丁兴旺", tier: 2,
    desc: "在世血脉男丁同时达到 5 人",
    prog: c => [Math.min(c.males, 5), 5] },
  { id: "kids8", icon: "👶", name: "儿孙满堂", tier: 2,
    desc: "一位村民一生育有 8 个孩子",
    prog: c => [Math.min(c.maxKids, 8), 8] },
  { id: "pop500", icon: "🏮", name: "烟火万家", tier: 2,
    desc: "村庄人口突破 500 人",
    prog: c => [Math.min(c.pop, 500), 500] },
  { id: "gen5", icon: "🌳", name: "开枝散叶", tier: 3,
    desc: "血脉传承绵延至第 5 代",
    prog: c => [Math.min(c.gen, 5), 5] },
  { id: "elder90", icon: "🧓", name: "松鹤延年", tier: 3,
    desc: "村中出现享年 90 岁以上的高寿者",
    prog: c => [Math.min(c.oldest, 90), 90] },
  { id: "y100", icon: "🏛", name: "百年望族", tier: 4,
    desc: "血脉延续满一百年而不坠",
    prog: c => c.alive ? [Math.min(c.year, 100), 100] : null },
  { id: "y300", icon: "⛩️", name: "三百世家", tier: 4,
    desc: "血脉延续满三百年而不坠",
    prog: c => c.alive ? [Math.min(c.year, 300), 300] : null },
  { id: "fulltime", icon: "♾️", name: "生生不息", tier: 4,
    desc: "历尽千年沧桑，血脉撑到时间尽头仍未断绝",
    prog: c => c.alive ? [Math.min(c.year, c.endYear), c.endYear] : null },
];
const ACHV_KEY = "fjs1_achievements";
const AchvStore = {
  data: store.get(ACHV_KEY, { v: 1, unlocked: {} }),
  isUnlocked(id) { return !!this.data.unlocked[id]; },
  count() { return Object.keys(this.data.unlocked).length; },
  unlock(id) {
    if (this.isUnlocked(id)) return false;
    this.data.unlocked[id] = Date.now();
    store.set(ACHV_KEY, this.data);
    return true;
  },
  clear() { this.data = { v: 1, unlocked: {} }; store.set(ACHV_KEY, this.data); },
};

/* ---------- 设置 ---------- */
const SET_KEY = "fjs1_settings";
const DEFAULT_SETTINGS = {
  speedMs: 240,        // 默认播放速度
  flashBirths: true,   // 谱系出生闪光
  achToasts: true,     // 成就解锁弹窗
  autosaveEvery: 50,   // 自动存档间隔年（0=关）
};
const Settings = {
  data: Object.assign({}, DEFAULT_SETTINGS, store.get(SET_KEY, {})),
  save() { store.set(SET_KEY, this.data); if (Meta.onSettingsChanged) Meta.onSettingsChanged(this.data); },
};

/* ---------- 存档馆 ---------- */
const SAVE_KEY = "fjs1_saves";
const KNOWN_OVERRIDES = [
  "founder_village_size", "parity_cap_base", "ban_kin_side", "anchor_mode",
  "era_k_mean", "era_log_birth_mean", "era_adult_mort_scale_mean",
  "hardship_wave_prob", "matchmaking_per_year", "lineage_emigration_protect",
];
// 只保留已知参数键并做类型净化；未知键丢弃（他人存档可能是不同版本）
function sanitizeOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of KNOWN_OVERRIDES) {
    if (k in raw) {
      const v = raw[k];
      if (k === "anchor_mode" && typeof v === "string") out[k] = v;
      else if (typeof v === "number" && isFinite(v)) out[k] = v;
    }
  }
  return out;
}

const SaveStore = {
  list: store.get(SAVE_KEY, []),
  persist() { store.set(SAVE_KEY, this.list.slice(0, 60)); },
  upsert(saveObj) {
    const i = this.list.findIndex(s => s.id === saveObj.id);
    if (i >= 0) this.list[i] = saveObj;
    else this.list.unshift(saveObj);
    // 自动存档按世界分槽（互不覆盖），只留最近 3 份
    if (saveObj.auto) {
      const autos = this.list.filter(s => s.auto)
        .sort((a, b) => b.savedAt - a.savedAt);
      for (const old of autos.slice(3)) this.remove(old.id);
    }
    this.persist();
  },
  remove(id) { this.list = this.list.filter(s => s.id !== id); this.persist(); },
  clear() { this.list = []; this.persist(); },
  latestAuto() {
    return this.list.filter(s => s.auto).sort((a, b) => b.savedAt - a.savedAt)[0] || null;
  },
  newest() { return this.list[0] || null; },
};

/* 把一个「存档数据体」变成完整槽位对象 */
function makeSaveEntry(data, opts = {}) {
  const w = data.world || {};
  const blood = w.bloodName ? `${w.bloodName}氏` : "某姓";
  const name = opts.name ||
    `${opts.auto ? "自动存档 · " : ""}${blood}血脉 seed${w.seed}`;
  return {
    id: opts.id || `sv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    auto: !!opts.auto, name,
    createdAt: opts.createdAt || Date.now(),
    savedAt: Date.now(),
    data,
  };
}

/* 导出文档（人可读 + 可分享）：仅存档本体，不含任何成就数据 */
function saveToExportDoc(entry) {
  const d = entry.data;
  return {
    format: "family-sim-save", version: 1,
    name: entry.name, savedAt: new Date(entry.savedAt).toISOString(),
    world: { seed: d.world.seed, overrides: d.world.overrides || {}, founder: d.world.founder || null },
    year: d.year,
    stats: d.stats || {},
    outcome: d.outcome || { extinct_year: null, reasons: [] },
  };
}
function docToData(doc) {
  return {
    format: "family-sim-save", version: 1,
    world: {
      seed: doc.world.seed,
      overrides: sanitizeOverrides(doc.world.overrides),
      founder: doc.world.founder || null,
      bloodName: doc.world.bloodName || "",
    },
    year: doc.year,
    stats: doc.stats || {},
    outcome: doc.outcome || { extinct_year: null, reasons: [] },
  };
}

/* 校验外部 JSON；返回 (data|null, 错误信息) */
function validateSaveDoc(obj) {
  if (!obj || typeof obj !== "object") return [null, "不是有效的 JSON 对象"];
  if (obj.format === "family-sim-backup" && Array.isArray(obj.saves)) return ["backup", obj];
  if (obj.format !== "family-sim-save") return [null, "格式不对：这不是家族模拟器的存档文件"];
  const w = obj.world || {};
  if (typeof w.seed !== "number" || !isFinite(w.seed)) return [null, "存档缺少有效的种子 (seed)"];
  return ["save", obj];
}

/* ---------- 总览统计（对全部本地存档做描述性统计） ---------- */
const REASON_ZH = {
  E1_no_male_born: "始终没有男丁出生",
  E2_male_unbred: "男丁未婚未育",
  E3_male_early_death: "男丁早年夭折",
  E4_male_migrated: "男丁外迁离村",
  E6_married_no_child: "已婚但终生未育",
};

function describe(nums) {
  const n = nums.length;
  if (!n) return null;
  const sorted = nums.slice().sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const q = p => sorted[Math.min(n - 1, Math.floor(p * (n - 1)))];
  const sd = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { n, mean, median: q(0.5), min: sorted[0], max: sorted[n - 1], sd };
}
const r1 = v => (Math.round(v * 10) / 10).toLocaleString("zh-CN");

function buildOverview() {
  const entries = SaveStore.list.map(s => ({
    savedAt: s.savedAt, name: s.name, auto: s.auto, d: s.data,
    years: s.data.outcome?.extinct_year ?? s.data.year ?? 0,
    gens: s.data.stats?.max_lineage_gen ?? 0,
    pop: s.data.stats?.pop ?? 0,
    extinct: !!(s.data.outcome?.extinct_year != null),
  }));
  return {
    total: entries.length,
    totalYears: entries.reduce((a, e) => a + e.years, 0),
    lastPlayed: entries.length ? Math.max(...entries.map(e => e.savedAt)) : null,
    survivalPct: entries.length
      ? Math.round(entries.filter(e => !e.extinct).length / entries.length * 100) : 0,
    yearsStat: describe(entries.map(e => e.years)),
    gensStat: describe(entries.map(e => e.gens)),
    popStat: describe(entries.map(e => e.pop)),
    reasonDist: (() => {
      const m = {};
      for (const e of entries) for (const r of (e.d.outcome?.reasons || [])) m[r] = (m[r] || 0) + 1;
      return m;
    })(),
    histogram: (() => {
      const cuts = [50, 100, 150, 200, 300, 400, 600, 1000];
      const bins = cuts.map(() => 0); const over = [];
      for (const e of entries) {
        const i = cuts.findIndex(c => e.years <= c);
        if (i >= 0) bins[i]++; else over.push(e.years);
      }
      let overCount = over.length; // >1000 兜底并入最后一箱
      return { cuts, bins, overMax: overCount };
    })(),
    entries,
  };
}

/* ---------- 弹窗提示（队列化，逐条滑入滑出） ---------- */
const toastQueue = [];
let toastShowing = false;
function toast(msg, ms = 2600) {
  toastQueue.push([msg, ms]);
  pumpToast();
}
function pumpToast() {
  if (toastShowing || !toastQueue.length) return;
  toastShowing = true;
  const [msg, ms] = toastQueue.shift();
  const el = document.createElement("div");
  el.className = "meta-toast";
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => { el.remove(); toastShowing = false; pumpToast(); }, 350);
  }, ms);
}

/* 成就解锁横幅（金光卡片，右上角，独立于普通 toast） */
const achvQueue = [];
let achvShowing = false;
function achvBanner(a) {
  achvQueue.push(a);
  pumpAchv();
}
function pumpAchv() {
  if (achvShowing || !achvQueue.length) return;
  achvShowing = true;
  const a = achvQueue.shift();
  const el = document.createElement("div");
  el.className = "achv-banner";
  el.innerHTML = `
    <div class="ab-icon">${a.icon}</div>
    <div class="ab-tx">
      <div class="ab-cap">成就达成</div>
      <div class="ab-name">${esc(a.name)}</div>
      <div class="ab-desc">${esc(a.desc)}</div>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => { el.remove(); achvShowing = false; pumpAchv(); }, 420);
  }, 3800);
}

/* ================================================================
   主对象
================================================================ */
const Meta = {
  version: 1,
  settings: Settings.data,
  /** live.js 启动后注入：{enterGame, enterSave, goCover, isPlaying, getSaveData} */
  host: null,
  onSettingsChanged: null,

  _run: null,          // 当前世界的连续性上下文 {seed,overrides,founder,lastAutoYear,finalSaved,bloodName}
  _lastPersist: 0,
  _bootServerWorld: false,

  /* ---------- 初始化：绑定一切 DOM ---------- */
  async init() {
    bindSettingsUI();
    bindDialogButtons();
    this.refreshBadges();
    renderAchvGrid();
    renderSavesList();
    // 探测服务器是否还有活世界（决定「继续游戏」按钮形态）
    const snap = await jget("/api/snapshot").catch(() => null);
    this._bootServerWorld = !!(snap && !snap.error);
    this.refreshCoverInfo();
    setInterval(() => this.refreshCoverInfo(), 4000);
  },

  /* live.js 每次合并 step 补丁后回调。ctx 仅用于携带本批事件（可选）。 */
  gameTick(ctx = {}) {
    this.evalAchievements({ events: ctx.events });
    this.maybeAutosave();
  },

  /* live.js 创建/恢复世界成功后回调 */
  worldStarted(seed, overrides, founder) {
    this._run = {
      seed, overrides: overrides || {}, founder: founder || null,
      lastAutoYear: -1e9, finalSaved: false,
      bloodName: this.host?.getSaveData?.()?.world?.bloodName || "",
    };
    this._mem = {};   // 新世界的会话内标志重置
    this.persistRunMeta();
    this.evalAchievements({ worldCreated: true });
    this.maybeAutosave();
    this.hideCover();
  },

  /* 记住最近一次世界的完整元信息（重开浏览器后「继续游戏」要靠它对上种子） */
  persistRunMeta() {
    if (!this._run) return;
    store.set("fjs1_lastrun", {
      seed: this._run.seed, overrides: this._run.overrides,
      founder: this._run.founder, bloodName: this._run.bloodName || "",
    });
  },
  lastRunMeta() { return store.get("fjs1_lastrun", null); },

  /* 从宿主收集的存档数据派生成就判定上下文 */
  ctxFromSnap() {
    const d = this.host?.getSaveData?.();
    if (!d) return null;
    const st = d.stats || {};
    return {
      year: d.year, gen: st.max_lineage_gen || 0, pop: st.pop || 0,
      males: st.lineage_male || 0,
      maxKids: st.max_kids ?? 0, oldest: st.oldest_age ?? 0,
      alive: !(d.outcome?.extinct_year != null),
      endYear: st.end_year ?? 1000,
    };
  },

  /* 每个观测点都过一遍成就条件；达成即永久入库 + 金光横幅 */
  evalAchievements(extra = {}) {
    this._mem = this._mem || {};
    if (extra.worldCreated) this._mem.created = true;
    if (extra.events?.some(e => e.kind === "lineage_birth")) this._mem.birth = true;
    const c = this.ctxFromSnap() ||
      { year: 0, gen: 0, pop: 0, males: 0, maxKids: 0, oldest: 0, alive: false, endYear: 1000 };
    const full = {
      worldCreated: !!this._mem.created,
      sawLineageBirth: !!this._mem.birth,
      year: c.year, gen: c.gen, pop: c.pop, males: c.males,
      maxKids: c.maxKids, oldest: c.oldest,
      alive: c.alive, endYear: c.endYear,
    };
    const TEST = {
      first_world: f => f.worldCreated,
      first_birth: f => f.sawLineageBirth,
      males5: f => f.males >= 5,
      kids8: f => f.maxKids >= 8,
      pop500: f => f.pop >= 500,
      gen5: f => f.gen >= 5,
      elder90: f => f.oldest >= 90,
      y100: f => f.alive && f.year >= 100,
      y300: f => f.alive && f.year >= 300,
      fulltime: f => f.alive && f.year >= f.endYear,
    };
    let newly = 0;
    for (const a of ACHV) {
      if (!AchvStore.isUnlocked(a.id) && TEST[a.id](full)) {
        AchvStore.unlock(a.id);
        newly++;
        if (Settings.data.achToasts) achvBanner(a);
      }
    }
    if (newly) {
      this.refreshBadges();
      this._achvDirty = true;
    }
    // 打开着成就面板则实时刷进度条；否则只记脏标记，打开时再渲染
    if ($("dlg-achv").open) { renderAchvGrid(); this._achvDirty = false; }
  },

  /* 自动存档：按间隔年推进；断绝/终局再补一次最终档 */
  maybeAutosave() {
    if (!this._run || !this.host?.getSaveData) return;
    const every = +Settings.data.autosaveEvery || 0;
    const data = this.host.getSaveData();
    if (!data) return;
    if (data.world?.bloodName) this._run.bloodName = data.world.bloodName;
    const extinctAt = data.outcome?.extinct_year;
    const finished = data.outcome?.finished;
    const duePeriodic = every > 0 && data.year - this._run.lastAutoYear >= every;
    const dueFinal = !this._run.finalSaved && (extinctAt != null || finished);
    if (duePeriodic || dueFinal) {
      this._run.lastAutoYear = data.year;
      if (extinctAt != null || finished) this._run.finalSaved = true;
      SaveStore.upsert(makeSaveEntry(data, {
        auto: true, id: `sv_auto_${data.world.seed}`,
        name: `自动存档 · ${this._run.bloodName || "?"}氏 · y${data.year}`,
      }));
      this.persistRunMeta();
      if (dueFinal) toast(extinctAt != null ? "☠ 血脉断绝——终局已自动存档" : "⏳ 千年至此——终局已自动存档");
      renderSavesList();
      this.refreshCoverInfo();
    }
  },

  /* ---------- 封面 ---------- */
  hideCover() { $("cover")?.classList.add("gone"); },
  goCover() { this.host?.goCover?.(); this.refreshCoverInfo(); },

  latestAuto() { return SaveStore.latestAuto(); },
  sanitizeOverrides,

  refreshCoverInfo() {
    const sub = $("cv-start-sub");
    if (!sub) return;
    const auto = SaveStore.latestAuto();
    if (this._bootServerWorld && this.host?.hasServerWorld?.()) {
      sub.textContent = "回到你正在运行的世界";
    } else if (auto) {
      sub.textContent = `续上：${auto.name.replace(/^自动存档 · /, "")}（${fmtShort(auto.savedAt)} 存）`;
    } else {
      sub.textContent = "";
    }
  },

  /* ---------- 成就分享图 ---------- */
  shareImage() {
    const n = AchvStore.count();
    const cv = document.createElement("canvas");
    const W = 1280, H = 800;
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    // 底：暗色纵向渐变
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#181b22"); grad.addColorStop(1, "#0b0d11");
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    // 远景微尘（金色星屑）
    let seedState = 20260827;
    const rnd = () => (seedState = (seedState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 130; i++) {
      g.fillStyle = `rgba(232,182,76,${0.02 + rnd() * 0.05})`;
      g.beginPath(); g.arc(rnd() * W, rnd() * H, rnd() * 2.2, 0, Math.PI * 2); g.fill();
    }
    // 双层描边画框
    g.strokeStyle = "rgba(232,182,76,.75)"; g.lineWidth = 2.5;
    g.strokeRect(18, 18, W - 36, H - 36);
    g.strokeStyle = "rgba(232,182,76,.30)"; g.lineWidth = 1;
    g.strokeRect(28, 28, W - 56, H - 56);
    // 抬头
    g.textAlign = "center"; g.textBaseline = "alphabetic";
    g.fillStyle = "#e8b64c";
    g.font = "58px KaiTi, STKaiti, serif";
    g.fillText("家 族 模 拟 器", W / 2, 108);
    g.fillStyle = "#8b8f9a"; g.font = "20px KaiTi, STKaiti, serif";
    g.fillText("成 就 殿 堂 · 一 姓 之 源 ，千 载 兴 衰", W / 2, 146);
    g.strokeStyle = "rgba(232,182,76,.35)";
    g.beginPath(); g.moveTo(W / 2 - 180, 170); g.lineTo(W / 2 + 180, 170); g.stroke();
    g.fillStyle = "#dcdee4"; g.font = "26px 'Segoe UI', sans-serif";
    g.fillText(`${n} / ${ACHV.length}`, W / 2, 208);

    const x0 = 96, y0 = 250, cw = 214, ch = 218, gx = 14, gy = 26;
    ACHV.forEach((a, i) => {
      const col = i % 5, row = (i / 5) | 0;
      const x = x0 + col * (cw + gx), y = y0 + row * (ch + gy);
      const got = AchvStore.isUnlocked(a.id);
      // 卡底
      roundRect(g, x, y, cw, ch, 12);
      g.fillStyle = got ? "rgba(232,182,76,.10)" : "rgba(27,30,37,.85)";
      g.fill();
      g.lineWidth = 1.5;
      if (got) { g.strokeStyle = "#e8b64c"; g.setLineDash([]); }
      else { g.strokeStyle = "#3a3d45"; g.setLineDash([5, 4]); }
      roundRect(g, x, y, cw, ch, 12); g.stroke(); g.setLineDash([]);
      // 图标
      g.font = "46px serif"; g.textAlign = "center";
      if (got) { g.globalAlpha = 1; g.fillStyle = "#fff"; }
      else { g.globalAlpha = 1; g.filter = "grayscale(1)"; }
      g.fillText(a.icon, x + cw / 2, y + 66);
      g.filter = "none";
      // 名字
      g.font = "bold 21px 'Microsoft YaHei', sans-serif";
      g.fillStyle = got ? "#e8b64c" : "#6a6e78";
      g.fillText(a.name, x + cw / 2, y + 102);
      // 描述折行
      g.font = "13px 'Microsoft YaHei', sans-serif";
      g.fillStyle = got ? "#b9bdc7" : "#55585f";
      wrapText(g, a.desc, x + cw / 2, y + 128, cw - 24, 17);
      // 底部状态
      g.font = "12px 'Microsoft YaHei', sans-serif";
      if (got) {
        g.fillStyle = "#8b7038";
        g.fillText(`达成于 ${fmtShort(AchvStore.data.unlocked[a.id])}`, x + cw / 2, y + ch - 16);
      } else {
        g.font = "18px serif"; g.fillStyle = "#3f434c";
        g.fillText("🔒", x + cw / 2, y + ch - 14);
      }
    });

    // 页脚
    g.textAlign = "left"; g.font = "15px 'Microsoft YaHei', sans-serif";
    g.fillStyle = "#8b8f9a";
    g.fillText(`✦ ${new Date().toLocaleDateString("zh-CN")} · 家族模拟器 M1`, 40, H - 40);
    g.textAlign = "right";
    g.fillText("从一对夫妻出发，看血脉能否穿越千年", W - 40, H - 40);

    cv.toBlob(blob => {
      this._lastShareBlob = blob;
      $("share-img").src = cv.toDataURL("image/png");
      $("dlg-share").showModal();
    }, "image/png");
  },
};

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function wrapText(g, text, cx, y, maxW, lh) {
  let line = "", lines = [];
  for (const ch of String(text)) {
    if (g.measureText(line + ch).width > maxW) { lines.push(line); line = ch; }
    else line += ch;
  }
  if (line) lines.push(line);
  lines.slice(0, 3).forEach((t, i) => g.fillText(t, cx, y + i * lh));
}

/* ================================================================
   DOM 渲染与绑定
================================================================ */

function bindDialogButtons() {
  // 封面菜单：开始游戏 = 有可续的世界就直接进，没有则弹新世界向导
  $("cv-start").addEventListener("click", () => {
    const canResume = (Meta._bootServerWorld && Meta.host?.hasServerWorld?.())
      || !!SaveStore.latestAuto();
    if (canResume) {
      if (!Meta.host?.enterGame) { toast("游戏核心还未就绪，稍候再试"); return; }
      Meta.host.enterGame();
    } else {
      $("dlg-new").showModal();
    }
  });
  $("cv-new").addEventListener("click", () => $("dlg-new").showModal());
  $("cv-saves").addEventListener("click", () => openSaves());
  $("cv-achv").addEventListener("click", () => openAchv());
  $("cv-settings").addEventListener("click", () => openSettings());

  // 游戏内顶栏
  $("btn-home").addEventListener("click", () => Meta.goCover());
  $("btn-saves").addEventListener("click", () => openSaves());
  $("btn-achv").addEventListener("click", () => openAchv());
  $("btn-settings").addEventListener("click", () => openSettings());

  // 关闭按钮
  for (const [dlgId, closeId] of [["dlg-saves", "sv-close"], ["dlg-achv", "achv-close"], ["dlg-settings", "set-close"]]) {
    $(closeId).addEventListener("click", () => $(dlgId).close());
  }

  // 成就
  $("btn-share").addEventListener("click", () => Meta.shareImage());
  $("share-close").addEventListener("click", () => $("dlg-share").close());
  $("share-download").addEventListener("click", () => {
    if (!Meta._lastShareBlob) return;
    download(`家族模拟器_成就_${AchvStore.count()}of${ACHV.length}.png`, Meta._lastShareBlob);
    toast("分享图已下载，快发给朋友吧");
  });
  // 点击遮罩关闭（成就/存档/设置/分享四个对话框通用）
  for (const id of ["dlg-achv", "dlg-saves", "dlg-settings", "dlg-share"]) {
    $(id).addEventListener("click", e => { if (e.target === $(id)) $(id).close(); });
  }

  // 存档馆
  $("sv-tab-list").addEventListener("click", () => switchSavesTab("list"));
  $("sv-tab-stats").addEventListener("click", () => switchSavesTab("stats"));
  $("sv-import").addEventListener("change", e => handleImportFiles(e.target.files));
  $("sv-do-export-all").addEventListener("click", exportAllBackup);
  $("sv-import-trigger").addEventListener("click", () => $("sv-import").click());
  $("set-import-backup-trigger").addEventListener("click", () => $("set-import-backup").click());

  // 设置：数据区危险操作
  $("set-clear-achv").addEventListener("click", () => {
    if (!confirm("确定要清空全部成就吗？此操作不可恢复。")) return;
    AchvStore.clear(); renderAchvGrid(); Meta.refreshBadges();
    toast("成就数据已清空");
  });
  $("set-clear-saves").addEventListener("click", () => {
    if (!confirm("确定要删除所有存档（含自动存档）吗？此操作不可恢复。")) return;
    SaveStore.clear(); renderSavesList(); Meta.refreshBadges();
    toast("全部存档已删除");
  });
  $("set-import-backup").addEventListener("change", e => handleImportFiles(e.target.files));
}

function switchSavesTab(tab) {
  $("sv-tab-list").classList.toggle("on", tab === "list");
  $("sv-tab-stats").classList.toggle("on", tab === "stats");
  $("sv-list-pane").hidden = tab !== "list";
  $("sv-stats-pane").hidden = tab !== "stats";
  if (tab === "stats") renderOverview();
}

function openSaves() {
  $("sv-savebar").hidden = !Meta.host?.isPlaying?.();
  if (Meta.host?.isPlaying?.()) $("sv-newname").value =
    `进度手存 · y${Meta.host.getSaveData()?.year ?? 0}`;
  renderSavesList();
  switchSavesTab("list");
  $("dlg-saves").showModal();
}
function openAchv() { renderAchvGrid(); $("dlg-achv").showModal(); }
function openSettings() { $("dlg-settings").showModal(); }

/* ---------- 设置面板 ---------- */
function bindSettingsUI() {
  const s = Settings.data;
  const speedSel = $("set-speed");
  speedSel.value = String(s.speedMs);
  speedSel.addEventListener("change", () => { Settings.data.speedMs = +speedSel.value; Settings.save(); });

  const flashChk = $("set-flash");
  flashChk.checked = s.flashBirths;
  flashChk.addEventListener("change", () => { Settings.data.flashBirths = flashChk.checked; Settings.save(); });

  const toastChk = $("set-toasts");
  toastChk.checked = s.achToasts;
  toastChk.addEventListener("change", () => { Settings.data.achToasts = toastChk.checked; Settings.save(); });

  const autoSel = $("set-autosave");
  autoSel.value = String(s.autosaveEvery);
  autoSel.addEventListener("change", () => { Settings.data.autosaveEvery = +autoSel.value; Settings.save(); });
}

/* ---------- 成就格子渲染 ---------- */
function achvProgText(a) {
  if (AchvStore.isUnlocked(a.id)) return null;
  if (!a.prog || !Meta.host?.getSaveData) return null;
  const c = Meta.ctxFromSnap ? Meta.ctxFromSnap() : null;
  if (!c) return null;
  const p = a.prog(c);
  if (!p) return "本局血脉已断，另开新局再战";
  return p;
}
function renderAchvGrid() {
  const grid = $("achv-grid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const a of ACHV) {
    const got = AchvStore.isUnlocked(a.id);
    const card = document.createElement("div");
    card.className = `achv-card ${got ? "got" : "lock"}`;
    let footHtml = "";
    if (got) {
      footHtml = `<div class="ac-date">✓ 达成于 ${fmtShort(AchvStore.data.unlocked[a.id])}</div>`;
    } else {
      const pr = achvProgText(a);
      if (Array.isArray(pr)) {
        const [cur, tgt] = pr;
        const pct = Math.max(3, Math.round(cur / tgt * 100));
        footHtml = `
          <div class="ac-bar"><i style="width:${pct}%"></i></div>
          <div class="ac-num">${fmtNum(cur)} / ${fmtNum(tgt)}</div>`;
      } else if (typeof pr === "string") {
        footHtml = `<div class="ac-hint">${pr}</div>`;
      } else {
        footHtml = `<div class="ac-hint">尚未达成</div>`;
      }
    }
    card.innerHTML = `
      <div class="ac-icon">${a.icon}</div>
      <div class="ac-name">${esc(a.name)}</div>
      <div class="ac-desc">${esc(a.desc)}</div>
      ${footHtml}`;
    grid.appendChild(card);
  }
  $("achv-count").textContent = `${AchvStore.count()} / ${ACHV.length}`;
  const bar = $("achv-progress").querySelector("i");
  bar.style.width = `${AchvStore.count() / ACHV.length * 100}%`;
}
const fmtNum = v => v >= 10000 ? `${r1(v / 10000)}万` : String(Math.round(v));

/* ---------- 存档列表渲染 ---------- */
function renderSavesList() {
  const grid = $("sv-grid");
  if (!grid) return;
  if (!SaveStore.list.length) {
    grid.innerHTML = `<div class="sv-empty">还没有任何存档。<br>进入游戏后会自动定期存档；也可在此手动保存。</div>`;
    return;
  }
  grid.innerHTML = "";
  for (const sv of SaveStore.list) {
    const d = sv.data;
    const w = d.world || {};
    const extinct = d.outcome?.extinct_year;
    const card = document.createElement("div");
    card.className = `sv-card ${sv.auto ? "autosave" : ""}${extinct != null ? " dead" : ""}`;
    card.innerHTML = `
      <div class="sv-head">
        <span class="sv-name" title="${esc(sv.name)}">${sv.auto ? "⟳ " : ""}${esc(sv.name)}</span>
        ${extinct != null ? `<span class="sv-flag dead">☠ 断绝 y${extinct}</span>`
          : d.outcome?.finished ? `<span class="sv-flag fin">♾️ 千年终章</span>` : ""}
      </div>
      <div class="sv-meta">
        y${d.year} · 第 ${(d.stats?.max_lineage_gen ?? 0)} 代 · 村 ${(d.stats?.pop ?? 0)} 人 · 男丁 ${(d.stats?.lineage_male ?? 0)}
      </div>
      <div class="sv-time">seed ${w.seed} · 存于 ${fmtDT(sv.savedAt)}</div>
      <div class="sv-btns">
        <button class="go" title="读档并进入这个世界">▶ 进入</button>
        <button class="exp" title="导出为 JSON 文件，可分享给他人">导出</button>
        <button class="del" title="删除这条存档">删除</button>
      </div>`;
    card.querySelector(".go").addEventListener("click", () => enterSave(sv));
    card.querySelector(".exp").addEventListener("click", () => {
      const doc = saveToExportDoc(sv);
      download(`${sv.name}.json`, new Blob(
        [JSON.stringify(doc, null, 2)], { type: "application/json" }));
      toast("存档已导出为 JSON");
    });
    card.querySelector(".del").addEventListener("click", () => {
      if (!confirm(`删除存档「${sv.name}」？`)) return;
      SaveStore.remove(sv.id);
      renderSavesList(); Meta.refreshCoverInfo();
    });
    grid.appendChild(card);
  }
}

async function enterSave(sv) {
  if (!Meta.host?.enterSave) { toast("游戏核心还未就绪"); return; }
  $("dlg-saves").close();
  toast(`正在重放恢复「${sv.name}」……`);
  await Meta.host.enterSave(sv);
}

/* 手动保存按钮（游戏中） */
$("sv-do-save").addEventListener("click", () => {
  const data = Meta.host?.getSaveData?.();
  if (!data) { toast("当前没有进行中的世界"); return; }
  const name = $("sv-newname").value.trim() || undefined;
  const entry = makeSaveEntry(data, { name });
  SaveStore.upsert(entry);
  renderSavesList();
  Meta.refreshCoverInfo();
  toast("已保存当前进度");
});

/* ---------- 导入 ---------- */
async function handleImportFiles(fileList) {
  if (!fileList || !fileList.length) return;
  let ok = 0, fail = 0;
  for (const file of fileList) {
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      const [kind, payload] = validateSaveDoc(obj);
      if (kind === "backup") {
        for (const s of payload.saves || []) {
          if (validateSaveDoc(s)[0] === "save")
            SaveStore.upsert(makeSaveEntry(docToData(s), { name: s.name }));
        }
        ok++;
      } else if (kind === "save") {
        const doc = payload;
        const entry = makeSaveEntry(docToData(doc), { name: doc.name || file.name.replace(/\.json$/i, "") });
        SaveStore.upsert(entry);
        ok++;
      } else fail++;
    } catch (err) {
      fail++;
    }
  }
  renderSavesList(); Meta.refreshCoverInfo();
  if (ok) toast(`导入成功 ${ok} 个存档`);
  if (fail) toast(`${fail} 个文件无法识别（需要家族模拟器导出的 JSON）`);
  $("sv-import").value = ""; $("set-import-backup").value = "";
}

function exportAllBackup() {
  const backup = {
    format: "family-sim-backup", version: 1,
    exportedAt: new Date().toISOString(),
    saves: SaveStore.list.map(saveToExportDoc),
    settings: Settings.data,
  };
  download(`家族模拟器_全量备份_${new Date().toISOString().slice(0, 10)}.json`,
    new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
  toast("全量备份已导出");
}

/* ---------- 总览统计渲染 ---------- */
function renderOverview() {
  const pane = $("sv-stats-pane");
  const o = buildOverview();
  if (!o.total) {
    pane.innerHTML = `<div class="sv-empty">还没有存档可以统计。<br>玩上几局再来看看你的家族史诗吧。</div>`;
    return;
  }
  const statRow = (label, s, unit = "") => !s ? "" : `
    <tr><td>${label}</td><td>${r1(s.mean)}${unit}</td><td>${r1(s.median)}${unit}</td>
    <td>${r1(s.min)}${unit}</td><td>${r1(s.max)}${unit}</td><td>${r1(s.sd)}${unit}</td></tr>`;
  const histMax = Math.max(1, ...o.histogram.bins);
  const histBars = o.histogram.cuts.map((cut, i) => {
    const cnt = o.histogram.bins[i];
    const from = i === 0 ? 0 : o.histogram.cuts[i - 1];
    return `
      <div class="hist-col" title="${from}-${cut} 年：${cnt} 局">
        <span class="hn">${cnt || ""}</span>
        <i style="height:${cnt / histMax * 100}%"></i>
        <span class="hl">${cut}</span>
      </div>`;
  }).join("");
  const reasonKeys = Object.entries(o.reasonDist).sort((a, b) => b[1] - a[1]);
  const reasonMax = Math.max(1, ...reasonKeys.map(r => r[1]));
  const reasonRows = reasonKeys.map(([code, n]) => `
    <div class="rs-row"><span class="rs-label">${REASON_ZH[code] || code}</span>
      <span class="rs-bar"><i style="width:${n / reasonMax * 100}%"></i></span>
      <span class="rs-n">${n}</span></div>`).join("");

  pane.innerHTML = `
    <div class="ov-cards">
      <div class="ov-card"><b>${o.total}</b><span>份存档</span></div>
      <div class="ov-card"><b>${o.totalYears.toLocaleString("zh-CN")}</b><span>累计模拟年数</span></div>
      <div class="ov-card"><b>${o.survivalPct}%</b><span>存档时血脉仍续</span></div>
      <div class="ov-card"><b>${o.lastPlayed ? fmtShort(o.lastPlayed) : "—"}</b><span>最近游玩</span></div>
    </div>
    <table class="ov-table">
      <thead><tr><th>指标（截至各存档时点）</th><th>均值</th><th>中位数</th><th>最小</th><th>最大</th><th>标准差</th></tr></thead>
      <tbody>
        ${statRow("存续年数（断绝以断绝年为终点）", o.yearsStat, " 年")}
        ${statRow("血脉世代数", o.gensStat, " 代")}
        ${statRow("村中人口", o.popStat, " 人")}
      </tbody>
    </table>
    <div class="ov-section">
      <h4>存续年数分布（每柱右缘为该箱上限 / 年）</h4>
      <div class="hist">${histBars}</div>
    </div>
    ${reasonKeys.length ? `
    <div class="ov-section">
      <h4>血脉断绝原因分布（同一局可能多因并存）</h4>
      ${reasonRows}
    </div>` : ""}
    <div class="ov-note">统计范围为本地全部存档；导入他人的存档也会计入。</div>`;
}

/* 徽标（封面上显示成就 x/10 与存档数） */
Meta.refreshBadges = function () {
  const badge = $("cv-achv-badge");
  if (badge) badge.textContent = `${AchvStore.count()}/${ACHV.length}`;
  const sc = $("cv-save-count");
  if (sc) sc.textContent = SaveStore.list.length ? `${SaveStore.list.length} 档` : "";
};

/* 把 Meta 挂到全局，供 live.js 注入 host 并回调 */
window.Meta = Meta;

/* DOM 就绪后初始化（脚本置于 body 尾，元素已齐） */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => Meta.init());
} else {
  Meta.init();
}

})();
