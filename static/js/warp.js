// warp.js —— 整经与穿筘规划：由草稿参数推算全幅经纱、筘齿分配与分束方案
// 只读取草稿（经纱色序、穿综、经密、幅宽、长度、缩率、回丝），不修改组织图。
import { analyze } from "./weave.js";

/** 上机三个阶段（逐根勾选） */
export const STAGES = [
  { key: "warped", label: "整经" },
  { key: "threaded", label: "穿综" },
  { key: "sleyed", label: "穿筘" },
];

/** 默认整经/穿筘计划（挂在 draft.warpPlan 上，随项目与版本一起保存） */
export function defaultWarpPlan() {
  return {
    reedDensity: 5,          // 筘密（单位见 reedUnit）
    reedUnit: "cm",          // 'cm' 齿/cm | 'in' 齿/英寸
    dentPattern: [2],        // 布身每齿根数循环，如 [2] 或 [2,3]
    selvEnds: 0,             // 每侧边纱根数
    selvPerDent: 2,          // 边纱每齿根数
    selvShaft: "adjacent",   // 边纱穿综：adjacent 跟随相邻 | alternate 综框 1/2 交替
    maxBout: 40,             // 每束根数上限
    boutBounds: null,        // 束边界 [0, …, 总根数]；null → 自动分束
    progress: null,          // { warped:[], threaded:[], sleyed:[], cursor }
  };
}

/** 筘密统一换算为 齿/cm */
export function dentsPerCm(wp) {
  const d = +wp.reedDensity || 0;
  return wp.reedUnit === "in" ? d / 2.54 : d;
}

/** 解析“每齿根数模式”文本，如 "2"、"2,3"、"2 2 3" */
export function parsePattern(text, fallback = [2]) {
  const nums = String(text || "")
    .split(/[^\d]+/)
    .filter(Boolean)
    .map((s) => Math.max(1, parseInt(s, 10) || 1));
  return nums.length ? nums.slice(0, 12) : fallback.slice();
}

/**
 * 按目标经密与筘密建议每齿根数循环（误差扩散，周期 ≤ 8，取最短重复周期）。
 * 例：经密 10、筘 4 齿/cm → 理想 2.5 根/齿 → [2,3]
 */
export function suggestDentPattern(epc, dpc) {
  if (!(dpc > 0) || !(epc > 0)) return [2];
  const ideal = epc / dpc;
  const lo = Math.max(1, Math.floor(ideal));
  const hi = lo + 1;
  const f = ideal - lo;
  if (f < 0.02) return [lo];
  if (f > 0.98) return [hi];
  const pat = [];
  let err = 0;
  for (let i = 0; i < 8; i++) {
    err += f;
    if (err >= 1 - 1e-9) { pat.push(hi); err -= 1; } else pat.push(lo);
  }
  for (let L = 1; L <= pat.length / 2; L++) {
    if (pat.length % L !== 0) continue;
    let ok = true;
    for (let i = L; i < pat.length; i++) if (pat[i] !== pat[i % L]) { ok = false; break; }
    if (ok) return pat.slice(0, L);
  }
  return pat;
}

/**
 * 自动分束：不超过 maxBout，尽量落在颜色变化处，保持色序连续。
 * 整段同色无处可落时硬切（由检查逻辑标出）。
 */
export function autoBoutBounds(colors, maxBout) {
  const N = colors.length;
  const bounds = [0];
  let pos = 0;
  while (N - pos > maxBout) {
    const limit = pos + maxBout;
    let edge = -1;
    for (let i = limit; i > pos; i--) {
      if (colors[i] !== colors[i - 1]) { edge = i; break; }
    }
    if (edge < 0) edge = limit;             // 窗口内无颜色变化，只能硬切
    bounds.push(edge);
    pos = edge;
  }
  bounds.push(N);
  return bounds;
}

/** 校验手工束边界：严格递增、起于 0、止于总根数；不合法返回 null */
export function sanitizeBounds(bounds, totalEnds) {
  if (!Array.isArray(bounds) || bounds.length < 2) return null;
  const b = bounds.map((v) => Math.round(+v));
  if (b[0] !== 0 || b[b.length - 1] !== totalEnds) return null;
  for (let i = 1; i < b.length; i++) if (!(b[i] > b[i - 1])) return null;
  return b;
}

/** 调整第 k 束的根数（移动其与下一束的边界；末束不可调，给下一束至少留 1 根） */
export function setBoutSize(bounds, k, size, totalEnds) {
  const b = bounds.slice();
  if (k < 0 || k >= b.length - 2) return b;         // 末束大小由总根数决定
  const lo = b[k] + 1;
  const hi = b[k + 2] - 1;
  b[k + 1] = Math.max(lo, Math.min(hi, b[k] + Math.round(+size || 0)));
  return b;
}

/** 建立/修复进度结构；总根数变化时重置。返回进度对象。 */
export function ensureProgress(wp, totalEnds) {
  const p = wp.progress;
  const ok = p && Array.isArray(p.warped) && p.warped.length === totalEnds
    && Array.isArray(p.threaded) && p.threaded.length === totalEnds
    && Array.isArray(p.sleyed) && p.sleyed.length === totalEnds;
  if (!ok) {
    wp.progress = {
      warped: new Array(totalEnds).fill(false),
      threaded: new Array(totalEnds).fill(false),
      sleyed: new Array(totalEnds).fill(false),
      cursor: 0,
    };
  }
  wp.progress.cursor = Math.max(0, Math.min(totalEnds - 1, wp.progress.cursor | 0));
  return wp.progress;
}

/**
 * 由草稿推算整经与穿筘完整方案。
 * 返回 { ends, dents, dentOfEnd, bouts, bounds, boundsAuto, runs, issues,
 *        pattern, dpc, bodyDents, totalDents, avgPerDent, actualEpc, devPct,
 *        reedWidthCm, maxBout, selv, selvPerDent, totals }
 */
export function computeWarpPlan(draft) {
  const wp = Object.assign(defaultWarpPlan(), draft.warpPlan || {});
  const s = draft.settings;
  const a = analyze(draft);
  const epc = +s.epc || 0;
  const bodyEnds = Math.max(1, Math.round((+s.width || 0) * (epc || 1)));
  const selv = Math.max(0, wp.selvEnds | 0);
  const sp = Math.max(1, wp.selvPerDent | 0);
  const totalEnds = bodyEnds + 2 * selv;
  const E = draft.ends;
  const tex = +s.warpTex || 0;

  // 单根长度（与用纱估算一致）：成品长 / (1-经缩) + 上机回丝
  const warpLenEach = (+s.length || 0) / (1 - (+s.warpTakeup || 0) / 100) + (+s.wasteWarp || 0);
  // tex = g/km：根数 × 单根长(cm) ÷ 100000 → km，× tex → g
  const weightOfEnds = (n) => n * warpLenEach / 100000 * tex;

  const wrap = (bi) => ((bi % E) + E) % E;
  const colorOf = (bi) => draft.warpColors[wrap(bi)] ?? 0;
  const shaftOf = (bi) => a.shaftOfEnd[wrap(bi)];

  // ---- 逐根属性（编号 0..totalEnds-1，含两侧边纱） ----
  const ends = [];
  for (let i = 0; i < totalEnds; i++) {
    let zone = "B";
    if (i < selv) zone = "L";
    else if (i >= selv + bodyEnds) zone = "R";
    let color, shaft, bodyIdx = null;
    if (zone === "B") {
      bodyIdx = i - selv;
      color = colorOf(bodyIdx);
      shaft = shaftOf(bodyIdx);
    } else {
      const adj = zone === "L" ? 0 : bodyEnds - 1;   // 边纱颜色跟随相邻布身经纱
      color = colorOf(adj);
      if (wp.selvShaft === "alternate") {
        const k = zone === "L" ? i : i - (selv + bodyEnds);
        shaft = k % 2;                                // 综框 1/2 交替
      } else {
        shaft = shaftOf(adj);
      }
    }
    ends.push({ i, zone, bodyIdx, color, shaft });
  }

  // ---- 筘齿分配：左边纱 → 布身（模式循环）→ 右边纱 ----
  const dpc = dentsPerCm(wp);
  const pattern = (Array.isArray(wp.dentPattern) && wp.dentPattern.length ? wp.dentPattern : [2])
    .map((v) => Math.max(1, v | 0));
  const dents = [];
  const dentOfEnd = new Array(totalEnds).fill(-1);
  const pushDent = (from, to, zone, planned) => {
    const idx = dents.length;
    dents.push({ idx, start: from, end: to, count: to - from, zone, planned });
    for (let k = from; k < to; k++) dentOfEnd[k] = idx;
  };
  let p = 0;
  while (p < selv) { const t = Math.min(sp, selv - p); pushDent(p, p + t, "L", sp); p += t; }
  const bodyStop = selv + bodyEnds;
  let dcnt = 0;
  while (p < bodyStop) {
    const planned = pattern[dcnt % pattern.length];
    pushDent(p, Math.min(p + planned, bodyStop), "B", planned);
    p += planned; dcnt++;
  }
  while (p < totalEnds) { const t = Math.min(sp, totalEnds - p); pushDent(p, p + t, "R", sp); p += t; }

  const bodyDents = dents.filter((x) => x.zone === "B");
  const avgPerDent = bodyEnds / Math.max(1, bodyDents.length);
  const actualEpc = avgPerDent * dpc;
  const devPct = epc > 0 && dpc > 0 ? (actualEpc - epc) / epc * 100 : 0;
  const reedWidthCm = dpc > 0 ? dents.length / dpc : 0;

  // ---- 色段（用于束界切色检查） ----
  const runs = [];
  for (let i = 0; i < totalEnds; i++) {
    const c = ends[i].color;
    if (runs.length && runs[runs.length - 1].color === c) runs[runs.length - 1].end = i + 1;
    else runs.push({ start: i, end: i + 1, color: c });
  }

  // ---- 分束 ----
  const maxBout = Math.max(4, wp.maxBout | 0);
  let bounds = sanitizeBounds(wp.boutBounds, totalEnds);
  const boundsAuto = !bounds;
  if (!bounds) bounds = autoBoutBounds(ends.map((e) => e.color), maxBout);
  const bouts = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const st = bounds[k], en = bounds[k + 1];
    const colors = {};
    for (let i = st; i < en; i++) colors[ends[i].color] = (colors[ends[i].color] || 0) + 1;
    const count = en - st;
    bouts.push({
      idx: k, start: st, end: en, count, colors,
      startDent: dentOfEnd[st] + 1,
      lenEach: warpLenEach,
      totalM: count * warpLenEach / 100,
      weightG: weightOfEnds(count),
    });
  }

  // ---- 检查 ----
  const issues = [];
  const fmt = (v, d = 1) => (+v).toFixed(d);

  if (!(dpc > 0)) {
    issues.push({ level: "error", kind: "reed", msg: "筘密无效：请设置大于 0 的筘密。" });
  } else if (epc > 0) {
    const absDev = Math.abs(devPct);
    if (absDev > 5 || absDev > 2) {
      issues.push({
        level: absDev > 5 ? "error" : "warn", kind: "density",
        msg: `实际经密 ${fmt(actualEpc, 2)} 根/cm，偏离目标 ${epc} 约 ${devPct >= 0 ? "+" : ""}${fmt(devPct)}%`
          + `（筘 ${fmt(dpc, 2)} 齿/cm × 平均每齿 ${fmt(avgPerDent, 2)} 根），可调整筘密或每齿根数模式`,
      });
    }
  }

  // 筘齿分配不匀：实际根数与模式不符的齿（通常只可能出现在末尾）
  const short = dents.filter((x) => x.count !== x.planned);
  const zoneName = { L: "左边纱", B: "布身", R: "右边纱" };
  short.slice(0, 8).forEach((dt) => {
    issues.push({
      level: "warn", kind: "dentUneven", end: dt.start,
      msg: `筘齿分配不匀：第 ${dt.idx + 1} 齿（${zoneName[dt.zone]}）穿 ${dt.count} 根，模式为 ${dt.planned} 根`,
    });
  });
  const pMin = Math.min(...pattern), pMax = Math.max(...pattern);
  if (pMax - pMin > 1) {
    issues.push({
      level: "info", kind: "dentSpread",
      msg: `穿筘模式 ${pattern.join("、")} 中每齿根数相差 ${pMax - pMin}，留意布面筘痕`,
    });
  }
  if (selv > 0 && selv % sp !== 0) {
    issues.push({
      level: "warn", kind: "selvDent", end: 0,
      msg: `边纱 ${selv} 根按每齿 ${sp} 根余 ${selv % sp} 根，末齿不足`,
    });
  }

  // 束边界切断色序（整幅同色时不报）
  if (runs.length > 1) {
    for (let k = 1; k < bounds.length - 1; k++) {
      const b = bounds[k];
      if (b > 0 && b < totalEnds && ends[b - 1].color === ends[b].color) {
        issues.push({
          level: "warn", kind: "boutCut", end: b,
          msg: `第 ${k + 1} 束起点（第 ${b + 1} 根前）切断色序：相邻两根同为色 ${ends[b].color + 1}`,
        });
      }
    }
  }

  // 边纱落位：束边界不得落入两侧边纱区
  if (selv > 0) {
    for (let k = 1; k < bounds.length - 1; k++) {
      const b = bounds[k];
      if (b < selv || b > totalEnds - selv) {
        issues.push({
          level: "error", kind: "selvPlace", end: b,
          msg: `束边界（第 ${b + 1} 根前）落入边纱区：${selv} 根边纱应整体处于首末束两端`,
        });
      }
    }
  }

  // 束超过上限
  bouts.forEach((bt) => {
    if (bt.count > maxBout) {
      issues.push({
        level: "warn", kind: "boutOver", end: bt.start,
        msg: `第 ${bt.idx + 1} 束 ${bt.count} 根超过每束上限 ${maxBout}`,
      });
    }
  });

  // 草图中未穿综的布身经纱
  const un = ends.filter((e) => e.zone === "B" && e.shaft < 0);
  if (un.length) {
    issues.push({
      level: "info", kind: "unthreaded", end: un[0].i,
      msg: `布身有 ${un.length} 根在草图中未穿综，上机视图显示为“—”`,
    });
  }

  // ---- 汇总 ----
  const byColor = [];
  ends.forEach((e) => { byColor[e.color] = (byColor[e.color] || 0) + 1; });
  const totals = {
    totalEnds, bodyEnds, selv, warpLenEach,
    totalM: totalEnds * warpLenEach / 100,
    weightG: weightOfEnds(totalEnds),
    byColor: byColor
      .map((n, ci) => (n ? {
        color: ci, ends: n,
        lengthM: n * warpLenEach / 100,
        weightG: weightOfEnds(n),
      } : null))
      .filter(Boolean),
  };

  return {
    ends, dents, dentOfEnd, bouts, bounds, boundsAuto, runs, issues,
    pattern, dpc, bodyDents: bodyDents.length, totalDents: dents.length,
    avgPerDent, actualEpc, devPct, reedWidthCm, maxBout, selv, selvPerDent: sp, totals,
  };
}
