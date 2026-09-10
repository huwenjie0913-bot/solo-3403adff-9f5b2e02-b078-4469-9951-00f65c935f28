// warpsheet.js —— 整经与穿筘操作单：按束列出用纱汇总与上机次序（可打印）
import { computeWarpPlan } from "./warp.js";
import { todayText } from "./utils.js";

const fmt = (v, d = 1) => (+v).toFixed(d).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * 在容器内生成整经/穿筘操作单。
 * opts.section=true 时作为工艺单的一个章节（小标题）。
 */
export function buildWarpSheet(el, name, draft, opts = {}) {
  const m = opts.model || computeWarpPlan(draft);
  const wp = Object.assign({ reedUnit: "cm", selvShaft: "adjacent" }, draft.warpPlan || {});
  const s = draft.settings;
  const pal = draft.palette;
  el.innerHTML = "";

  const h = document.createElement(opts.section ? "h2" : "h1");
  h.textContent = opts.section ? "整经与穿筘计划" : `${name || "未命名织物"} · 整经与穿筘操作单`;
  el.appendChild(h);

  const unitName = wp.reedUnit === "in" ? "齿/英寸" : "齿/cm";
  const meta = [
    ["生成日期", todayText()],
    ["总经根数", `${m.totals.totalEnds} 根（布身 ${m.totals.bodyEnds} 根${m.selv ? ` ＋ 边纱 ${m.selv}×2` : ""}）`],
    ["筘密", `${wp.reedDensity} ${unitName}（${fmt(m.dpc, 2)} 齿/cm）`],
    ["穿筘模式", `布身每齿 ${m.pattern.join("-")} 根；边纱每齿 ${m.selvPerDent} 根`],
    ["实际经密", `${fmt(m.actualEpc, 2)} 根/cm（目标 ${s.epc}，偏差 ${m.devPct >= 0 ? "+" : ""}${fmt(m.devPct)}%）`],
    ["筘幅占用", `共 ${m.totalDents} 齿 ≈ ${fmt(m.reedWidthCm)} cm`],
    ["单根长度", `${fmt(m.totals.warpLenEach)} cm（成品 ${s.length} cm ÷ (1−经缩 ${s.warpTakeup}%) ＋ 回丝 ${s.wasteWarp} cm）`],
    ["分束", `${m.bouts.length} 束（每束上限 ${m.maxBout} 根）`],
    ["边纱穿法", m.selv ? (wp.selvShaft === "alternate" ? "综框 1/2 交替" : "跟随相邻经纱") : "无边纱"],
  ];
  let mt = `<table><tbody>`;
  meta.forEach(([k, v]) => (mt += `<tr><th>${k}</th><td>${esc(v)}</td></tr>`));
  mt += `</tbody></table>`;
  const metaDiv = document.createElement("div");
  metaDiv.innerHTML = mt;
  el.appendChild(metaDiv);

  const chip = (ci) =>
    `<span style="display:inline-block;width:9px;height:9px;background:${pal[ci] || "#ccc"};` +
    `border:1px solid #777;margin:0 2px 0 5px;vertical-align:-1px"></span>`;

  // 分束整经表（含每束各色根数与用量）
  let bt = `<h3>分束整经表（整经顺序：束 1 → ${m.bouts.length}，自布左向布右；单根长 ${fmt(m.totals.warpLenEach)} cm）</h3>
    <table><thead><tr><th>束</th><th>经纱范围</th><th>根数</th><th>分色根数</th><th>起始齿</th>
    <th>合计长 m</th><th>用纱 g</th><th>完成</th></tr></thead><tbody>`;
  m.bouts.forEach((b) => {
    const colors = Object.keys(b.colors).map((ci) => `${chip(ci)}色${+ci + 1}×${b.colors[ci]}`).join(" ");
    bt += `<tr><td>${b.idx + 1}</td><td>第 ${b.start + 1}–${b.end} 根</td><td>${b.count}</td>`
      + `<td>${colors}</td><td>${b.startDent}</td><td>${fmt(b.totalM)}</td><td>${fmt(b.weightG)}</td><td>☐</td></tr>`;
  });
  bt += `<tr><th>合计</th><th>—</th><th>${m.totals.totalEnds}</th><th>—</th><th>—</th>`
    + `<th>${fmt(m.totals.totalM)}</th><th>${fmt(m.totals.weightG)}</th><th></th></tr></tbody></table>`;
  const boutDiv = document.createElement("div");
  boutDiv.innerHTML = bt;
  el.appendChild(boutDiv);

  // 全幅分色汇总
  let ct = `<h3>全幅经纱分色汇总</h3><table><thead><tr><th>颜色</th><th>根数</th><th>长度 m</th><th>质量 g</th></tr></thead><tbody>`;
  m.totals.byColor.forEach((c) => {
    ct += `<tr><td>${chip(c.color)} 色 ${c.color + 1}</td><td>${c.ends}</td>`
      + `<td>${fmt(c.lengthM)}</td><td>${fmt(c.weightG)}</td></tr>`;
  });
  ct += `<tr><th>合计</th><th>${m.totals.totalEnds}</th><th>${fmt(m.totals.totalM)}</th>`
    + `<th>${fmt(m.totals.weightG)}</th></tr></tbody></table>`;
  const colorDiv = document.createElement("div");
  colorDiv.innerHTML = ct;
  el.appendChild(colorDiv);

  // 上机次序
  let ot = `<h3>上机次序</h3><ol>`;
  m.bouts.forEach((b) => {
    const colors = Object.keys(b.colors).map((ci) => `色${+ci + 1}×${b.colors[ci]}`).join("、");
    ot += `<li>束 ${b.idx + 1}：第 ${b.start + 1}–${b.end} 根（${b.count} 根；${colors}），自第 ${b.startDent} 齿起穿筘。</li>`;
  });
  ot += `</ol><p>穿综：布身按穿综图自第 1 列起循环（布身第 1 根＝图列 1）`
    + (m.selv ? `；边纱${wp.selvShaft === "alternate" ? "按综框 1/2 交替" : "跟随相邻经纱"}` : "")
    + `。穿筘：自布左第 1 齿起，布身按每齿 ${m.pattern.join("、")} 根循环，边纱每齿 ${m.selvPerDent} 根。`
    + `单根下机长度 ${fmt(m.totals.warpLenEach)} cm。</p>`;
  const ordDiv = document.createElement("div");
  ordDiv.innerHTML = ot;
  el.appendChild(ordDiv);

  // 检查
  const iss = document.createElement("div");
  iss.innerHTML = `<h3>检查提示</h3><p>${m.issues.length
    ? m.issues.map((i) => "· " + esc(i.msg)).join("<br>")
    : "检查未发现异常。"}</p>`;
  el.appendChild(iss);
}

/** 应用内打印：把操作单填进 #printArea 后触发 window.print() */
export function printWarpSheet(name, draft) {
  const area = document.getElementById("printArea");
  const box = document.getElementById("printCanvases");
  const notes = document.getElementById("printNotes");
  buildWarpSheet(box, name, draft);
  notes.textContent = "上机顺序：整经 → 穿综 → 穿筘；每束完成后在表内打勾。进度在“逐根上机视图”中逐根记录。";
  area.classList.remove("hidden");
  window.print();
  setTimeout(() => area.classList.add("hidden"), 500);
}
