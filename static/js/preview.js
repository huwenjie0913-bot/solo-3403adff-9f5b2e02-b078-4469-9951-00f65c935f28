// preview.js —— 布面重复预览与经纬纱用量估算
import { hexToRgb, mixHex } from "./utils.js";

/**
 * 布面预览：按组织图与色序平铺 repX×repY 次，并按密度比例确定格大小。
 */
export function renderPreview(canvas, analysis, draft) {
  const { face } = analysis;
  const { ends, picks, palette, warpColors, weftColors, settings } = draft;
  const { epc, ppc, repX, repY } = settings;
  const PX_PER_CM = 3.2;

  const colE = Math.max(1, PX_PER_CM / epc);   // 每经像素
  const colP = Math.max(1, PX_PER_CM / ppc);   // 每纬像素
  const totW = Math.round(ends * repX * colE);
  const totH = Math.round(picks * repY * colP);

  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = totW + "px";
  canvas.style.height = totH + "px";
  canvas.width = Math.round(totW * dpr);
  canvas.height = Math.round(totH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // 离屏：一个组织循环
  const tile = document.createElement("canvas");
  tile.width = ends;
  tile.height = picks;
  const tctx = tile.getContext("2d");
  const img = tctx.createImageData(ends, picks);
  for (let p = 0; p < picks; p++) {
    for (let e = 0; e < ends; e++) {
      const wc = palette[warpColors[e]] || "#cccccc";
      const fc = palette[weftColors[p]] || "#333333";
      const up = face[p][e] === 1;
      const col = up ? wc : fc;
      const [r, g, b] = hexToRgb(col);
      const i = (p * ends + e) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  tctx.putImageData(img, 0, 0);

  ctx.imageSmoothingEnabled = false;
  for (let ry = 0; ry < repY; ry++)
    for (let rx = 0; rx < repX; rx++)
      ctx.drawImage(tile, 0, 0, ends, picks,
                    Math.round(rx * ends * colE), Math.round(ry * picks * colP),
                    Math.ceil(ends * colE), Math.ceil(picks * colP));

  return {
    widthCm: +(ends * repX / epc).toFixed(1),
    heightCm: +(picks * repY / ppc).toFixed(1),
  };
}

/**
 * 用纱估算（基于设定的成品幅宽/长度，自动推算需要的组织循环与总根数）。
 * 长度单位 cm；质量用线密度 tex（g/km）。
 */
export function estimateYarn(analysis, draft) {
  const s = draft.settings;
  const epc = +s.epc, ppc = +s.ppc;
  const widthCm = +s.width, lengthCm = +s.length;
  const warpTake = +s.warpTakeup / 100;
  const weftTake = +s.weftTakeup / 100;
  const wasteWarp = +s.wasteWarp;       // 每根经纱上机回丝 cm
  const wasteWeftPct = +s.wasteWeft / 100;
  const warpTex = +s.warpTex || 0;
  const weftTex = +s.weftTex || 0;

  const E = draft.ends, P = draft.picks;
  const totalEnds = Math.round(widthCm * epc);
  const totalPicks = Math.round(lengthCm * ppc);
  const repsX = totalEnds / E;
  const repsY = totalPicks / P;

  // 经纱长度 = 成品长 / (1-缩率) + 回丝
  const warpLenEach = lengthCm / (1 - warpTake) + wasteWarp;
  const warpTotalM = totalEnds * warpLenEach / 100;
  // 纬纱长度 = 幅宽 / (1-缩率)，再加边纱回丝率
  const weftLenEach = widthCm / (1 - weftTake);
  const weftTotalM = totalPicks * weftLenEach / 100 * (1 + wasteWeftPct);

  const gPerKm = (tex, km) => tex * km;
  const warpWeightG = gPerKm(warpTex, warpTotalM / 1000);
  const weftWeightG = gPerKm(weftTex, weftTotalM / 1000);

  // 按色拆分
  const warpByColor = countByColor(draft.warpColors, repsX);
  const weftByColor = countByColor(draft.weftColors, repsY);

  return {
    E, P, totalEnds, totalPicks, repsX: +repsX.toFixed(2), repsY: +repsY.toFixed(2),
    widthCm, lengthCm,
    warpLenEach: +warpLenEach.toFixed(1),
    weftLenEach: +weftLenEach.toFixed(1),
    warpTotalM: +warpTotalM.toFixed(2),
    weftTotalM: +weftTotalM.toFixed(2),
    warpWeightG: +warpWeightG.toFixed(1),
    weftWeightG: +weftWeightG.toFixed(1),
    totalWeightG: +(warpWeightG + weftWeightG).toFixed(1),
    warpByColor: warpByColor.map((n) => ({ ends: n, lengthM: +(n * warpLenEach / 100).toFixed(2),
                                          weightG: +(n * warpLenEach / 100 / 1000 * warpTex).toFixed(1) })),
    weftByColor: weftByColor.map((n) => ({ picks: n, lengthM: +(n * weftLenEach / 100 * (1 + wasteWeftPct)).toFixed(2),
                                          weightG: +(n * weftLenEach / 100 * (1 + wasteWeftPct) / 1000 * weftTex).toFixed(1) })),
    palette: draft.palette,
  };
}

function countByColor(seq, reps) {
  const counts = {};
  const full = Math.floor(reps);
  const frac = reps - full;
  seq.forEach((ci) => { counts[ci] = (counts[ci] || 0) + full; });
  let acc = 0;
  for (let i = 0; i < seq.length && acc / seq.length < frac; i++, acc++) {
    counts[seq[i]] = (counts[seq[i]] || 0) + 1;
  }
  const maxIdx = Math.max(...seq, 0);
  const out = [];
  for (let i = 0; i <= maxIdx; i++) out.push(Math.round(counts[i] || 0));
  return out;
}

/** 生成估算结果 HTML（app 中直接填充） */
export function yarnHtml(r) {
  const row = (label, val, sub = false) =>
    `<tr class="${sub ? "sub" : ""}"><td>${label}</td><td>${val}</td></tr>`;
  const colorHex = (i) => r.palette[i] || "#ccc";
  let html = `<table>
    <tbody>
      ${row("总经纱根数", `${r.totalEnds} 根（图案横重复 ${r.repsX} 次）`)}
      ${row("总投纬次数", `${r.totalPicks} 纬（图案纵重复 ${r.repsY} 次）`)}
      ${row("单根经纱长度", `${r.warpLenEach} cm（含回丝）`)}
      ${row("单次投纬长度", `${r.weftLenEach} cm（含缩率）`)}
      ${row("经纱总长度", `${r.warpTotalM} m`, true)}
      ${row("纬纱总长度", `${r.weftTotalM} m`, true)}
      ${row("经纱总质量", `${r.warpWeightG} g`, true)}
      ${row("纬纱总质量", `${r.weftWeightG} g`, true)}
      ${row("预计用纱合计", `${r.totalWeightG} g`, true)}
    </tbody></table>
    <h4 style="margin-top:10px">经纱分色</h4><table><tbody>`;
  r.warpByColor.forEach((v, i) => {
    if (!v.ends) return;
    html += `<tr class="yarn-bycolor"><td><span style="display:inline-block;width:10px;height:10px;background:${colorHex(i)};border:1px solid #999;margin-right:4px"></span>色 ${i + 1}</td>
      <td>${v.ends} 根 · ${v.lengthM} m · ${v.weightG} g</td></tr>`;
  });
  html += `</tbody></table><h4>纬纱分色</h4><table><tbody>`;
  r.weftByColor.forEach((v, i) => {
    if (!v.picks) return;
    html += `<tr class="yarn-bycolor"><td><span style="display:inline-block;width:10px;height:10px;background:${colorHex(i)};border:1px solid #999;margin-right:4px"></span>色 ${i + 1}</td>
      <td>${v.picks} 纬 · ${v.lengthM} m · ${v.weightG} g</td></tr>`;
  });
  html += `</tbody></table>`;
  return html;
}

export { mixHex };
