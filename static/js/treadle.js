// treadle.js —— 提综方案（lift plan）→ 栓结（tie-up）＋踏序（treadling）候选搜索
//
// 给定逐纬“物理提起的综框”表（升综/降综的区别已在 weave.analyze 中处理，
// 这里只关心逐纬提综位掩码），搜索：
//   - 栓结矩阵 tieup[S][T]（哪些综框栓到哪个踏板）
//   - 踏序矩阵 treadling[P][T]（每纬踩哪几个踏板）
// 使每纬踩下踏板所栓综框的并集，逐纬精确等于目标提综组合。
//
// 综框位掩码使用 BigInt（支持最多 32 综，超出 31 位安全整数位运算范围）。

const B0 = 0n;

function bit(s) { return 1n << BigInt(s); }

function popcount(x) {
  let n = 0;
  while (x) { x &= x - 1n; n++; }
  return n;
}

function lowestBit(x) { return x & -x; }

/** a ⊆ b */
function subsetOf(a, b) { return (a & ~b) === B0; }

/** 0/1 矩阵的某一列 -> 位掩码 */
function columnMask(mat, col, rows) {
  let m = B0;
  for (let s = 0; s < rows; s++) if (mat[s] && mat[s][col]) m |= bit(s);
  return m;
}

/**
 * 搜索候选栓结/踏序。
 *
 * @param {object} p
 *   shafts        综框数 S
 *   lift          P×S 的 0/1 数组：每纬物理提起的综框（来自 analyze(draft).lift）
 *   treadles      踏板数 T
 *   maxPress      每纬同时踩下踏板数上限 K
 *   currentTie    现有栓结 S×T0（用于锁定列与改动量，可选）
 *   locked        锁定（整列保持现有栓结不变）的踏板下标
 *   keep          必须保留的栓结 [{s,t}]（0 基）
 *   forbid        禁止的栓结   [{s,t}]
 * @returns
 *   成功：{ ok:true, candidates:[...], truncated, warnings, stats }
 *   无解：{ ok:false, conflicts:[{type,msg,picks,...}], warnings, stats }
 */
export function solveTreadle(p) {
  const S = Math.max(1, p.shafts | 0);
  const T = Math.max(1, p.treadles | 0);
  const K = Math.min(T, Math.max(1, p.maxPress | 0));
  const lift = p.lift || [];
  const P = lift.length;
  const T0 = p.currentTie ? p.currentTie.length ? (p.currentTie[0]?.length || 0) : 0 : 0;

  const keepMask = new Array(T).fill(B0);
  const forbidMask = new Array(T).fill(B0);
  for (const { s, t } of p.keep || []) {
    if (s >= 0 && s < S && t >= 0 && t < T) keepMask[t] |= bit(s);
  }
  for (const { s, t } of p.forbid || []) {
    if (s >= 0 && s < S && t >= 0 && t < T) forbidMask[t] |= bit(s);
  }

  // ---- 逐纬提综组合（相同提综位掩码的纬合并为一个 combo）----
  const comboByKey = new Map();   // key -> { mask, picks }
  const zeroPicks = [];
  for (let i = 0; i < P; i++) {
    let m = B0;
    for (let s = 0; s < S; s++) if (lift[i] && lift[i][s]) m |= bit(s);
    if (m === B0) { zeroPicks.push(i); continue; }
    const key = m.toString();
    let c = comboByKey.get(key);
    if (!c) { c = { mask: m, key, picks: [] }; comboByKey.set(key, c); }
    c.picks.push(i);
  }
  const combos = [...comboByKey.values()];

  const stats = { picks: P, shafts: S, treadles: T, maxPress: K,
                  comboCount: combos.length, zeroPicks: zeroPicks.slice() };

  // ---- 锁定列：整列固定为现有栓结 ----
  const fixedMask = new Array(T).fill(null);   // null=自由列；BigInt=固定列
  if (p.currentTie) {
    for (const t of p.locked || []) {
      if (t >= 0 && t < T && t < T0) fixedMask[t] = columnMask(p.currentTie, t, S);
    }
  }
  const freeCols = [];
  for (let t = 0; t < T; t++) if (fixedMask[t] === null) freeCols.push(t);

  const oldMaskAt = (t) => (p.currentTie && t < T0 ? columnMask(p.currentTie, t, S) : B0);

  const warnings = [];

  // ---- 前置约束冲突 ----
  const conflicts = [];
  for (let t = 0; t < T; t++) {
    if ((keepMask[t] & forbidMask[t]) !== B0) {
      const bad = keepMask[t] & forbidMask[t];
      conflicts.push({
        type: "cellConflict", treadle: t, shafts: bitsOf(bad),
        msg: `踏板 ${t + 1} 上同一栓结被同时要求保留与禁止（综 ${bitsOf(bad).map((x) => x + 1).join("、")}）`,
      });
    }
    const fm = fixedMask[t];
    if (fm !== null) {
      const missing = keepMask[t] & ~fm;
      const illegal = fm & forbidMask[t];
      if (missing !== B0 || illegal !== B0) {
        conflicts.push({
          type: "lockConstraint", treadle: t,
          missing: bitsOf(missing), forbidden: bitsOf(illegal),
          msg: `锁定的踏板 ${t + 1} 与保留/禁止约束冲突` +
               (missing !== B0 ? `：缺少必须保留的综 ${bitsOf(missing).map((x) => x + 1).join("、")}` : "") +
               (illegal !== B0 ? `：含被禁止的综 ${bitsOf(illegal).map((x) => x + 1).join("、")}` : ""),
        });
      }
    }
  }
  if (conflicts.length) return { ok: false, conflicts, warnings, stats };

  // ---- 候选“踏板栓结位掩码”池：提综组合、它们两两的交集、单综 ----
  // （实际织物的不同提综组合通常很少；两两交集已足以表达最小并集分解。）
  const pool = new Set(combos.map((c) => c.mask));
  for (let s = 0; s < S; s++) {
    const b = bit(s);
    if (combos.some((c) => (c.mask & b) !== B0)) pool.add(b);
  }
  const POOL_MAX = 420;
  const cmasks = combos.map((c) => c.mask);
  for (let i = 0; i < cmasks.length && pool.size < POOL_MAX; i++) {
    for (let j = i + 1; j < cmasks.length && pool.size < POOL_MAX; j++) {
      const inter = cmasks[i] & cmasks[j];
      if (inter !== B0) pool.add(inter);
    }
  }
  let poolTruncated = false;
  if (pool.size >= POOL_MAX) {
    poolTruncated = true;
    warnings.push({
      type: "poolTruncated",
      msg: "提综组合种类很多，候选栓结形态池已截断；如找不到满意结果，可增加每纬踩踏上限或踏板数。",
    });
  }
  // 候选池本身无需含 0（踩下的踏板必须至少栓一个综）
  const masks = [...pool].sort((a, b) => popcount(b) - popcount(a) || (a < b ? -1 : a > b ? 1 : 0));

  const isFree = (t) => fixedMask[t] === null;
  const fixedMasksAll = new Set();
  for (let t = 0; t < T; t++) if (fixedMask[t] !== null && fixedMask[t] !== B0) fixedMasksAll.add(fixedMask[t]);

  // 某自由列允许的栓结位掩码（满足该列的保留/禁止约束，且不与现有/已用列重复）
  const permittedCache = new Map();
  function permittedMasks(t, M) {
    const key = t + ":" + M.toString();
    let cached = permittedCache.get(key);
    if (cached) return cached;
    const res = [];
    for (const f of masks) {
      if (!subsetOf(f, M)) continue;
      if ((f & forbidMask[t]) !== B0) continue;
      if (!subsetOf(keepMask[t], f)) continue;
      res.push(f);
    }
    permittedCache.set(key, res);
    return res;
  }

  // 某栓结位掩码是否至少能放在一个自由列上（保留/禁止约束许可）
  const freshAvailable = new Set();
  for (const f of masks) {
    if (fixedMasksAll.has(f)) continue;
    for (const t of freeCols) {
      if ((f & forbidMask[t]) === B0 && subsetOf(keepMask[t], f)) { freshAvailable.add(f); break; }
    }
  }

  // ---- 全局：被所有踏板禁止、却被某些纬需要的综框 ----
  const neededShafts = new Set();
  for (const c of combos) for (const s of bitsOf(c.mask)) neededShafts.add(s);
  for (const s of neededShafts) {
    const b = bit(s);
    let canLift = false;
    for (let t = 0; t < T; t++) {
      if (fixedMask[t] !== null) { if ((fixedMask[t] & b) !== B0) { canLift = true; break; } }
      else if ((forbidMask[t] & b) === B0) { canLift = true; break; }
    }
    if (!canLift) {
      const picks = combos.filter((c) => (c.mask & b) !== B0).flatMap((c) => c.picks);
      conflicts.push({
        type: "shaftForbidden", shaft: s, picks: sortedUnique(picks),
        msg: `综框 ${s + 1} 在全部 ${T} 个踏板上都被禁止（或锁定列未栓），` +
             `但第 ${picks.slice(0, 8).map((x) => x + 1).join("、")}${picks.length > 8 ? " 等" : ""} 纬需要提起它`,
      });
    }
  }
  if (conflicts.length) return { ok: false, conflicts, warnings, stats };

  // ---- 提醒：保留的栓结不可能被任何纬用到（保留集合不是任一提综组合的子集）----
  for (let t = 0; t < T; t++) {
    const km = keepMask[t];
    if (km !== B0 && !combos.some((c) => subsetOf(km, c.mask))) {
      warnings.push({
        type: "keptUnused", treadle: t, shafts: bitsOf(km),
        msg: `踏板 ${t + 1} 上要求保留的栓结（综 ${bitsOf(km).map((x) => x + 1).join("、")}）不会被任何纬踩到`,
      });
    }
  }

  // ---- 逐组合可行性预检（含“最少需踩几个踏板”）----
  function minCover(M) {
    // 可用掩码：固定列掩码（每列一份）+ 池掩码（需消耗自由列，且总数 ≤ 自由列数）
    const fixedUsable = [];
    for (let t = 0; t < T; t++) {
      const fm = fixedMask[t];
      if (fm !== null && fm !== B0 && subsetOf(fm, M)) fixedUsable.push(fm);
    }
    const freshUsable = [];
    for (const f of masks) if (freshAvailable.has(f) && subsetOf(f, M)) freshUsable.push(f);
    let best = K + 1;
    const chosen = new Set();
    function rec(covered, depth, freshCount) {
      if (depth >= best || covered === M) { if (covered === M) best = depth; return; }
      const pivot = lowestBit(M & ~covered);
      const tryMask = (mm, fresh) => {
        if (chosen.has(mm) || (mm & pivot) === B0) return;
        if (fresh && freshCount >= freeCols.length) return;
        chosen.add(mm);
        rec(covered | mm, depth + 1, freshCount + (fresh ? 1 : 0));
        chosen.delete(mm);
      };
      for (const mm of fixedUsable) tryMask(mm, false);
      for (const mm of freshUsable) tryMask(mm, true);
    }
    rec(B0, 0, 0);
    return best;
  }

  for (const c of combos) {
    const need = minCover(c.mask);
    if (need > K) {
      conflicts.push({
        type: "comboUncoverable", picks: c.picks.slice(), shafts: bitsOf(c.mask),
        minPresses: need > T ? null : need, maxPress: K,
        msg: `第 ${c.picks.slice(0, 8).map((x) => x + 1).join("、")}` +
             `${c.picks.length > 8 ? " 等" : ""} 纬提综组合（综 ${bitsOf(c.mask).map((x) => x + 1).join("、")}）` +
             `在每纬最多踩 ${K} 个踏板的限制下无法精确复现` +
             (need <= T ? `：至少需要同时踩 ${need} 个踏板` : "：受保留/禁止栓结与锁定列所阻"),
      });
    }
  }
  if (conflicts.length) return { ok: false, conflicts, warnings, stats };

  // --------------------------------------------------------------------- //
  // 回溯搜索：为每个提综组合选择一个“最小踏板覆盖”，自由列即时分配栓结
  // --------------------------------------------------------------------- //
  const NODE_BUDGET = 120000;
  const LEAF_CAP = 240;
  const OPTION_CAP = 250;
  const DEADLINE_MS = 2500;
  const deadline = (typeof performance !== "undefined" && performance.now)
    ? performance.now() + DEADLINE_MS : null;
  let nodes = 0;
  let truncated = false;
  let optionsTruncated = false;

  // 难组合优先：提起综框多者、出现纬数多者先绑定
  const order = combos.slice().sort(
    (a, b) => popcount(b.mask) - popcount(a.mask) || b.picks.length - a.picks.length);

  const assigned = new Map();   // 自由列 t -> 已分配掩码
  const chosenByCombo = new Array(order.length);   // {pressed:[t...], fresh:Map}

  const leaves = new Map();     // 规范签名 -> candidate（保留改动量更小者）

  function usedMasksGlobal() {
    const s = new Set(fixedMasksAll);
    for (const m of assigned.values()) s.add(m);
    return s;
  }

  // 对称破缺：约束画像相同（保留/禁止集合一致）的自由列彼此可互换；同一覆盖中
  // 同时“新开”的若干列，令其掩码随列号严格递增，即可把同一解的列排列副本合并。
  const profOf = new Map();
  for (const t of freeCols) profOf.set(t, keepMask[t].toString() + "/" + forbidMask[t].toString());
  const peers = new Map();
  for (const t of freeCols) {
    peers.set(t, freeCols.filter((u) => u !== t && profOf.get(u) === profOf.get(t)));
  }
  function canonicalFresh(t, f, fresh) {
    for (const u of peers.get(t)) {
      const m = fresh.get(u);     // 只约束本次覆盖中同时新开的列
      if (m == null || m === f) continue;
      if (u < t && m > f) return false;
      if (u > t && m < f) return false;
    }
    return true;
  }

  /**
   * 枚举组合 M 的全部（极小）踏板覆盖。
   * 返回 [{ pressed:[列...], fresh:[[列,掩码]...] }]
   */
  function enumCovers(M) {
    const usedMasks = usedMasksGlobal();
    const existing = [];
    for (let t = 0; t < T; t++) {
      let mm = null;
      if (fixedMask[t] !== null) mm = fixedMask[t];
      else if (assigned.has(t)) mm = assigned.get(t);
      if (mm !== null && mm !== B0 && subsetOf(mm, M)) existing.push({ t, m: mm });
    }
    const openFree = freeCols.filter((t) => !assigned.has(t));

    const out = [];
    const seen = new Set();
    const pickedCols = new Set();
    const fresh = new Map();

    function emit() {
      const pressed = [...pickedCols].sort((a, b) => a - b);
      const key = pressed.join(".") + "|" + [...fresh.entries()]
        .map(([t, m]) => t + ":" + m.toString()).sort().join(",");
      if (seen.has(key)) return;
      // 极小性：去掉任一列都不再完整覆盖
      const all = [...pickedCols].map((t) => ({
        t, m: fixedMask[t] !== null ? fixedMask[t] : (assigned.get(t) ?? fresh.get(t)),
      }));
      for (const one of all) {
        let u = B0;
        for (const other of all) if (other.t !== one.t) u |= other.m;
        if (u === M) return;   // one 是冗余列
      }
      seen.add(key);
      out.push({ pressed, fresh: [...fresh.entries()].map(([t, m]) => [t, m]) });
    }

    function rec(covered, depth) {
      if (out.length >= OPTION_CAP) return;
      if (covered === M) { emit(); return; }
      if (depth >= K) return;
      const pivot = lowestBit(M & ~covered);
      // 优先复用已有列（固定列、已分配自由列），再开新自由列
      for (const ex of existing) {
        if (out.length >= OPTION_CAP) return;
        if (pickedCols.has(ex.t) || (ex.m & pivot) === B0) continue;
        pickedCols.add(ex.t);
        rec(covered | ex.m, depth + 1);
        pickedCols.delete(ex.t);
      }
      for (const t of openFree) {
        if (out.length >= OPTION_CAP) return;
        if (pickedCols.has(t)) continue;
        const allowed = permittedMasks(t, M).filter((f) =>
          (f & pivot) !== B0 && !usedMasks.has(f) &&
          ![...fresh.values()].includes(f) && canonicalFresh(t, f, fresh));
        for (const f of allowed) {
          if (out.length >= OPTION_CAP) return;
          pickedCols.add(t);
          fresh.set(t, f);
          rec(covered | f, depth + 1);
          fresh.delete(t);
          pickedCols.delete(t);
        }
      }
    }
    rec(B0, 0);
    if (out.length >= OPTION_CAP) optionsTruncated = true;
    // 偏好：少开新列、少踩踏板
    out.sort((a, b) => a.fresh.length - b.fresh.length || a.pressed.length - b.pressed.length);
    return out;
  }

  function recordLeaf() {
    // 列掩码（未使用的自由列为 0）
    const colMasks = new Array(T).fill(B0);
    for (let t = 0; t < T; t++) if (fixedMask[t] !== null) colMasks[t] = fixedMask[t];
    for (const [t, m] of assigned) colMasks[t] = m;

    const usedCols = new Set();
    let multiPicks = 0, totalPresses = 0;
    const optionByComboKey = new Map();
    for (let i = 0; i < order.length; i++) {
      const c = order[i], opt = chosenByCombo[i];
      optionByComboKey.set(c.key, opt);
      if (opt.pressed.length > 1) multiPicks += c.picks.length;
      totalPresses += opt.pressed.length * c.picks.length;
      opt.pressed.forEach((t) => usedCols.add(t));
    }

    // 规范签名：与踏板编号无关，只看“某提综组合由哪些栓结掩码覆盖”
    const sig = [...optionByComboKey.entries()]
      .map(([k, opt]) => k + ">" + opt.pressed
        .map((t) => colMasks[t].toString()).sort().join(",")).sort().join("|");

    // 相对当前栓结的改动量（只计新方案实际用到的列；未用列无需拆栓）
    let changes = 0;
    for (const t of usedCols) changes += popcount(colMasks[t] ^ oldMaskAt(t));

    if (leaves.has(sig) && leaves.get(sig).changeCells <= changes) return;

    // 组装矩阵
    const tieup = [];
    for (let s = 0; s < S; s++) {
      const row = new Array(T).fill(0);
      for (let t = 0; t < T; t++) if ((colMasks[t] & bit(s)) !== B0) row[t] = 1;
      tieup.push(row);
    }
    const treadling = [];
    for (let i = 0; i < P; i++) {
      const m = (() => { let x = B0; for (let s = 0; s < S; s++) if (lift[i][s]) x |= bit(s); return x; })();
      const row = new Array(T).fill(0);
      if (m !== B0) {
        const opt = optionByComboKey.get(m.toString());
        opt.pressed.forEach((t) => { row[t] = 1; });
      }
      treadling.push(row);
    }

    leaves.set(sig, {
      tieup, treadling,
      usedTreadles: usedCols.size,
      usedList: [...usedCols].sort((a, b) => a - b),
      multiPicks, totalPresses, changeCells: changes,
      colMasks: colMasks.map((m) => m.toString()),
    });
  }

  function dfs(idx) {
    if (leaves.size >= LEAF_CAP) return;
    if (nodes++ > NODE_BUDGET || (deadline && performance.now() > deadline)) { truncated = true; return; }
    if (idx === order.length) { recordLeaf(); return; }
    const c = order[idx];
    const options = enumCovers(c.mask);
    for (const opt of options) {
      if (leaves.size >= LEAF_CAP) return;
      for (const [t, m] of opt.fresh) assigned.set(t, m);
      chosenByCombo[idx] = opt;
      dfs(idx + 1);
      for (const [t] of opt.fresh) assigned.delete(t);
      if (truncated) return;
    }
  }
  dfs(0);

  if (!leaves.size) {
    if (truncated || optionsTruncated) {
      // 预算用尽前没找到完整解：不能断定无解，按“搜索受限”提示而不伪造冲突纬
      warnings.push({
        type: "searchLimit",
        msg: "搜索空间过大，在时间预算内未构造出完整方案；可增加踏板数或每纬踩踏上限后重试。",
      });
      return { ok: false, conflicts: [{ type: "searchLimit", picks: [],
        msg: "搜索达到时间/分支预算，未找到完整方案（并非已证明无解）；请放宽踏板数或每纬踩踏上限后重试。" }],
        warnings, stats };
    }
    // 预检均通过却无完整解（通常是自由列数不够在各纬间分配）——按纬给出冲突
    for (const c of combos) {
      conflicts.push({
        type: "comboUncoverable", picks: c.picks.slice(), shafts: bitsOf(c.mask),
        minPresses: null, maxPress: K,
        msg: `第 ${c.picks.slice(0, 8).map((x) => x + 1).join("、")} 纬提综组合` +
             `（综 ${bitsOf(c.mask).map((x) => x + 1).join("、")}）无法与其它纬共用 ${T} 个踏板同时满足全部约束`,
      });
    }
    return { ok: false, conflicts, warnings, stats };
  }

  if (truncated || optionsTruncated || poolTruncated) {
    warnings.push({
      type: "searchLimit",
      msg: "候选较多，已按排序保留最优的一批；放宽/收紧约束可得到不同候选。",
    });
  }

  const candidates = [...leaves.values()].sort((a, b) =>
    a.usedTreadles - b.usedTreadles ||
    a.multiPicks - b.multiPicks ||
    a.totalPresses - b.totalPresses ||
    a.changeCells - b.changeCells);

  return { ok: true, candidates, truncated: truncated || optionsTruncated || poolTruncated, warnings, stats };
}

function bitsOf(m) {
  const out = [];
  let i = 0;
  while (m) { if (m & 1n) out.push(i); m >>= 1n; i++; }
  return out;
}

function sortedUnique(arr) { return [...new Set(arr)].sort((a, b) => a - b); }
