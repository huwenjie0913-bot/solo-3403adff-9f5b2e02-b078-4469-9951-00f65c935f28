// model.js —— 草稿数据模型与示例
import { makeMatrix, resizeMatrix, resizeArray } from "./utils.js";

/**
 * 草稿 draft 结构：
 * {
 *   name, ends, shafts, treadles, picks, shed: 'jack'|'sinking',
 *   threading: S×E 0/1 矩阵（每列至多一个 1）,
 *   tieup:     S×T 0/1,
 *   treadling: P×T 0/1（一行可多踏板；全 0 即空梭口）,
 *   warpColors: [色板索引...] 长度 ends,
 *   weftColors: [色板索引...] 长度 picks,
 *   palette: ['#hex', ...],
 *   thresholds: { warp, weft },
 *   settings: { epc, ppc, repX, repY, width, length,
 *               warpTakeup, weftTakeup, wasteWarp, wasteWeft, warpTex, weftTex },
 *   warpPlan: 整经/穿筘计划（见 warp.js defaultWarpPlan；null 表示尚未设置）
 * }
 */
export function createDraft(partial = {}) {
  const ends = partial.ends ?? 24;
  const shafts = partial.shafts ?? 4;
  const treadles = partial.treadles ?? 4;
  const picks = partial.picks ?? 24;
  return {
    name: partial.name || "未命名织物",
    ends, shafts, treadles, picks,
    shed: partial.shed || "jack",
    threading: partial.threading ? resizeMatrix(partial.threading, shafts, ends)
                                 : makeMatrix(shafts, ends),
    tieup: partial.tieup ? resizeMatrix(partial.tieup, shafts, treadles)
                         : makeMatrix(shafts, treadles),
    treadling: partial.treadling ? resizeMatrix(partial.treadling, picks, treadles)
                                 : makeMatrix(picks, treadles),
    palette: partial.palette || ["#f4f1ea", "#3d3a36", "#b54848", "#3f6d9e", "#d9b24a"],
    warpColors: partial.warpColors ? resizeArray(partial.warpColors, ends, 0)
                                   : new Array(ends).fill(0),
    weftColors: partial.weftColors ? resizeArray(partial.weftColors, picks, 1)
                                   : new Array(picks).fill(1),
    thresholds: { warp: 4, weft: 4, ...(partial.thresholds || {}) },
    settings: {
      epc: 10, ppc: 8, repX: 2, repY: 2,
      width: 20, length: 30,
      warpTakeup: 8, weftTakeup: 6,
      wasteWarp: 60, wasteWeft: 5,
      warpTex: 30, weftTex: 30,
      ...(partial.settings || {}),
    },
    warpPlan: partial.warpPlan || null,
  };
}

/** 按新尺寸重设矩阵（保留旧数据） */
export function applyDimensions(draft, { ends, shafts, treadles, picks }) {
  if (ends != null) {
    draft.ends = Math.max(2, ends);
    draft.threading = resizeMatrix(draft.threading, draft.shafts, draft.ends);
    draft.warpColors = resizeArray(draft.warpColors, draft.ends, 0);
  }
  if (shafts != null) {
    draft.shafts = Math.max(2, shafts);
    draft.threading = resizeMatrix(draft.threading, draft.shafts, draft.ends);
    draft.tieup = resizeMatrix(draft.tieup, draft.shafts, draft.treadles);
  }
  if (treadles != null) {
    draft.treadles = Math.max(2, treadles);
    draft.tieup = resizeMatrix(draft.tieup, draft.shafts, draft.treadles);
    draft.treadling = resizeMatrix(draft.treadling, draft.picks, draft.treadles);
  }
  if (picks != null) {
    draft.picks = Math.max(2, picks);
    draft.treadling = resizeMatrix(draft.treadling, draft.picks, draft.treadles);
    draft.weftColors = resizeArray(draft.weftColors, draft.picks, 1);
  }
}

/** 4 综 4 踏 2/2 斜纹示例（straight draw，平踏直踏，2/2 右斜纹） */
export function sampleDraft() {
  const E = 24, P = 24;
  const d = createDraft({ ends: E, shafts: 4, treadles: 4, picks: P });
  d.name = "2/2 斜纹示例";
  d.palette = ["#f1ece0", "#423e38", "#9c4a3e", "#3e6a92", "#c9a23f"];
  d.warpColors = new Array(E).fill(0);
  d.weftColors = new Array(P).fill(1);
  for (let e = 0; e < E; e++) d.threading[e % 4][e] = 1;           // 顺穿 1,2,3,4
  // 栓结：踏杆 t 提起综框 (t, t+1) mod 4
  for (let t = 0; t < 4; t++) {
    d.tieup[t][t] = 1;
    d.tieup[(t + 1) % 4][t] = 1;
  }
  for (let p = 0; p < P; p++) d.treadling[p][p % 4] = 1;           // 顺踏
  return d;
}
