// weave.js —— 核心织物推演：提综状态、组织图、浮长与问题检测

/**
 * 计算完整推演结果。
 * @param {object} d draft
 * @returns {object}
 *   shaftOfEnd: [经纱 i -> 综框行，-1 未穿综]
 *   lift:      P×S，每纬物理上被提起的综框（与升降综逻辑无关）
 *   pressed:   P×T 复制踏序
 *   face:      P×E，1＝经纱在上，0＝纬纱在上
 *   emptyPicks: [纬行…] 空梭口
 *   warpFloats/weftFloats: 超限浮段
 *   floatCells: Set("p,e") 组织图中需描边的格
 *   issues:    问题列表 {level,kind,msg,loc,count}
 */
export function analyze(d) {
  const { ends, shafts, treadles, picks, threading, tieup, treadling, shed, thresholds } = d;

  // ---- 每根经纱所穿综框 ----
  const shaftOfEnd = new Array(ends).fill(-1);
  const usedShafts = new Set();
  for (let e = 0; e < ends; e++) {
    for (let s = 0; s < shafts; s++) {
      if (threading[s][e]) { shaftOfEnd[e] = s; usedShafts.add(s); break; }
    }
  }

  // ---- 每纬：被压踏板 -> 提起的综框 ----
  const lift = [];
  const emptyPicks = [];
  for (let p = 0; p < picks; p++) {
    const lifted = new Array(shafts).fill(0);
    let pressedAny = 0;
    for (let t = 0; t < treadles; t++) {
      if (treadling[p][t]) {
        pressedAny = 1;
        for (let s = 0; s < shafts; s++) if (tieup[s][t]) lifted[s] = 1;
      }
    }
    if (!pressedAny) emptyPicks.push(p);
    lift.push(lifted);
  }

  // ---- 组织图 ----
  const face = [];
  for (let p = 0; p < picks; p++) {
    const row = new Array(ends).fill(0);
    for (let e = 0; e < ends; e++) {
      const s = shaftOfEnd[e];
      if (s < 0) { row[e] = 0; continue; }                 // 未穿综：按纬面处理
      const isLifted = lift[p][s] === 1;
      row[e] = shed === "jack" ? (isLifted ? 1 : 0)
                               : (isLifted ? 0 : 1);       // 降综逻辑相反
    }
    face.push(row);
  }

  // ---- 浮长 ----
  const warpFloats = [];
  const weftFloats = [];
  const floatCells = new Set();

  const warpTh = Math.max(1, thresholds.warp | 0);
  const weftTh = Math.max(1, thresholds.weft | 0);

  const isEmpty = (p) => emptyPicks.includes(p);
  const key = (p, e) => p + "," + e;

  // 经浮长：沿纬向（纵向扫描每根经纱）连续“经在上”
  for (let e = 0; e < ends; e++) {
    if (shaftOfEnd[e] < 0) continue;
    let start = -1;
    const close = (end) => {
      const len = end - start;
      if (len >= warpTh) {
        const seg = { c: e, r1: start, r2: end - 1, len };
        warpFloats.push(seg);
        for (let p = start; p < end; p++) floatCells.add(key(p, e));
      }
    };
    for (let p = 0; p < picks; p++) {
      const up = face[p][e] === 1 && !isEmpty(p);
      if (up) { if (start < 0) start = p; }
      else if (start >= 0) { close(p); start = -1; }
    }
    if (start >= 0) close(picks);
  }

  // 纬浮长：沿经向（横向扫描每一纬）连续“纬在上”
  for (let p = 0; p < picks; p++) {
    if (isEmpty(p)) continue;
    let start = -1;
    const close = (end) => {
      const len = end - start;
      if (len >= weftTh) {
        const seg = { r: p, c1: start, c2: end - 1, len };
        weftFloats.push(seg);
        for (let e = start; e < end; e++) {
          if (shaftOfEnd[e] >= 0) floatCells.add(key(p, e));
        }
      }
    };
    for (let e = 0; e < ends; e++) {
      const down = face[p][e] === 0 && shaftOfEnd[e] >= 0;
      if (down) { if (start < 0) start = e; }
      else if (start >= 0) { close(e); start = -1; }
    }
    if (start >= 0) close(ends);
  }

  // ---- 问题列表 ----
  const issues = [];

  for (const p of emptyPicks) {
    issues.push({
      level: "error", kind: "empty", count: 1,
      msg: `第 ${p + 1} 纬为空梭口：未压任何踏板`,
      loc: { grid: "treadling", r: p, c: 0 },
    });
  }

  const unthreadedEnds = [];
  for (let e = 0; e < ends; e++) if (shaftOfEnd[e] < 0) unthreadedEnds.push(e);
  if (unthreadedEnds.length) {
    issues.push({
      level: "error", kind: "unthreaded", count: unthreadedEnds.length,
      msg: `${unthreadedEnds.length} 根经纱未穿综（首：第 ${unthreadedEnds[0] + 1} 根）`,
      loc: { grid: "threading", r: 0, c: unthreadedEnds[0] },
      ends: unthreadedEnds,
    });
  }

  const unusedShafts = [];
  for (let s = 0; s < shafts; s++) if (!usedShafts.has(s)) unusedShafts.push(s);
  if (unusedShafts.length) {
    issues.push({
      level: "warn", kind: "unusedShaft", count: unusedShafts.length,
      msg: `${unusedShafts.length} 个综框未穿经：综 ${unusedShafts.map((s) => s + 1).join("、")}`,
      loc: { grid: "threading", r: unusedShafts[0], c: 0 },
      shafts: unusedShafts,
    });
  }

  const unusedTreadles = [];
  for (let t = 0; t < treadles; t++) {
    let used = false;
    for (let p = 0; p < picks; p++) if (treadling[p][t]) { used = true; break; }
    if (!used) unusedTreadles.push(t);
  }
  if (unusedTreadles.length) {
    issues.push({
      level: "warn", kind: "unusedTreadle", count: unusedTreadles.length,
      msg: `${unusedTreadles.length} 个踏板未使用：踏 ${unusedTreadles.map((t) => t + 1).join("、")}`,
      loc: { grid: "treadling", r: 0, c: unusedTreadles[0] },
      treadles: unusedTreadles,
    });
  }

  // 栓结列为空但被踏过：等于空梭口之外的补充提示
  for (let t = 0; t < treadles; t++) {
    let tied = false;
    for (let s = 0; s < shafts; s++) if (tieup[s][t]) { tied = true; break; }
    if (!tied) {
      let usedOn = -1;
      for (let p = 0; p < picks; p++) if (treadling[p][t]) { usedOn = p; break; }
      if (usedOn >= 0) {
        issues.push({
          level: "warn", kind: "bareTie", count: 1,
          msg: `踏板 ${t + 1} 未栓结任何综框，却用于第 ${usedOn + 1} 纬`,
          loc: { grid: "tieup", r: 0, c: t },
        });
      }
    }
  }

  if (warpFloats.length) {
    const n = warpFloats.reduce((a, f) => a + f.len, 0);
    const f = warpFloats[0];
    issues.push({
      level: "warn", kind: "warpFloat", count: warpFloats.length,
      msg: `${warpFloats.length} 段经浮长超过阈值 ${warpTh}（共 ${n} 格；最长 ${Math.max(...warpFloats.map((x) => x.len))}）`,
      loc: { grid: "drawdown", r: f.r1, c: f.c },
      floats: warpFloats,
    });
  }
  if (weftFloats.length) {
    const n = weftFloats.reduce((a, f) => a + f.len, 0);
    const f = weftFloats[0];
    issues.push({
      level: "warn", kind: "weftFloat", count: weftFloats.length,
      msg: `${weftFloats.length} 段纬浮长超过阈值 ${weftTh}（共 ${n} 格；最长 ${Math.max(...weftFloats.map((x) => x.len))}）`,
      loc: { grid: "drawdown", r: f.r, c: f.c1 },
      floats: weftFloats,
    });
  }

  return { shaftOfEnd, lift, face, emptyPicks, warpFloats, weftFloats, floatCells, issues, usedShafts };
}
