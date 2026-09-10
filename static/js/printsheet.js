// printsheet.js —— 生成含穿综/栓结/踏序/色序/组织图的可打印工艺单
import { analyze } from "./weave.js";
import { estimateYarn } from "./preview.js";
import { formatTime, todayText } from "./utils.js";
import { buildWarpSheet } from "./warpsheet.js";

function makeSheetCanvas(cols, rows, cell) {
  const padL = 24, padT = 16;
  const cv = document.createElement("canvas");
  const scale = 2; // 打印高清
  cv.width = (padL + cols * cell) * scale;
  cv.height = (padT + rows * cell) * scale;
  cv.style.width = padL + cols * cell + "px";
  const ctx = cv.getContext("2d");
  ctx.scale(scale, scale);
  return { cv, ctx, padL, padT, w: padL + cols * cell, h: padT + rows * cell };
}

function title(ctx, text, x, y) {
  ctx.fillStyle = "#33404c";
  ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, y);
}

/** 绘制二进制网格；opts: filled(r,c), fillStyle */
function drawBinaryGrid(ctx, rows, cols, cell, padL, padT, opts = {}) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = padL + c * cell, y = padT + r * cell;
      const style = opts.styleAt ? opts.styleAt(r, c) : (opts.filled(r, c) ? opts.fill || "#33404c" : null);
      if (style) {
        if (style.startsWith("#") || style.startsWith("rgb")) {
          ctx.fillStyle = style;
          ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        }
      }
    }
  }
  ctx.strokeStyle = "#aab4be";
  ctx.lineWidth = .6;
  ctx.beginPath();
  for (let r = 0; r <= rows; r++) {
    ctx.moveTo(padL, padT + r * cell + .3);
    ctx.lineTo(padL + cols * cell, padT + r * cell + .3);
  }
  for (let c = 0; c <= cols; c++) {
    ctx.moveTo(padL + c * cell + .3, padT);
    ctx.lineTo(padL + c * cell + .3, padT + rows * cell);
  }
  ctx.stroke();
  ctx.strokeStyle = "#5a6b7a";
  ctx.lineWidth = 1;
  ctx.strokeRect(padL + .5, padT + .5, cols * cell - 1, rows * cell - 1);
}

/**
 * 在容器内生成完整工艺单 DOM。
 * @param el 容器
 */
export function buildPrintSheet(el, name, d, opts = {}) {
  const a = analyze(d);
  const yarn = estimateYarn(a, d);
  el.innerHTML = "";

  const head = document.createElement("div");
  head.className = "sheet-head";
  head.innerHTML = `<h1>${escapeHtml(name || "多综织物工艺单")}</h1>`;
  const meta = [
    ["生成日期", todayText()],
    ["经纱根数", d.ends],
    ["综框数", d.shafts],
    ["踏板数", d.treadles],
    ["踏序行数", d.picks],
    ["提综逻辑", d.shed === "jack" ? "升综 jack" : "降综 sinking"],
    ["经密/纬密", `${d.settings.epc} / ${d.settings.ppc} 根·cm⁻¹`],
    ["浮长阈值", `经 ≥ ${d.thresholds.warp}，纬 ≥ ${d.thresholds.weft}`],
    ["问题检查", a.issues.length ? a.issues.map((i) => i.msg).join("；") : "无异常"],
  ];
  let mt = "<table><tbody>";
  meta.forEach(([k, v]) => (mt += `<tr><th>${k}</th><td>${escapeHtml(String(v))}</td></tr>`));
  mt += "</tbody></table>";
  head.insertAdjacentHTML("beforeend", mt);
  el.appendChild(head);

  // 自适应格大小：保证大图不超 A4 横向可打印宽度（约 25.7cm ≈ 970px @96dpi）
  const maxW = 940;
  const sCell = Math.max(3, Math.min(14, Math.floor((maxW - 24) / d.ends)));
  const tCell = Math.max(3, Math.min(14, Math.floor((maxW - 24 - 36) / (d.treadles + d.ends))));

  // 穿综（与组织图同宽）
  const th = makeSheetCanvas(d.ends, d.shafts, sCell);
  title(th.ctx, "穿综 THREADING（列＝经纱，自左向右；行＝综框，自上向下）", th.padL, 11);
  drawBinaryGrid(th.ctx, d.shafts, d.ends, sCell, th.padL, th.padT, {
    filled: (s, e) => d.threading[s][e],
  });
  el.appendChild(th.cv);

  // 栓结（左下）+ 踏序（右下，与组织图行对齐）
  const trX = d.treadles * tCell + 8;
  const bottom = makeSheetCanvas(d.treadles + d.ends, d.picks, tCell);
  const bottomTop = 0;
  const bottomBottom = bottomTop + bottom.h;
  const wrap = document.createElement("div");
  wrap.style.position = "relative";
  wrap.style.width = trX + bottom.w + "px";
  wrap.style.height = bottom.h + "px";

  // 栓结画布：底部与踏序底部对齐
  const tu = makeSheetCanvas(d.treadles, d.shafts, tCell);
  const tuTop = bottomBottom - tu.h;
  Object.assign(tu.cv.style, { position: "absolute", left: "0", top: tuTop + "px" });
  title(tu.ctx, "栓结 TIE-UP", tu.padL, 11);
  drawBinaryGrid(tu.ctx, d.shafts, d.treadles, tCell, tu.padL, tu.padT, {
    filled: (s, t) => d.tieup[s][t],
  });
  wrap.appendChild(tu.cv);

  Object.assign(bottom.cv.style, { position: "absolute", left: trX + "px", top: bottomTop + "px" });
  title(bottom.ctx, "踏序 TREADLING（左段）＋ 组织图 DRAWDOWN（右段，红框内为超限浮长）", bottom.padL, 11);
  drawBinaryGrid(bottom.ctx, d.picks, d.treadles, tCell, bottom.padL, bottom.padT, {
    filled: (p, t) => d.treadling[p][t],
  });
  const ddPadL = bottom.padL + d.treadles * tCell;
  // 彩色组织图
  for (let p = 0; p < d.picks; p++) {
    for (let e = 0; e < d.ends; e++) {
      const up = a.face[p][e] === 1;
      const col = up ? (d.palette[d.warpColors[e]] || "#ddd")
                     : (d.palette[d.weftColors[p]] || "#333");
      bottom.ctx.fillStyle = col;
      bottom.ctx.fillRect(ddPadL + e * tCell + 1, bottom.padT + p * tCell + 1, tCell - 2, tCell - 2);
    }
  }
  // 组织图外框
  bottom.ctx.strokeStyle = "#5a6b7a";
  bottom.ctx.strokeRect(ddPadL + .5, bottom.padT + .5, d.ends * tCell - 1, d.picks * tCell - 1);
  // 浮长框
  bottom.ctx.strokeStyle = "#d65a5a";
  bottom.ctx.lineWidth = 1;
  for (const k of a.floatCells) {
    const [p, e] = k.split(",").map(Number);
    bottom.ctx.strokeRect(ddPadL + e * tCell + .8, bottom.padT + p * tCell + .8, tCell - 1.6, tCell - 1.6);
  }
  // 第一纬红线
  bottom.ctx.strokeStyle = "#d65a5a";
  bottom.ctx.strokeRect(bottom.padL + .7, bottom.padT + .7,
                        (d.treadles + d.ends) * tCell - 1.4, tCell - 1.4);
  wrap.appendChild(bottom.cv);
  el.appendChild(wrap);

  // 色序
  const strip = (values, label) => {
    const cell = Math.max(5, Math.min(22, Math.floor(600 / values.length)));
    const cv = document.createElement("canvas");
    const scale = 2;
    const padL = 24, h = 26;
    cv.width = (padL + values.length * cell) * scale;
    cv.height = h * scale;
    cv.style.width = padL + values.length * cell + "px";
    const ctx = cv.getContext("2d");
    ctx.scale(scale, scale);
    title(ctx, label, 2, 11);
    values.forEach((ci, i) => {
      ctx.fillStyle = d.palette[ci] || "#ccc";
      ctx.fillRect(padL + i * cell + 1, 14, cell - 1, h - 15);
      ctx.strokeStyle = "rgba(0,0,0,.25)";
      ctx.strokeRect(padL + i * cell + .5, 14.5, cell - 1, h - 16);
    });
    el.appendChild(cv);
  };
  strip(d.warpColors, "经纱色序（自第 1 根起）");
  strip(d.weftColors, "纬纱色序（自第 1 纬起）");

  // 调色板
  const pal = document.createElement("div");
  pal.style.margin = "6px 0 10px";
  pal.innerHTML = `<b>调色板：</b>` + d.palette.map((c, i) =>
    `<span style="display:inline-block;width:16px;height:16px;background:${c};border:1px solid #777;margin:0 3px;vertical-align:middle"></span>色${i + 1}`).join("&nbsp;&nbsp;");
  el.appendChild(pal);

  // 用纱估算
  const yarnDiv = document.createElement("div");
  yarnDiv.className = "notes";
  yarnDiv.innerHTML = `<h3>用纱估算（幅宽 ${yarn.widthCm} cm × 长度 ${yarn.lengthCm} cm）</h3>
    <p>总经 ${yarn.totalEnds} 根，经纱合计 ${yarn.warpTotalM} m（${yarn.warpWeightG} g）；
       总投纬 ${yarn.totalPicks} 次，纬纱合计 ${yarn.weftTotalM} m（${yarn.weftWeightG} g）；
       预计用纱合计 <b>${yarn.totalWeightG} g</b>。</p>`;
  el.appendChild(yarnDiv);

  const notes = document.createElement("div");
  notes.className = "notes";
  notes.innerHTML = `<h3>提综说明</h3>
    <p>${d.shed === "jack"
      ? "升综（jack）逻辑：栓结表示踏板压下时被提起的综框；经纱所在综框被提起时经纱在上。"
      : "降综（sinking）逻辑：栓结表示踏板压下时被压下的综框；未被压下的综框上的经纱在上。"}
       空梭口：${a.emptyPicks.length ? "第 " + a.emptyPicks.map((p) => p + 1).join("、") + " 纬" : "无"}。
       浮长：经浮 ${a.warpFloats.length} 段，纬浮 ${a.weftFloats.length} 段（红框标于组织图）。</p>`;
  el.appendChild(notes);

  // 已设置整经/穿筘计划时，附加操作单章节
  if (d.warpPlan) {
    const sec = document.createElement("div");
    buildWarpSheet(sec, name, d, { section: true });
    el.appendChild(sec);
  }

  if (opts.standalone) {
    el.classList.add("sheet");
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 应用内打印：把工艺单填进 #printArea 后触发 window.print() */
export function printDraft(name, draft) {
  const area = document.getElementById("printArea");
  const box = document.getElementById("printCanvases");
  const notes = document.getElementById("printNotes");
  buildPrintSheet(box, name, draft);
  const a = analyze(draft);
  notes.textContent = a.issues.length
    ? a.issues.map((i) => "· " + i.msg).join("\n")
    : "检查未发现异常。";
  area.classList.remove("hidden");
  window.print();
  setTimeout(() => area.classList.add("hidden"), 500);
}
