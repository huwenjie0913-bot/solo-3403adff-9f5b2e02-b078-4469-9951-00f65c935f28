// wif.js —— WIF (Weaving Information File) 导入导出
import { createDraft, applyDimensions } from "./model.js";
import { makeMatrix } from "./utils.js";

/**
 * 导出 WIF 文本。
 * 栓结始终按 jack（提起）约定书写；降综逻辑写入自定义标记，导回时还原。
 */
export function exportWIF(d) {
  const { ends, shafts, treadles, picks, threading, tieup, treadling,
          warpColors, weftColors, palette, shed } = d;
  const L = [];
  const w = (s = "") => L.push(s);

  w("[WIF]");
  w("Version=1.1");
  w("Source Program=多综织物设计台");
  w("Source Version=1.0");
  w("Encoding=UTF-8");
  w();
  w("[CONTENTS]");
  w("TEXT=yes");
  w("COLOR PALETTE=yes");
  w("COLOR TABLE=yes");
  w("WARP=yes");
  w("WEFT=yes");
  w("TIEUP=yes");
  w("THREADING=yes");
  w("TREADLING=yes");
  w("WARP COLORS=yes");
  w("WEFT COLORS=yes");
  w();
  w("[TEXT]");
  w(`Title=${d.name || "多综织物"}`);
  w("Date=" + new Date().toISOString().slice(0, 10));
  w("Author=手工织布工作室");
  w();
  w("[WEAVING.Draft]");
  w("ShedType=" + shed);   // 自定义：jack | sinking
  w();
  w("[WARP]");
  w("Threads=" + ends);
  w("Color Palette=1");
  w();
  w("[WEFT]");
  w("Threads=" + picks);
  w("Color Palette=1");
  w();
  w("[WARP COLORS]");
  for (let e = 0; e < ends; e++) w(`${e + 1}=${warpColors[e] + 1}`);
  w();
  w("[WEFT COLORS]");
  for (let p = 0; p < picks; p++) w(`${p + 1}=${weftColors[p] + 1}`);
  w();
  w("[THREADING]");
  for (let e = 0; e < ends; e++) {
    for (let s = 0; s < shafts; s++) {
      if (threading[s][e]) { w(`${e + 1}=${s + 1}`); break; }
    }
  }
  w();
  w("[TIEUP]");
  // 降综：把“物理提起”取反为 jack 视角
  for (let t = 0; t < treadles; t++) {
    const list = [];
    for (let s = 0; s < shafts; s++) {
      const tied = tieup[s][t] === 1;
      const jackTied = shed === "sinking" ? !tied : tied;
      if (jackTied) list.push(s + 1);
    }
    w(`${t + 1}=${list.join(",")}`);
  }
  w();
  w("[TREADLING]");
  for (let p = 0; p < picks; p++) {
    const list = [];
    for (let t = 0; t < treadles; t++) if (treadling[p][t]) list.push(t + 1);
    w(`${p + 1}=${list.join(",")}`);
  }
  w();
  w("[COLOR PALETTE]");
  w("Entries=1");
  w("Range=1," + Math.max(256, palette.length));
  w();
  w("[COLOR TABLE]");
  for (let i = 0; i < palette.length; i++) {
    const h = palette[i].replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    w(`${i + 1}=${r},${g},${b}`);
  }
  w();
  return L.join("\r\n");
}

/** 解析 WIF 文本为 draft，无法识别时抛出 Error */
export function importWIF(text) {
  const sections = parseIni(text);
  const has = (name) => !!sections[name];

  if (!has("threading") && !has("lift plan")) {
    throw new Error("文件中未找到 [THREADING] 或 [LIFT PLAN]，不是有效的 WIF 草图。");
  }

  const num = (o, k, d = 0) => {
    const v = o?.[k.toLowerCase()];
    return v == null ? d : parseFloat(String(v).split(",")[0]) || d;
  };

  const warpThreads = Math.max(1, num(sections["warp"], "threads"));
  const weftThreads = Math.max(1, num(sections["weft"], "threads"));
  let shafts = Math.max(2, num(sections["warp"], "shafts"));
  let treadles = Math.max(2, num(sections["weft"], "treadles"));
  const title = sections["text"]?.title || "导入的 WIF";

  // 从各段实际编号推断尺寸
  const threadMap = new Map();       // end(1基) -> shaft
  for (const [k, v] of Object.entries(sections["threading"] || {})) {
    const end = parseInt(k, 10);
    const sh = parseInt(String(v).split(",")[0], 10);
    if (end >= 1 && sh >= 1) {
      threadMap.set(end, sh);
      shafts = Math.max(shafts, sh);
    }
  }
  const ends = Math.max(warpThreads, ...[...threadMap.keys()], 1);

  // 栓结：treadle(1基) -> [shafts…]
  const tieMap = new Map();
  for (const [k, v] of Object.entries(sections["tieup"] || {})) {
    const t = parseInt(k, 10);
    if (t >= 1) {
      const sl = String(v).split(",").map((x) => parseInt(x.trim(), 10)).filter((x) => x >= 1);
      sl.forEach((s) => (shafts = Math.max(shafts, s)));
      treadles = Math.max(treadles, t);
      tieMap.set(t, sl);
    }
  }

  // 踏序：pick(1基) -> [treadles…]
  const treadMap = new Map();
  for (const [k, v] of Object.entries(sections["treadling"] || {})) {
    const p = parseInt(k, 10);
    if (p >= 1) {
      const tl = String(v).split(",").map((x) => parseInt(x.trim(), 10)).filter((x) => x >= 1);
      tl.forEach((t) => (treadles = Math.max(treadles, t)));
      treadMap.set(p, tl);
    }
  }
  // 或 LIFT PLAN：pick -> [shafts…]（无踏板织机，自动造栓结+踏序）
  const liftMap = new Map();
  for (const [k, v] of Object.entries(sections["lift plan"] || {})) {
    const p = parseInt(k, 10);
    if (p >= 1) {
      const sl = String(v).split(",").map((x) => parseInt(x.trim(), 10)).filter((x) => x >= 1);
      sl.forEach((s) => (shafts = Math.max(shafts, s)));
      liftMap.set(p, sl);
    }
  }

  const picks = Math.max(weftThreads, ...[...treadMap.keys()], ...[...liftMap.keys()], 1);

  // 色板
  const palette = [];
  const colorTable = sections["color table"] || {};
  for (const [k, v] of Object.entries(colorTable)) {
    const idx = parseInt(k, 10);
    if (idx >= 1) {
      const [r = 0, g = 0, b = 0] = String(v).split(",").map((x) => parseInt(x.trim(), 10) || 0);
      palette[idx - 1] = "#" + [r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("");
  }
  }
  for (let i = 0; i < 256; i++) if (!palette[i]) palette[i] = defaultWifColor(i);
  const palTrim = palette.slice(0, Math.max(2, ...usedColorIndices(colorTable)));

  // 色序
  const readColors = (sec, n) => {
    const out = new Array(n).fill(0);
    for (const [k, v] of Object.entries(sec || {})) {
      const i = parseInt(k, 10);
      const ci = parseInt(String(v).split(",")[0], 10) - 1;
      if (i >= 1 && i <= n && ci >= 0) out[i - 1] = ci;
    }
    return out;
  };
  const warpColors = readColors(sections["warp colors"], ends);
  const weftColors = readColors(sections["weft colors"], picks);

  // 组装 draft
  let draft = createDraft({
    name: title, ends, shafts, treadles, picks,
    palette: palTrim, warpColors: warpColors.map((c) => c % palTrim.length),
    weftColors: weftColors.map((c) => c % palTrim.length),
  });

  // 穿综
  for (const [end, sh] of threadMap) draft.threading[sh - 1][end - 1] = 1;

  const shed = sections["weaving.draft"]?.["shedtype"] === "sinking" ? "sinking" : "jack";
  draft.shed = shed;

  if (liftMap.size) {
    // 为每种出现过的提起组合造一个踏板
    const comboKey = (sl) => sl.slice().sort((a, b) => a - b).join(".");
    const keyToTreadle = new Map();
    let nextT = 1;
    const pickTreadles = new Map();
    for (const [p, sl] of liftMap) {
      const key = comboKey(sl);
      if (!keyToTreadle.has(key)) {
        keyToTreadle.set(key, nextT);
        sl.forEach((s) => { /* jack 视角栓结 */ });
        nextT++;
      }
      pickTreadles.set(p, keyToTreadle.get(key));
    }
    treadles = Math.max(2, nextT - 1);
    applyDimensions(draft, { treadles });
    for (const [key, t] of keyToTreadle) {
      const sl = key ? key.split(".").map(Number) : [];
      sl.forEach((s) => (draft.tieup[s - 1][t - 1] = 1));
    }
    for (const [p, t] of pickTreadles) draft.treadling[p - 1][t - 1] = 1;
  } else {
    applyDimensions(draft, { treadles });
    for (const [t, sl] of tieMap) {
      // 降综文件：WIF 按 jack 视角记录“提起”，取反得到物理上被压下的综
      if (shed === "sinking") {
        for (let x = 1; x <= shafts; x++) if (!sl.includes(x)) draft.tieup[x - 1][t - 1] = 1;
      } else {
        sl.forEach((s) => (draft.tieup[s - 1][t - 1] = 1));
      }
    }
    for (const [p, tl] of treadMap) tl.forEach((t) => (draft.treadling[p - 1][t - 1] = 1));
  }

  return draft;
}

// 解析宽松 INI（注释、空白、重复段容错），全部键转小写
function parseIni(text) {
  const sections = {};
  let cur = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/;.*$/, "").replace(/\r$/, "").trim();
    if (!line) continue;
    const sec = line.match(/^\[(.+?)\]$/);
    if (sec) {
      cur = sec[1].trim().toLowerCase();
      sections[cur] = sections[cur] || {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0 && cur) {
      const k = line.slice(0, eq).trim().toLowerCase();
      const v = line.slice(eq + 1).trim();
      sections[cur][k] = v;
    }
  }
  return sections;
}

function usedColorIndices(colorTable) {
  const keys = Object.keys(colorTable).map((k) => parseInt(k, 10));
  return keys.length ? keys : [1, 2];
}

// WIF 默认 256 色调色板的简化版本：未提供色表时给一组区分色
function defaultWifColor(i) {
  const table = ["#f4f1ea", "#2f2c28", "#b54848", "#3f6d9e", "#d9b24a",
                 "#5d8a5a", "#7d5b9e", "#c0703a", "#3f8e94", "#8f8a7c"];
  return table[i % table.length];
}
