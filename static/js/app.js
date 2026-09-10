// app.js —— 主控制器：UI 绑定、状态管理、撤销重做、项目/版本、导入导出
import { $, $$, deepClone, debounce, formatTime } from "./utils.js";
import { createDraft, applyDimensions, sampleDraft } from "./model.js";
import { analyze } from "./weave.js";
import { DraftGrid, ColorStrip } from "./grids.js";
import { renderPreview, estimateYarn, yarnHtml } from "./preview.js";
import { exportWIF, importWIF } from "./wif.js";
import { printDraft } from "./printsheet.js";
import { renderDraftComposite, diffDrafts } from "./compare.js";
import { api } from "./api.js";
import {
  computeWarpPlan, defaultWarpPlan, suggestDentPattern, dentsPerCm,
  parsePattern, setBoutSize, ensureProgress, STAGES,
} from "./warp.js";
import { WarpView } from "./warpview.js";
import { printWarpSheet } from "./warpsheet.js";

// --------------------------------------------------------------------------- //
// 状态
// --------------------------------------------------------------------------- //
let draft = createDraft();
let currentProjectId = null;
let activeColor = 0;
let currentTool = "paint";
let analysis = null;

const undoStack = [];
const redoStack = [];
const HISTORY_MAX = 80;

function snapshot(label) {
  const clone = deepClone(draft);
  // 与栈顶相同则不重复入栈（例如同一次拖动触发多次 begin）
  const top = undoStack[undoStack.length - 1];
  if (top && JSON.stringify(top.d) === JSON.stringify(clone)) return;
  undoStack.push({ label, d: clone });
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
  markDirty();
  updateHistoryButtons();
}
function restore(s) {
  draft = s.d;
  rebuildFromDraft();
  markDirty();
}
function undo() {
  const s = undoStack.pop();
  if (!s) return;
  redoStack.push({ label: s.label, d: deepClone(draft) });
  restore(s);
  setStatus("已撤销：" + s.label);
}
function redo() {
  const s = redoStack.pop();
  if (!s) return;
  undoStack.push({ label: s.label, d: deepClone(draft) });
  restore(s);
  setStatus("已重做：" + s.label);
}
function updateHistoryButtons() {
  $("#btnUndo").disabled = undoStack.length === 0;
  $("#btnRedo").disabled = redoStack.length === 0;
}

// --------------------------------------------------------------------------- //
// 网格
// --------------------------------------------------------------------------- //
let gThread, gTie, gTread, gDraw, gLift, cWarp, cWeft;

function buildGrids() {
  gThread = new DraftGrid({
    canvas: $("#cvThreading"), kind: "threading",
    rows: draft.shafts, cols: draft.ends, singlePerColumn: true,
    onChange: () => recompute(),
    onBeginEdit: () => snapshot("穿综编辑"),
  });
  gTie = new DraftGrid({
    canvas: $("#cvTieup"), kind: "tieup",
    rows: draft.shafts, cols: draft.treadles,
    onChange: () => recompute(),
    onBeginEdit: () => snapshot("栓结编辑"),
  });
  gTread = new DraftGrid({
    canvas: $("#cvTreadling"), kind: "treadling",
    rows: draft.picks, cols: draft.treadles,
    onChange: () => recompute(),
    onBeginEdit: () => snapshot("踏序编辑"),
  });
  gDraw = new DraftGrid({
    canvas: $("#cvDrawdown"), kind: "drawdown",
    rows: draft.picks, cols: draft.ends, readOnly: true,
  });
  gLift = new DraftGrid({
    canvas: $("#cvLift"), kind: "lift",
    rows: draft.picks, cols: draft.shafts, readOnly: true,
    cellDefault: 13,
  });
  cWarp = new ColorStrip({
    canvas: $("#cvWarpColors"),
    palette: draft.palette, values: draft.warpColors,
    onChange: () => recompute(),
    onBeginEdit: () => snapshot("经纱色序"),
  });
  cWeft = new ColorStrip({
    canvas: $("#cvWeftColors"),
    palette: draft.palette, values: draft.weftColors,
    onChange: () => recompute(),
    onBeginEdit: () => snapshot("纬纱色序"),
  });
  setTool(currentTool);
}

function rebuildFromDraft() {
  // 输入控件同步
  $("#inpEnds").value = draft.ends;
  $("#inpShafts").value = draft.shafts;
  $("#inpTreadles").value = draft.treadles;
  $("#inpPicks").value = draft.picks;
  $("#selShed").value = draft.shed;
  $("#inpWarpFloat").value = draft.thresholds.warp;
  $("#inpWeftFloat").value = draft.thresholds.weft;
  $("#projectName").value = draft.name;

  gThread.setMatrix(draft.threading);
  gTie.setMatrix(draft.tieup);
  gTread.setMatrix(draft.treadling);
  cWarp.setValues(draft.warpColors, draft.palette);
  cWeft.setValues(draft.weftColors, draft.palette);
  cWarp.activeColor = activeColor;
  cWeft.activeColor = activeColor;

  syncSettingsInputs();
  syncWarpInputs();
  warpModel = null;
  warpBoundsCustom = false;
  warpHist.length = 0;
  renderPalette();
  recompute();
}

function setTool(t) {
  currentTool = t;
  $$("#toolGrid .tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
  [gThread, gTie, gTread].forEach((g) => g && g.setTool(t));
}

// --------------------------------------------------------------------------- //
// 推演与渲染
// --------------------------------------------------------------------------- //
function recompute() {
  analysis = analyze(draft);
  if (gDraw.rows !== draft.picks || gDraw.cols !== draft.ends) {
    gDraw.rows = draft.picks;
    gDraw.cols = draft.ends;
    gDraw.resize();
  }
  gDraw.data = analysis.face;
  gDraw.floatCells = analysis.floatCells;
  gDraw.cellColor = (p, e, v) => {
    const mono = $("#drawdownMode").value === "mono";
    if (mono) return v ? "#f4f1ea" : "#3a3a3a";
    return v ? (draft.palette[draft.warpColors[e]] || "#ddd")
             : (draft.palette[draft.weftColors[p]] || "#333");
  };
  gDraw.rowEmpty = (p) => analysis.emptyPicks.includes(p);

  if (gLift.rows !== draft.picks || gLift.cols !== draft.shafts) {
    gLift.rows = draft.picks;
    gLift.cols = draft.shafts;
    gLift.resize();
  }
  gLift.data = analysis.lift;
  gLift.rowEmpty = (p) => analysis.emptyPicks.includes(p);

  // 标记未使用综框/踏板（在各自编辑网格中）
  const unusedS = new Set(), unusedT = new Set();
  for (const iss of analysis.issues) {
    if (iss.kind === "unusedShaft") iss.shafts.forEach((s) => unusedS.add(s));
    if (iss.kind === "unusedTreadle") iss.treadles.forEach((t) => unusedT.add(t));
  }
  gThread.colBad = () => false;
  gThread.rowBad = (s) => unusedS.has(s);
  gTie.rowBad = (s) => unusedS.has(s);
  gTie.colBad = (t) => unusedT.has(t);
  gTread.colBad = (t) => unusedT.has(t);
  gTread.rowEmpty = (p) => analysis.emptyPicks.includes(p);
  gLift.rowBad = (s) => unusedS.has(s);

  [gThread, gTie, gTread, gDraw, gLift].forEach((g) => g.draw());
  renderIssues();
  renderPreviewSafe();
  renderYarn();
  renderSeqLengths();
  renderWarpSafe();
}

// --------------------------------------------------------------------------- //
// 问题面板（点击定位）
// --------------------------------------------------------------------------- //
const GRIDS = { threading: () => gThread, tieup: () => gTie, treadling: () => gTread,
                drawdown: () => gDraw, lift: () => gLift };

function renderIssues() {
  const ul = $("#issueList");
  const sum = $("#issueSummary");
  const issues = analysis.issues;
  if (!issues.length) {
    sum.className = "issue-summary ok";
    sum.textContent = "✓ 检查通过：没有空梭口、未穿经或超限浮长。";
    ul.innerHTML = "";
    return;
  }
  const errs = issues.filter((i) => i.level === "error").length;
  const warns = issues.length - errs;
  sum.className = "issue-summary warn";
  sum.textContent = `发现 ${errs} 个错误、${warns} 个警告，共 ${issues.length} 项。点击条目可定位。`;

  const items = [];
  for (const iss of issues) {
    const ico = iss.level === "error" ? "⛔" : iss.level === "warn" ? "⚠️" : "ℹ️";
    items.push(makeIssueItem(ico, iss, iss.msg, iss.loc));
    // 浮长：每段生成可定位子项
    if (iss.kind === "warpFloat") {
      iss.floats.slice(0, 60).forEach((f) => {
        items.push(makeIssueItem("▸", iss,
          `经浮长 ${f.len}：第 ${f.r1 + 1}–${f.r2 + 1} 纬横跨经纱 ${f.c + 1}`,
          { grid: "drawdown", r: f.r1, c: f.c }));
      });
    }
    if (iss.kind === "weftFloat") {
      iss.floats.slice(0, 60).forEach((f) => {
        items.push(makeIssueItem("▸", iss,
          `纬浮长 ${f.len}：第 ${f.r + 1} 纬的经纱 ${f.c1 + 1}–${f.c2 + 1}`,
          { grid: "drawdown", r: f.r, c: f.c1 }));
      });
    }
    if (iss.kind === "unthreaded") {
      iss.ends.slice(0, 60).forEach((e) => {
        items.push(makeIssueItem("▸", iss, `第 ${e + 1} 根经纱未穿综`,
          { grid: "threading", r: 0, c: e }));
      });
    }
    if (iss.kind === "empty") {
      items[items.length - 1].loc2 = { grid: "lift", r: iss.loc.r, c: 0 };
    }
  }
  ul.innerHTML = "";
  items.forEach((it) => {
    const li = document.createElement("li");
    li.className = it.iss.level === "error" ? "error" : it.iss.level === "info" ? "info" : "warn";
    li.innerHTML = `<span class="ico">${it.ico}</span><span>${it.text}</span>`;
    li.title = "点击定位";
    li.addEventListener("click", () => locateIssue(it.loc, it.loc2));
    ul.appendChild(li);
  });
}

function makeIssueItem(ico, iss, text, loc) { return { ico, iss, text, loc }; }

function locateIssue(loc, loc2) {
  if (!loc) return;
  const g = GRIDS[loc.grid]?.();
  if (!g) return;
  g.locate(loc.r, loc.c);
  // 联动：组织图问题同时在踏序/提综图标记该纬
  if (loc.grid === "drawdown") {
    gTread.locate(loc.r, 0);
    gLift.locate(loc.r, 0);
  }
  if (loc.grid === "threading") {
    gDraw.locate(0, loc.c);
  }
  if (loc2) {
    const g2 = GRIDS[loc2.grid]?.();
    if (g2) g2.locate(loc2.r, loc2.c);
  }
  setStatus(`已定位：${loc.grid} 行 ${loc.r + 1}，列 ${loc.c + 1}`);
}

// --------------------------------------------------------------------------- //
// 色序与调色板
// --------------------------------------------------------------------------- //
function renderPalette() {
  const box = $("#palette");
  box.innerHTML = "";
  draft.palette.forEach((col, i) => {
    const sw = document.createElement("span");
    sw.className = "swatch" + (i === activeColor ? " active" : "");
    sw.style.background = col;
    sw.title = `色 ${i + 1} ${col}（点击选用）`;
    sw.addEventListener("click", () => {
      activeColor = i;
      renderPalette();
      // 让两条色条的画笔立刻使用新选中的颜色
      cWarp.activeColor = i;
      cWeft.activeColor = i;
      $("#paletteColor").value = col;
    });
    box.appendChild(sw);
  });
}

function renderSeqLengths() {
  $("#warpSeqLen").textContent = `（${draft.ends} 格）`;
  $("#weftSeqLen").textContent = `（${draft.picks} 格）`;
}

// --------------------------------------------------------------------------- //
// 布面预览 & 用纱
// --------------------------------------------------------------------------- //
function renderPreviewSafe() {
  if (!$(".tabpage[data-tab='preview']").classList.contains("active")) return;
  const size = renderPreview($("#cvPreview"), analysis, draft);
  $("#previewSize").textContent =
    `预览布面约 ${size.widthCm} cm（宽）× ${size.heightCm} cm（高）`;
}

function renderYarn() {
  if (!$(".tabpage[data-tab='yarn']").classList.contains("active")) return;
  const r = estimateYarn(analysis, draft);
  $("#yarnResults").innerHTML = yarnHtml(r);
}

function syncSettingsInputs() {
  const s = draft.settings;
  $("#inpEpc").value = s.epc;
  $("#inpPpc").value = s.ppc;
  $("#inpRepX").value = s.repX;
  $("#inpRepY").value = s.repY;
  $("#inpWidth").value = s.width;
  $("#inpLength").value = s.length;
  $("#inpWarpTakeup").value = s.warpTakeup;
  $("#inpWeftTakeup").value = s.weftTakeup;
  $("#inpWasteWarp").value = s.wasteWarp;
  $("#inpWasteWeft").value = s.wasteWeft;
  $("#inpWarpTex").value = s.warpTex;
  $("#inpWeftTex").value = s.weftTex;
}

// --------------------------------------------------------------------------- //
// 整经与穿筘规划（只读草稿数据，计划与进度存于 draft.warpPlan，随项目/版本保存）
// --------------------------------------------------------------------------- //
let warpModel = null;          // 当前计算结果
let warpView = null;           // 逐根上机视图组件
let warpStageIdx = 0;          // 当前勾选阶段（STAGES 下标）
let warpBoundsCustom = false;  // 用户是否手动调过束界（未手动时随上限自动重排）
const warpHist = [];           // 勾选历史（回退修正用）

function ensureWarpPlan() {
  if (!draft.warpPlan) {
    const wp = defaultWarpPlan();
    const epc = +draft.settings.epc || 10;
    wp.reedDensity = Math.max(1, Math.round(epc / 2 * 2) / 2);   // 默认每齿 2 根起步
    wp.dentPattern = suggestDentPattern(epc, dentsPerCm(wp));
    draft.warpPlan = wp;
    markDirty();
  }
  return draft.warpPlan;
}

function recalcWarp() {
  const wp = ensureWarpPlan();
  warpModel = computeWarpPlan(draft);
  wp.boutBounds = warpModel.bounds.slice();   // 自动边界写回，便于手动微调
  const m = warpModel;
  $("#warpSource").textContent =
    `布身 ${m.totals.bodyEnds} 根（幅宽 ${draft.settings.width} cm × 经密 ${draft.settings.epc}）` +
    (m.selv ? ` ＋ 边纱 ${m.selv}×2` : "") +
    ` ＝ 总经 ${m.totals.totalEnds} 根 · 组织循环 ${draft.ends} 根 · ` +
    `单根长 ${m.totals.warpLenEach.toFixed(1)} cm（含缩率回丝）`;
  $("#wpReedInfo").textContent = m.dpc > 0
    ? `筘 ${m.dpc.toFixed(2)} 齿/cm · 布身 ${m.bodyDents} 齿（平均 ${m.avgPerDent.toFixed(2)} 根/齿）· ` +
      `实际经密 ${m.actualEpc.toFixed(2)} 根/cm（偏差 ${m.devPct >= 0 ? "+" : ""}${m.devPct.toFixed(1)}%）· ` +
      `全幅 ${m.totalDents} 齿 ≈ 筘幅 ${m.reedWidthCm.toFixed(1)} cm`
    : "请设置有效筘密。";
  renderBoutList();
  renderWarpIssues();
}

function renderWarpSafe() {
  const tabActive = $(".tabpage[data-tab='warp']").classList.contains("active");
  const modalOpen = !$("#warpModal").classList.contains("hidden");
  if (tabActive || modalOpen) {
    recalcWarp();
    if (modalOpen && warpView) {
      const wp = ensureWarpPlan();
      const prog = ensureProgress(wp, warpModel.totals.totalEnds);
      warpView.setModel(warpModel, draft.palette, prog);
      updateWarpStatus();
    }
  } else {
    warpModel = null;   // 草稿已变，下次打开标签页时重算
  }
}

function syncWarpInputs() {
  const wp = draft.warpPlan;
  if (!wp) return;
  $("#wpReed").value = wp.reedDensity;
  $("#wpReedUnit").value = wp.reedUnit;
  $("#wpPattern").value = (wp.dentPattern || []).join(",");
  $("#wpSelvEnds").value = wp.selvEnds;
  $("#wpSelvPerDent").value = wp.selvPerDent;
  $("#wpSelvShaft").value = wp.selvShaft;
  $("#wpMaxBout").value = wp.maxBout;
}

function renderBoutList() {
  const m = warpModel;
  const box = $("#wpBoutList");
  box.innerHTML = "";
  const tbl = document.createElement("table");
  tbl.className = "bout-table";
  tbl.innerHTML = `<thead><tr><th>束</th><th>经纱范围</th><th>根数</th><th>分色</th><th>用量</th></tr></thead>`;
  const tb = document.createElement("tbody");
  m.bouts.forEach((bt, k) => {
    const tr = document.createElement("tr");
    const chips = Object.keys(bt.colors).map((ci) =>
      `<span class="chip" style="background:${draft.palette[ci] || "#ccc"}"></span>${bt.colors[ci]}`).join(" ");
    tr.innerHTML = `<td>${k + 1}</td><td class="dim">${bt.start + 1}–${bt.end}</td><td></td>` +
      `<td>${chips}</td><td class="dim">${bt.totalM.toFixed(1)} m · ${bt.weightG.toFixed(1)} g</td>`;
    const tdN = tr.children[2];
    if (k < m.bouts.length - 1) {
      const inp = document.createElement("input");
      inp.type = "number"; inp.min = 1; inp.max = m.totals.totalEnds - 1; inp.value = bt.count;
      inp.title = "调整本束根数（下一束相应变化），即时重算";
      inp.addEventListener("change", () => {
        warpBoundsCustom = true;
        draft.warpPlan.boutBounds = setBoutSize(m.bounds, k, +inp.value || bt.count, m.totals.totalEnds);
        markDirty();
        recalcWarp();
      });
      tdN.appendChild(inp);
    } else {
      tdN.textContent = bt.count;
      tdN.classList.add("dim");
      tdN.title = "末束根数由总根数决定";
    }
    tr.title = "点击在逐根上机视图中查看本束";
    tr.addEventListener("click", (e) => {
      if (e.target.tagName !== "INPUT") openWarpView(bt.start);
    });
    tb.appendChild(tr);
  });
  tbl.appendChild(tb);
  box.appendChild(tbl);
  const sum = document.createElement("div");
  sum.className = "dim bout-sum";
  sum.textContent = `共 ${m.bouts.length} 束 · 总经 ${m.totals.totalEnds} 根 · ` +
    `合计 ${m.totals.totalM.toFixed(1)} m · ${m.totals.weightG.toFixed(1)} g`;
  box.appendChild(sum);
}

function renderWarpIssues() {
  const m = warpModel;
  const ul = $("#warpIssueList");
  const sum = $("#warpIssueSummary");
  ul.innerHTML = "";
  if (!m.issues.length) {
    sum.className = "issue-summary ok";
    sum.textContent = "✓ 密度、筘齿、束界与边纱检查通过。";
    return;
  }
  const errs = m.issues.filter((i) => i.level === "error").length;
  sum.className = "issue-summary warn";
  sum.textContent = `发现 ${errs} 个错误、${m.issues.length - errs} 个提醒，共 ${m.issues.length} 项。点击条目在上机视图中定位。`;
  m.issues.forEach((iss) => {
    const li = document.createElement("li");
    li.className = iss.level === "error" ? "error" : iss.level === "info" ? "info" : "warn";
    const ico = iss.level === "error" ? "⛔" : iss.level === "info" ? "ℹ️" : "⚠️";
    li.innerHTML = `<span class="ico">${ico}</span><span>${iss.msg}</span>`;
    if (iss.end != null) {
      li.title = "点击在上机视图中定位";
      li.addEventListener("click", () => openWarpView(iss.end));
    }
    ul.appendChild(li);
  });
}

// ---- 逐根上机视图 ----
function openWarpView(at = null) {
  const wp = ensureWarpPlan();
  if (!warpModel) recalcWarp();
  const before = wp.progress;
  const prog = ensureProgress(wp, warpModel.totals.totalEnds);
  if (wp.progress !== before) markDirty();
  $("#warpModal").classList.remove("hidden");
  if (!warpView) {
    warpView = new WarpView({
      canvas: $("#cvWarpPath"),
      scroller: $("#warpScroll"),
      spacer: $("#warpSpacer"),
      onToggle: toggleWarpStage,
      onCursor: (i) => { wp.progress.cursor = i; markDirty(); updateWarpStatus(); },
      onLocate: (i) => locateEndInDraft(i),
    });
    warpView.cw = +$("#warpZoom").value || 10;
  }
  warpView.stage = warpStageIdx;
  warpView.setModel(warpModel, draft.palette, prog);
  // 续接上次进度：优先跳到指定位置，否则用上次光标；若该根本阶段已完成则找下一未完成
  let cur = at != null ? at : prog.cursor;
  const arr = prog[STAGES[warpStageIdx].key];
  if (at == null && arr[cur]) {
    const nxt = arr.findIndex((v) => !v);
    if (nxt >= 0) cur = nxt;
  }
  warpView.setCursor(cur);
  updateWarpStatus();
  requestAnimationFrame(() => { warpView.resize(); warpView.ensureVisible(); warpView.draw(); });
  setStatus("逐根上机视图：←→ 移动，1/2/3 勾选，空格完成并前进，Backspace 回退");
}

function closeWarpView() {
  $("#warpModal").classList.add("hidden");
}

function toggleWarpStage(end, key) {
  const wp = ensureWarpPlan();
  const prog = ensureProgress(wp, warpModel.totals.totalEnds);
  warpHist.push({ end, key, prev: prog[key][end] });
  if (warpHist.length > 500) warpHist.shift();
  prog[key][end] = !prog[key][end];
  markDirty();
  if (warpView) warpView.draw();
  updateWarpStatus();
}

function warpMarkDone() {
  if (!warpView || !warpModel) return;
  const wp = ensureWarpPlan();
  const prog = ensureProgress(wp, warpModel.totals.totalEnds);
  const key = STAGES[warpStageIdx].key;
  const cur = warpView.cursor;
  if (!prog[key][cur]) toggleWarpStage(cur, key);
  const arr = prog[key];
  let nxt = -1;
  for (let i = cur + 1; i < arr.length; i++) if (!arr[i]) { nxt = i; break; }
  if (nxt < 0) nxt = arr.findIndex((v) => !v);
  if (nxt >= 0) warpView.setCursor(nxt);
  else setStatus(`「${STAGES[warpStageIdx].label}」已全部完成`);
}

function warpUndo() {
  const h = warpHist.pop();
  if (!h) { setStatus("没有可回退的勾选"); return; }
  const prog = ensureProgress(ensureWarpPlan(), warpModel.totals.totalEnds);
  prog[h.key][h.end] = h.prev;
  markDirty();
  if (warpView) { warpView.setCursor(h.end, false); warpView.draw(); }
  updateWarpStatus();
  setStatus(`已回退：第 ${h.end + 1} 根「${STAGES.find((s) => s.key === h.key).label}」`);
}

function warpNextIncomplete() {
  if (!warpView || !warpModel) return;
  const prog = ensureProgress(ensureWarpPlan(), warpModel.totals.totalEnds);
  const arr = prog[STAGES[warpStageIdx].key];
  let nxt = -1;
  for (let i = warpView.cursor + 1; i < arr.length; i++) if (!arr[i]) { nxt = i; break; }
  if (nxt < 0) nxt = arr.findIndex((v) => !v);
  if (nxt >= 0) warpView.setCursor(nxt);
  else setStatus(`「${STAGES[warpStageIdx].label}」已全部完成`);
}

function warpResetStage() {
  const wp = ensureWarpPlan();
  if (!wp.progress) return;
  const st = STAGES[warpStageIdx];
  if (!confirm(`清空「${st.label}」阶段全部勾选？`)) return;
  wp.progress[st.key].fill(false);
  markDirty();
  if (warpView) warpView.draw();
  updateWarpStatus();
}

function setWarpStage(i) {
  warpStageIdx = i;
  if (warpView) { warpView.stage = i; warpView.draw(); }
  updateWarpStatus();
}

function updateWarpStatus() {
  if (!warpModel || !draft.warpPlan || !draft.warpPlan.progress) return;
  const m = warpModel, prog = draft.warpPlan.progress;
  const total = m.totals.totalEnds;
  $("#warpProgText").textContent = STAGES.map((s) => {
    const n = prog[s.key].filter(Boolean).length;
    return `${s.label} ${n}/${total}`;
  }).join(" · ");
  const e = m.ends[warpView ? warpView.cursor : prog.cursor];
  if (e) {
    $("#warpCursorInfo").textContent = `第 ${e.i + 1} 根` +
      (e.zone === "B" ? `（布身第 ${e.bodyIdx + 1} 根）` : e.zone === "L" ? "（左边纱）" : "（右边纱）") +
      ` · 色 ${e.color + 1} · ${e.shaft >= 0 ? "综 " + (e.shaft + 1) : "未穿综"} · 齿 ${m.dentOfEnd[e.i] + 1}`;
  }
  $$("#warpStageBtns button").forEach((b, i) => b.classList.toggle("active", i === warpStageIdx));
}

/** 从上机视图定位到原草图对应经纱（穿综格 + 组织图列 + 经纱色条） */
function locateEndInDraft(endIdx) {
  const m = warpModel;
  if (!m) return;
  const e = m.ends[endIdx];
  if (!e) return;
  closeWarpView();
  const col = e.zone === "B" ? e.bodyIdx % draft.ends : (e.zone === "L" ? 0 : draft.ends - 1);
  const row = e.shaft >= 0 ? e.shaft : 0;
  gThread.locate(row, col);
  gDraw.locate(0, col);
  cWarp.locate(col);
  setStatus(`已定位第 ${endIdx + 1} 根经纱 → 草图第 ${col + 1} 列` +
    (e.zone !== "B" ? "（边纱，对应布身边缘）" : ""));
}

/** 上机视图键盘控制；返回 true 表示该键已处理/应吞掉 */
function handleWarpKey(e) {
  if (!warpView) return false;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return false;
  const k = e.key;
  if (k === "Escape") { closeWarpView(); return true; }
  if (k === "ArrowLeft") { warpView.setCursor(warpView.cursor - 1); return true; }
  if (k === "ArrowRight") { warpView.setCursor(warpView.cursor + 1); return true; }
  if (k === "ArrowUp") { setWarpStage((warpStageIdx + 2) % 3); return true; }
  if (k === "ArrowDown") { setWarpStage((warpStageIdx + 1) % 3); return true; }
  if (k === "1" || k === "2" || k === "3") { toggleWarpStage(warpView.cursor, STAGES[+k - 1].key); return true; }
  if (k === " " || k === "Enter") { warpMarkDone(); return true; }
  if (k === "Backspace") { warpUndo(); return true; }
  // 模态打开时吞掉普通字符，避免误触主界面画笔快捷键
  if (!e.ctrlKey && !e.metaKey && !e.altKey && k.length === 1) return true;
  return false;
}

// --------------------------------------------------------------------------- //
// 尺寸 / 参数变更
// --------------------------------------------------------------------------- //
function changeDimensions() {
  applyDimensions(draft, {
    ends: +$("#inpEnds").value,
    shafts: +$("#inpShafts").value,
    treadles: +$("#inpTreadles").value,
    picks: +$("#inpPicks").value,
  });
  rebuildFromDraft();
}

// --------------------------------------------------------------------------- //
// 剪贴板、镜像、循环填充（可跨网格）
// --------------------------------------------------------------------------- //
function activeEditGrid() {
  return window._gridFocus || gThread;
}

function opCopy() {
  const g = activeEditGrid();
  if (!g.selBounds()) { g.selectAll(); }
  const cb = g.copySelection();
  g.setClipboard(cb);
  setStatus(`已复制 ${cb.rows}×${cb.cols} 的图案，可在任意网格粘贴`);
}
function opPaste() {
  const g = activeEditGrid();
  const cb = g.getClipboard();
  if (!cb) { setStatus("剪贴板为空，请先框选并复制"); return; }
  snapshot("粘贴");
  g.pasteClipboard(cb, g.hover || null);
  recompute();
}
function opMirror(h) {
  snapshot(h ? "水平镜像" : "垂直镜像");
  activeEditGrid().mirror(h);
  recompute();
}
function opCycle() {
  const g = activeEditGrid();
  if (!g.selBounds()) { setStatus("请先框选作为循环母版的区域"); return; }
  let dir = "both";
  if (g.kind === "threading") dir = "h";
  else if (g.kind === "treadling") dir = "v";
  snapshot("循环填充");
  g.cycleFill(dir);
  recompute();
}
function opClearSel() {
  const g = activeEditGrid();
  if (!g.selBounds()) return;
  snapshot("清除选区");
  g.clearRegion();
  g.clearSelection();
  recompute();
}

// --------------------------------------------------------------------------- //
// 项目保存 / 版本 / 比较
// --------------------------------------------------------------------------- //
let dirty = false;
function markDirty() {
  dirty = true;
  $("#saveState").textContent = currentProjectId ? `未保存 (#${currentProjectId})` : "未保存（新项目）";
  $("#saveState").classList.add("dirty");
  localStorage.setItem("weaving_autosave", JSON.stringify({
    name: draft.name, data: draft, at: Date.now(), projectId: currentProjectId,
  }));
}
function markSaved(id) {
  dirty = false;
  currentProjectId = id;
  $("#saveState").textContent = `已保存 #${id} · ${new Date().toLocaleTimeString()}`;
  $("#saveState").classList.remove("dirty");
}

async function saveProject() {
  draft.name = $("#projectName").value.trim() || "未命名织物";
  try {
    if (currentProjectId) {
      await api.updateProject(currentProjectId, draft.name, draft);
      markSaved(currentProjectId);
    } else {
      const p = await api.createProject(draft.name, draft);
      markSaved(p.id);
    }
    setStatus("项目已保存到本机数据库");
    refreshProjectLists();
  } catch (e) { setStatus("保存失败：" + e.message); }
}

async function refreshProjectLists() {
  const projects = await api.listProjects();
  const render = (ul) => {
    ul.innerHTML = "";
    if (!projects.length) { ul.innerHTML = `<li class="dim">暂无保存的项目</li>`; return; }
    projects.forEach((p) => {
      const li = document.createElement("li");
      li.innerHTML = `<div><div class="v-label">${escapeHtml(p.name)}</div>
        <div class="meta">#${p.id} · 更新 ${formatTime(p.updated_at)}</div></div>`;
      const btns = document.createElement("div");
      btns.className = "v-actions";
      const bOpen = document.createElement("button");
      bOpen.className = "mini"; bOpen.textContent = "打开";
      bOpen.onclick = () => loadProject(p.id);
      const bDel = document.createElement("button");
      bDel.className = "mini"; bDel.textContent = "删除";
      bDel.onclick = async () => {
        if (!confirm(`删除项目「${p.name}」及其所有版本？`)) return;
        await api.deleteProject(p.id);
        if (currentProjectId === p.id) newDraft();
        refreshProjectLists();
      };
      btns.append(bOpen, bDel);
      li.appendChild(btns);
      ul.appendChild(li);
    });
  };
  render($("#projectList"));
  render($("#openProjectList"));
  if (currentProjectId) refreshVersions();
}

async function loadProject(id) {
  const p = await api.getProject(id);
  draft = createDraft(p.data);
  currentProjectId = id;
  $("#projectName").value = p.name;
  undoStack.length = 0; redoStack.length = 0;
  rebuildFromDraft();
  markSaved(id);
  $("#openModal").classList.add("hidden");
  setStatus(`已打开项目「${p.name}」`);
}

async function refreshVersions() {
  if (!currentProjectId) {
    $("#versionList").innerHTML = `<li class="dim">保存项目后可存版本</li>`;
    $("#cmpA").innerHTML = ""; $("#cmpB").innerHTML = "";
    return;
  }
  const versions = await api.listVersions(currentProjectId);
  const ul = $("#versionList");
  ul.innerHTML = "";
  if (!versions.length) ul.innerHTML = `<li class="dim">还没有版本快照</li>`;
  versions.forEach((v) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="v-label">${escapeHtml(v.label)}</div>
      <div class="meta">#${v.id} · ${formatTime(v.created_at)}</div>`;
    const btns = document.createElement("div");
    btns.className = "v-actions";
    const bLoad = document.createElement("button");
    bLoad.className = "mini"; bLoad.textContent = "载入";
    bLoad.onclick = async () => {
      const full = await api.getVersion(v.id);
      snapshot("载入版本前");
      draft = createDraft(full.data);
      rebuildFromDraft();
      setStatus(`已载入版本「${v.label}」（当前草稿未自动保存）`);
    };
    const bDel = document.createElement("button");
    bDel.className = "mini"; bDel.textContent = "删除";
    bDel.onclick = async () => { await api.deleteVersion(v.id); refreshVersions(); };
    btns.append(bLoad, bDel);
    li.appendChild(btns);
    ul.appendChild(li);
  });
  // 比较下拉
  const fill = (sel, defIdx) => {
    sel.innerHTML = versions.map((v, i) =>
      `<option value="${v.id}"${i === defIdx ? " selected" : ""}>${escapeHtml(v.label)} (${formatTime(v.created_at)})</option>`).join("");
  };
  fill($("#cmpA"), versions.length > 1 ? 1 : 0);
  fill($("#cmpB"), 0);
}

async function saveVersion() {
  draft.name = $("#projectName").value.trim() || "未命名织物";
  try {
    // 先把屏幕上当前（可能未保存）的草稿提交，再据此创建版本快照
    if (currentProjectId) {
      await api.updateProject(currentProjectId, draft.name, draft);
    } else {
      const p = await api.createProject(draft.name, draft);
      currentProjectId = p.id;
    }
    markSaved(currentProjectId);
    await api.saveVersion(currentProjectId, $("#versionLabel").value);
    $("#versionLabel").value = "";
    setStatus("已提交当前草稿并保存版本快照");
    refreshVersions();
    refreshProjectLists();
  } catch (e) {
    setStatus("保存版本失败：" + e.message);
  }
}

async function compareVersions() {
  const idA = $("#cmpA").value, idB = $("#cmpB").value;
  if (!idA || !idB || idA === idB) { setStatus("请选择两个不同的版本"); return; }
  const [va, vb] = await Promise.all([api.getVersion(idA), api.getVersion(idB)]);
  const da = createDraft(va.data), db = createDraft(vb.data);
  const { sets, counts, dim } = diffDrafts(db, da);
  renderDraftComposite($("#cvCmpA"), da, sets);
  renderDraftComposite($("#cvCmpB"), db, null);
  $("#cmpTitleA").textContent = `A：${va.label}（${formatTime(va.created_at)}）`;
  $("#cmpTitleB").textContent = `B：${vb.label}（${formatTime(vb.created_at)}）`;
  $("#cmpSummary").innerHTML =
    `差异格数 —— 穿综 <b>${counts.threading}</b>，栓结 <b>${counts.tieup}</b>，` +
    `踏序 <b>${counts.treadling}</b>，组织图 <b>${counts.face}</b>，色序 <b>${counts.colors}</b>。` +
    (dim.dimsChanged ? "<br>两版本织机参数（经纱/综框/踏板/纬数）不同。" : "") +
    ` 黄底为 A 相对 B 的差异位置。`;
  $("#cmpModal").classList.remove("hidden");
}

// --------------------------------------------------------------------------- //
// WIF
// --------------------------------------------------------------------------- //
function doExportWif() {
  const text = exportWIF(draft);
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (draft.name || "weaving").replace(/[\\/:*?"<>|]+/g, "_") + ".wif";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  setStatus("WIF 已导出（栓结按 jack 升综约定书写）");
}

function doImportWif(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = importWIF(reader.result);
      snapshot("导入 WIF 前");
      draft = imported;
      currentProjectId = null;
      $("#projectName").value = draft.name;
      rebuildFromDraft();
      setStatus(`WIF 导入成功：${draft.ends} 经 × ${draft.picks} 纬，${draft.shafts} 综 ${draft.treadles} 踏`);
    } catch (e) {
      alert("WIF 导入失败：" + e.message);
    }
  };
  reader.readAsText(file, "UTF-8");
}

// --------------------------------------------------------------------------- //
// 新建
// --------------------------------------------------------------------------- //
function newDraft() {
  if (dirty && !confirm("当前草稿有未保存修改，确定新建并丢弃？")) return;
  draft = createDraft({ name: "未命名织物" });
  currentProjectId = null;
  undoStack.length = 0; redoStack.length = 0;
  $("#projectName").value = draft.name;
  rebuildFromDraft();
  markDirty();
  setStatus("已新建空白草稿");
}

function loadSample() {
  snapshot("载入示例前");
  draft = sampleDraft();
  currentProjectId = null;
  $("#projectName").value = draft.name;
  rebuildFromDraft();
  markDirty();
  setStatus("已载入 2/2 斜纹示例");
}

// --------------------------------------------------------------------------- //
// 小工具
// --------------------------------------------------------------------------- //
function setStatus(t) { $("#statusMain").textContent = t; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --------------------------------------------------------------------------- //
// 绑定
// --------------------------------------------------------------------------- //
function bind() {
  // 工具
  $$("#toolGrid .tool").forEach((b) =>
    b.addEventListener("click", () => setTool(b.dataset.tool)));
  $("#opCopy").onclick = opCopy;
  $("#opPaste").onclick = opPaste;
  $("#opMirrorH").onclick = () => opMirror(true);
  $("#opMirrorV").onclick = () => opMirror(false);
  $("#opCycleFill").onclick = opCycle;
  $("#opClearSel").onclick = opClearSel;
  $("#zoom").oninput = (e) => {
    const v = +e.target.value;
    [gThread, gTie, gTread, gDraw, gLift].forEach((g) => g.setCellSize(v));
  };

  // ---- 参数变更：在修改前建立撤销快照，同一输入框的连续键入合并为一次 ----
  // 对 number/select 控件：focus 时记下当前草稿，blur 后若期间发生改动则入栈一次
  const focusSnap = new WeakMap();
  const beginParamEdit = (el) => focusSnap.set(el, deepClone(draft));
  const commitParamEdit = (el, label) => {
    const pre = focusSnap.get(el);
    focusSnap.delete(el);
    if (pre && JSON.stringify(pre) !== JSON.stringify(draft)) {
      undoStack.push({ label, d: pre });
      if (undoStack.length > HISTORY_MAX) undoStack.shift();
      redoStack.length = 0;
      updateHistoryButtons();
      markDirty();
    }
  };
  const trackParam = (el, label, after) => {
    el.addEventListener("focus", () => beginParamEdit(el));
    el.addEventListener("change", () => { after && after(); commitParamEdit(el, label); });
  };

  // 织机尺寸：立即重建网格，连续改动只留一条撤销记录
  ["#inpEnds", "#inpShafts", "#inpTreadles", "#inpPicks"].forEach((sel) => {
    trackParam($(sel), "调整织机尺寸", () => changeDimensions());
  });
  trackParam($("#selShed"), "切换升降综", () => { draft.shed = $("#selShed").value; recompute(); });
  trackParam($("#inpWarpFloat"), "浮长阈值", () => {
    draft.thresholds.warp = +$("#inpWarpFloat").value || 4; recompute();
  });
  trackParam($("#inpWeftFloat"), "浮长阈值", () => {
    draft.thresholds.weft = +$("#inpWeftFloat").value || 4; recompute();
  });
  $("#projectName").oninput = (e) => { draft.name = e.target.value; markDirty(); };
  $("#drawdownMode").onchange = () => gDraw.draw();

  // 色序
  $("#paletteAdd").onclick = () => {
    snapshot("新增调色板颜色");
    draft.palette.push($("#paletteColor").value);
    activeColor = draft.palette.length - 1;
    renderPalette();
    cWarp.setValues(draft.warpColors, draft.palette);
    cWeft.setValues(draft.weftColors, draft.palette);
    recompute();
  };
  $("#paletteDel").onclick = () => {
    if (draft.palette.length <= 2) return;
    snapshot("删除调色板颜色");
    draft.palette.splice(activeColor, 1);
    draft.warpColors = draft.warpColors.map((c) => Math.min(c, draft.palette.length - 1));
    draft.weftColors = draft.weftColors.map((c) => Math.min(c, draft.palette.length - 1));
    activeColor = Math.min(activeColor, draft.palette.length - 1);
    renderPalette();
    cWarp.setValues(draft.warpColors, draft.palette);
    cWeft.setValues(draft.weftColors, draft.palette);
    recompute();
  };
  $$(".seqtools button").forEach((btn) => {
    btn.onclick = () => {
      const seq = btn.dataset.seq;
      const strip = seq === "warp" ? cWarp : cWeft;
      strip.activeColor = activeColor;
      const values = seq === "warp" ? draft.warpColors : draft.weftColors;
      const act = btn.dataset.act;
      if (act === "paint") {
        strip.setTool("paint");
        setStatus("画笔已选中：在色条上拖动即可用当前调色板颜色涂色");
        return;
      }
      snapshot("色序编辑：" + btn.textContent);
      if (act === "cycle") {
        // 从开头用整个调色板循环铺色
        for (let i = 0; i < values.length; i++)
          values[i] = (activeColor + i) % draft.palette.length;
        strip.setValues(values, draft.palette);
        recompute();
      } else if (act === "repeat") {
        // 反转整个序列（镜像）
        values.reverse();
        strip.setValues(values, draft.palette);
        recompute();
      } else if (act === "clear") {
        values.fill(activeColor);
        strip.setValues(values, draft.palette);
        recompute();
      }
      setStatus("色序工具：" + btn.textContent + "（在色条上拖动可精细涂色）");
    };
  });

  // 预览/用纱参数：输入时实时刷新，撤销快照在 focus 前建立、change 时合并提交
  const numSetting = (sel, key, cb, label = "调整预览/用纱参数") => {
    const el = $(sel);
    el.addEventListener("focus", () => beginParamEdit(el));
    el.addEventListener("input", (e) => {
      draft.settings[key] = +e.target.value;
      cb && cb();
      markDirty();
    });
    el.addEventListener("change", () => commitParamEdit(el, label));
  };
  numSetting("#inpEpc", "epc", renderPreviewSafe, "调整经密");
  numSetting("#inpPpc", "ppc", renderPreviewSafe, "调整纬密");
  numSetting("#inpRepX", "repX", renderPreviewSafe, "调整横向重复");
  numSetting("#inpRepY", "repY", renderPreviewSafe, "调整纵向重复");
  numSetting("#inpWidth", "width", renderYarn, "调整幅宽");
  numSetting("#inpLength", "length", renderYarn, "调整长度");
  numSetting("#inpWarpTakeup", "warpTakeup", renderYarn, "调整经缩率");
  numSetting("#inpWeftTakeup", "weftTakeup", renderYarn, "调整纬缩率");
  numSetting("#inpWasteWarp", "wasteWarp", renderYarn, "调整经回丝");
  numSetting("#inpWasteWeft", "wasteWeft", renderYarn, "调整纬回丝率");
  numSetting("#inpWarpTex", "warpTex", renderYarn, "调整经纱线密度");
  numSetting("#inpWeftTex", "weftTex", renderYarn, "调整纬纱线密度");

  // 整经与穿筘：输入即时重算（计划存于 draft.warpPlan，不占草图撤销栈）
  const wpInput = (sel, apply) => {
    const el = $(sel);
    const evt = el.tagName === "SELECT" || el.type === "text" ? "change" : "input";
    el.addEventListener(evt, () => { apply(ensureWarpPlan(), el); markDirty(); recalcWarp(); });
  };
  wpInput("#wpReed", (wp, el) => { wp.reedDensity = +el.value; });
  wpInput("#wpReedUnit", (wp, el) => { wp.reedUnit = el.value; });
  wpInput("#wpPattern", (wp, el) => {
    wp.dentPattern = parsePattern(el.value, wp.dentPattern);
    el.value = wp.dentPattern.join(",");
  });
  wpInput("#wpSelvEnds", (wp, el) => { wp.selvEnds = Math.max(0, +el.value | 0); });
  wpInput("#wpSelvPerDent", (wp, el) => { wp.selvPerDent = Math.max(1, +el.value | 0); });
  wpInput("#wpSelvShaft", (wp, el) => { wp.selvShaft = el.value; });
  wpInput("#wpMaxBout", (wp, el) => {
    wp.maxBout = Math.max(4, +el.value | 0);
    if (!warpBoundsCustom) wp.boutBounds = null;   // 未手动调过束界时随上限自动重排
  });
  $("#wpSuggest").onclick = () => {
    const wp = ensureWarpPlan();
    wp.dentPattern = suggestDentPattern(+draft.settings.epc || 1, dentsPerCm(wp));
    $("#wpPattern").value = wp.dentPattern.join(",");
    markDirty();
    recalcWarp();
    setStatus(`已按经密建议穿筘模式：${wp.dentPattern.join("、")} 根/齿`);
  };
  $("#wpAutoBouts").onclick = () => {
    const wp = ensureWarpPlan();
    wp.boutBounds = null;
    warpBoundsCustom = false;
    markDirty();
    recalcWarp();
    setStatus("已按色序自动分束（避开颜色变化处）");
  };
  $("#wpOpenView").onclick = () => openWarpView();
  $("#wpPrint").onclick = () => { ensureWarpPlan(); printWarpSheet(draft.name, draft); };

  // 逐根上机视图
  $("#warpClose").onclick = closeWarpView;
  $("#warpDone").onclick = warpMarkDone;
  $("#warpUndo").onclick = warpUndo;
  $("#warpNext").onclick = warpNextIncomplete;
  $("#warpReset").onclick = warpResetStage;
  $("#warpLocate").onclick = () => warpView && locateEndInDraft(warpView.cursor);
  $("#warpZoom").oninput = (e) => { if (warpView) warpView.setZoom(+e.target.value); };
  $$("#warpStageBtns button").forEach((b) =>
    b.addEventListener("click", () => setWarpStage(+b.dataset.stage)));
  window.addEventListener("resize", () => {
    if (warpView && !$("#warpModal").classList.contains("hidden")) warpView.resize();
  });

  // 标签页（切换时补渲染）
  $$(".tabs .tab").forEach((t) =>
    t.addEventListener("click", () => {
      $$(".tabs .tab").forEach((x) => x.classList.remove("active"));
      $$(".tabpage").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      $(`.tabpage[data-tab="${t.dataset.tab}"]`).classList.add("active");
      if (t.dataset.tab === "preview") renderPreviewSafe();
      if (t.dataset.tab === "yarn") renderYarn();
      if (t.dataset.tab === "warp") { ensureWarpPlan(); syncWarpInputs(); recalcWarp(); }
      if (t.dataset.tab === "projects") { refreshVersions(); refreshProjectLists(); }
    }));

  // 顶部按钮
  $("#btnNew").onclick = newDraft;
  $("#btnOpen").onclick = () => { refreshProjectLists(); $("#openModal").classList.remove("hidden"); };
  $("#openClose").onclick = () => $("#openModal").classList.add("hidden");
  $("#btnSave").onclick = saveProject;
  $("#btnUndo").onclick = undo;
  $("#btnRedo").onclick = redo;
  $("#btnExportWif").onclick = doExportWif;
  $("#btnImportWif").onclick = () => $("#wifFile").click();
  $("#wifFile").onchange = (e) => { if (e.target.files[0]) doImportWif(e.target.files[0]); e.target.value = ""; };
  $("#btnPrint").onclick = () => printDraft(draft.name, draft);
  $("#btnSample").onclick = loadSample;

  // 版本
  $("#btnSaveVersion").onclick = saveVersion;
  $("#btnCompare").onclick = compareVersions;
  $("#cmpClose").onclick = () => $("#cmpModal").classList.add("hidden");

  // 快捷键
  window.addEventListener("keydown", (e) => {
    // 上机视图打开时，键盘交给视图控制
    if (!$("#warpModal").classList.contains("hidden")) {
      if (handleWarpKey(e)) e.preventDefault();
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      if (e.key === "b") setTool("paint");
      else if (e.key === "e") setTool("erase");
      else if (e.key === "s") setTool("select");
      return;
    }
    const tag = (e.target.tagName || "").toLowerCase();
    const key = e.key.toLowerCase();
    const inField = tag === "input" || tag === "select" || tag === "textarea";
    // 文本类输入框（项目名、版本说明）内不拦截 Ctrl+Z/Y/S，保留原生编辑
    const isTextField = inField && (tag === "textarea" ||
      (tag === "input" && !["number", "color", "checkbox", "radio"].includes(e.target.type)));
    if (isTextField && key !== "s") return;
    if (key === "z" || key === "y") {
      e.preventDefault();
      // 让正在编辑的数字/选择控件先提交 change（完成撤销快照合并）
      if (inField && document.activeElement && document.activeElement.blur) {
        document.activeElement.dispatchEvent(new Event("change", { bubbles: true }));
        document.activeElement.blur();
      }
      key === "z" ? (e.shiftKey ? redo() : undo()) : redo();
    } else if (key === "s") {
      e.preventDefault();
      if (inField && document.activeElement && document.activeElement.blur) {
        document.activeElement.dispatchEvent(new Event("change", { bubbles: true }));
        document.activeElement.blur();
      }
      saveProject();
    }
  });
}

// --------------------------------------------------------------------------- //
// 启动
// --------------------------------------------------------------------------- //
function init() {
  buildGrids();
  bind();
  updateHistoryButtons();
  refreshProjectLists();
  setStatus("就绪：所有计算均在本机浏览器完成，数据保存在本地 SQLite。");

  // 启动时尝试恢复上次自动保存的草稿（七天内）
  let restored = false;
  try {
    const auto = JSON.parse(localStorage.getItem("weaving_autosave") || "null");
    if (auto && Date.now() - auto.at < 1000 * 60 * 60 * 24 * 7 && auto.data) {
      draft = createDraft(auto.data);
      currentProjectId = auto.projectId || null;
      restored = true;
    }
  } catch (e) { /* 忽略损坏的本地缓存 */ }
  rebuildFromDraft();
  if (restored) {
    $("#saveState").textContent = currentProjectId
      ? `已恢复上次草稿（项目 #${currentProjectId}）` : "已恢复上次草稿（新项目）";
    $("#saveState").classList.add("dirty");
    dirty = true;
  } else {
    markSaved(0);
    $("#saveState").textContent = "新草稿";
  }
}

// 调试/自动化测试钩子（数据仍只在本机）
window.__app = {
  get draft() { return draft; },
  set draft(v) { draft = v; },
  get currentProjectId() { return currentProjectId; },
  set currentProjectId(v) { currentProjectId = v; },
  get grids() { return { threading: gThread, tieup: gTie, treadling: gTread, drawdown: gDraw, lift: gLift }; },
  get strips() { return { warp: cWarp, weft: cWeft }; },
  snapshot, undo, redo, recompute, rebuildFromDraft,
  setActiveColor: (i) => { activeColor = i; },
};
init();
