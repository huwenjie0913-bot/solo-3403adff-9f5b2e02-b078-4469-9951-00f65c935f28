// compare.js —— 两个草稿快照的并排差异比较
import { analyze } from "./weave.js";

/**
 * 把整个草图（穿综+栓结+踏序+组织图）画到一张 canvas 上。
 * 若提供 diff(diffGrid.set 查 r,c)，差异格用黄底标出。
 */
export function renderDraftComposite(canvas, draft, diffGrid) {
  const a = analyze(draft);
  const { ends, shafts, treadles, picks, palette, warpColors, weftColors } = draft;
  const cell = 6;
  const padL = 8, padT = 8, gap = 3;
  // 穿综在上；栓结在左下；踏序+组织图在右下
  const bottomW = treadles * cell + 4 + ends * cell;
  const w = padL + Math.max(ends * cell, bottomW) + 6;
  const h = padT + shafts * cell + gap + picks * cell + 8;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);

  // 穿综
  for (let s = 0; s < shafts; s++)
    for (let e = 0; e < ends; e++) {
      const x = padL + e * cell, y = padT + s * cell;
      if (diffGrid?.threading.has(s + "," + e)) {
        ctx.fillStyle = "#f3e08a"; ctx.fillRect(x, y, cell, cell);
      }
      if (draft.threading[s][e]) { ctx.fillStyle = "#2f6ea8"; ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2); }
    }
  grid(ctx, padL, padT, ends, shafts, cell);

  // 栓结（左下，底部对齐踏序）
  const tieY = padT + shafts * cell + gap + (picks - shafts) * cell;
  for (let s = 0; s < shafts; s++)
    for (let t = 0; t < treadles; t++) {
      const x = padL + t * cell, y = tieY + s * cell;
      if (diffGrid?.tieup.has(s + "," + t)) {
        ctx.fillStyle = "#f3e08a"; ctx.fillRect(x, y, cell, cell);
      }
      if (draft.tieup[s][t]) { ctx.fillStyle = "#2f6ea8"; ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2); }
    }
  grid(ctx, padL, tieY, treadles, shafts, cell);

  // 踏序 + 组织图
  const bottomY = padT + shafts * cell + gap;
  const trX = padL + treadles * cell + 4;
  for (let p = 0; p < picks; p++)
    for (let t = 0; t < treadles; t++) {
      const x = padL + t * cell, y = bottomY + p * cell;
      if (diffGrid?.treadling.has(p + "," + t)) {
        ctx.fillStyle = "#f3e08a"; ctx.fillRect(x, y, cell, cell);
      }
      if (draft.treadling[p][t]) { ctx.fillStyle = "#2f6ea8"; ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2); }
    }
  grid(ctx, padL, bottomY, treadles, picks, cell);
  for (let p = 0; p < picks; p++)
    for (let e = 0; e < ends; e++) {
      const x = trX + e * cell, y = bottomY + p * cell;
      if (diffGrid?.face.has(p + "," + e)) { ctx.fillStyle = "#f3e08a"; ctx.fillRect(x, y, cell, cell); }
      const up = a.face[p][e] === 1;
      ctx.fillStyle = up ? (palette[warpColors[e]] || "#ddd")
                         : (palette[weftColors[p]] || "#333");
      ctx.fillRect(x, y, cell, cell);
    }
  grid(ctx, trX, bottomY, ends, picks, cell);

  // 色序细条
  const seqY = bottomY + picks * cell + 1;
  for (let e = 0; e < ends; e++) {
    ctx.fillStyle = palette[warpColors[e]] || "#ccc";
    ctx.fillRect(trX + e * cell, seqY, cell, 3);
  }
  for (let p = 0; p < picks; p++) {
    ctx.fillStyle = palette[weftColors[p]] || "#ccc";
    ctx.fillRect(padL - 3, bottomY + p * cell, 3, cell);
  }

  // 小标注
  ctx.fillStyle = "#8a96a2";
  ctx.font = "8px sans-serif";
  ctx.fillText("穿综", 1, padT + 6);
  ctx.fillText("栓", 1, tieY + 6);
}

function grid(ctx, x0, y0, cols, rows, cell) {
  ctx.strokeStyle = "#cdd5dd";
  ctx.lineWidth = .5;
  ctx.beginPath();
  for (let r = 0; r <= rows; r++) { ctx.moveTo(x0, y0 + r * cell); ctx.lineTo(x0 + cols * cell, y0 + r * cell); }
  for (let c = 0; c <= cols; c++) { ctx.moveTo(x0 + c * cell, y0); ctx.lineTo(x0 + c * cell, y0 + rows * cell); }
  ctx.stroke();
}

/** 计算 A 相对 B 的差异统计与格集合 */
export function diffDrafts(b, a) {
  const sets = { threading: new Set(), tieup: new Set(), treadling: new Set(), face: new Set() };
  const dim = {
    endsChanged: a.ends !== b.ends || a.picks !== b.picks || a.shafts !== b.shafts || a.treadles !== b.treadles,
  };
  const cmp = (mA, mB, set, name) => {
    for (let r = 0; r < Math.max(mA.length, mB.length); r++)
      for (let c = 0; c < Math.max(mA[0]?.length || 0, mB[0]?.length || 0); c++) {
        const va = mA[r]?.[c] ?? 0, vb = mB[r]?.[c] ?? 0;
        if (va !== vb) {
          set.add(r + "," + c);
          if (name === "face") sets.face.add(r + "," + c);
        }
      }
  };
  cmp(a.threading, b.threading, sets.threading);
  cmp(a.tieup, b.tieup, sets.tieup);
  cmp(a.treadling, b.treadling, sets.treadling);
  const fa = analyze(a).face, fb = analyze(b).face;
  for (let p = 0; p < Math.max(fa.length, fb.length); p++)
    for (let e = 0; e < Math.max(fa[0]?.length || 0, fb[0]?.length || 0); e++)
      if ((fa[p]?.[e] ?? 0) !== (fb[p]?.[e] ?? 0)) sets.face.add(p + "," + e);

  const counts = {
    threading: sets.threading.size,
    tieup: sets.tieup.size,
    treadling: sets.treadling.size,
    face: sets.face.size,
  };
  let colorDiff = 0;
  for (let i = 0; i < Math.max(a.warpColors.length, b.warpColors.length); i++)
    if ((a.warpColors[i] ?? -1) !== (b.warpColors[i] ?? -1)) colorDiff++;
  for (let i = 0; i < Math.max(a.weftColors.length, b.weftColors.length); i++)
    if ((a.weftColors[i] ?? -1) !== (b.weftColors[i] ?? -1)) colorDiff++;
  counts.colors = colorDiff;
  return { sets, counts, dim };
}
