// treadleview.js —— 提综→踏板转换台：约束编辑、候选搜索、Canvas 预览与应用
import { $, deepClone } from "./utils.js";
import { analyze } from "./weave.js";
import { solveTreadle } from "./treadle.js";
import { DraftGrid } from "./grids.js";
import { diffDrafts } from "./compare.js";
import { renderDraftComposite } from "./compare.js";

const PAD_L = 26, PAD_T = 34;   // 左侧综号 / 顶部锁定行

/**
 * 转换台。宿主需提供：
 *   getDraft() / getAnalysis()      当前草稿与推演结果
 *   onApply(candidate, params)      应用候选（宿主负责存版本、替换草稿）
 *   onLocate(pick)                  在主界面定位某纬
 */
export class TreadleStudio {
  constructor({ getDraft, getAnalysis, onApply, onLocate }) {
    this.getDraft = getDraft;
    this.getAnalysis = getAnalysis;
    this.onApply = onApply;
    this.onLocate = onLocate;

    this.keep = new Set();      // "s,t"
    this.forbid = new Set();
    this.locked = new Set();    // 整列固定的踏板
    this.result = null;
    this.selected = -1;
    this.cell = 18;

    this.cv = $("#cvTreadleConstraints");
    this.ctx = this.cv.getContext("2d");
    this.hover = null;
    this._bind();
  }

  // ------------------------------------------------------------------ //
  open() {
    const d = this.getDraft();
    this.S = d.shafts;
    this.T = d.treadles;
    this.K = Math.max(1, Math.min(this.T, this.S));
    // 已有踏序中最多同时踩的踏板数，作为上限默认值（至少 1）
    let curMax = 1;
    for (const row of d.treadling) curMax = Math.max(curMax, row.reduce((a, b) => a + b, 0));
    this.K = Math.max(1, Math.min(this.T, curMax));

    this.keep.clear();
    this.forbid.clear();
    this.locked.clear();
    this.result = null;
    this.selected = -1;

    $("#tdTreadles").value = this.T;
    $("#tdMaxPress").value = this.K;
    $("#tdTreadles").max = 32;
    $("#tdMaxPress").max = this.T;

    const a = this.getAnalysis();
    const comboKeys = new Set(a.lift.map((row) => row.join("")));
    const empty = a.emptyPicks.length;
    $("#tdSource").innerHTML =
      `读取当前草稿提综状态：<b>${d.picks}</b> 纬 × <b>${d.shafts}</b> 综，` +
      `共 <b>${comboKeys.size}</b> 种提综组合` +
      (empty ? `（其中 ${empty} 纬为空梭口，转换时保持不踩任何踏板）` : "") +
      `；提综逻辑：${d.shed === "jack" ? "升综 jack" : "降综 sinking"}（升降综分别沿用现有推演，不影响栓结语义）。`;

    $("#tdResult").innerHTML = "";
    $("#tdPreview").innerHTML = "";
    $("#tdApply").disabled = true;
    this._renderMessage("info", "设置踏板数与每纬踩踏上限，可在栓结矩阵中标记保留（绿）/禁止（红），或点列首 🔓 锁定整列后重新求解。");
    this.resizeConstraintCanvas();
    this.drawConstraints();
    $("#treadleModal").classList.remove("hidden");
  }

  close() {
    $("#treadleModal").classList.add("hidden");
  }

  // ------------------------------------------------------------------ //
  // 栓结约束编辑画布（顶部一行为列锁定开关）
  // ------------------------------------------------------------------ //
  resizeConstraintCanvas() {
    const dpr = window.devicePixelRatio || 1;
    this.w = PAD_L + this.T * this.cell;
    this.h = PAD_T + this.S * this.cell;
    this.cv.style.width = this.w + "px";
    this.cv.style.height = this.h + "px";
    this.cv.width = Math.round(this.w * dpr);
    this.cv.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _cellAt(evt) {
    const rect = this.cv.getBoundingClientRect();
    const x = evt.clientX - rect.left - PAD_L;
    const y = evt.clientY - rect.top - PAD_T;
    const c = Math.floor(x / this.cell), r = Math.floor(y / this.cell);
    if (c < 0 || c >= this.T) return null;
    if (y < 0) return { header: true, c };
    if (r < 0 || r >= this.S) return null;
    return { header: false, r, c };
  }

  _bind() {
    const d = () => this.getDraft();
    this.cv.addEventListener("mousemove", (e) => {
      this.hover = this._cellAt(e);
      this.cv.style.cursor = this.hover ? "pointer" : "default";
      this.drawConstraints();
    });
    this.cv.addEventListener("mouseleave", () => { this.hover = null; this.drawConstraints(); });
    this.cv.addEventListener("click", (e) => {
      const p = this._cellAt(e);
      if (!p) return;
      if (p.header) {
        this.locked.has(p.c) ? this.locked.delete(p.c) : this.locked.add(p.c);
        this.drawConstraints();
        return;
      }
      if (this.locked.has(p.c)) return;    // 锁定列不可改
      const key = p.r + "," + p.c;
      if (this.keep.has(key)) { this.keep.delete(key); this.forbid.add(key); }
      else if (this.forbid.has(key)) { this.forbid.delete(key); }
      else { this.keep.add(key); }
      this.drawConstraints();
    });

    $("#tdClose").onclick = () => this.close();
    $("#tdRun").onclick = () => this.run();
    $("#tdImportKeep").onclick = () => {
      const draft = d();
      let n = 0;
      for (let s = 0; s < this.S; s++)
        for (let t = 0; t < this.T; t++) {
          if (this.locked.has(t)) continue;
          const key = s + "," + t;
          if (draft.tieup[s] && draft.tieup[s][t]) { this.keep.add(key); this.forbid.delete(key); n++; }
        }
      this._renderMessage("info", `已把现有栓结的 ${n} 个结标记为必须保留（锁定列除外）。`);
      this.drawConstraints();
    };
    $("#tdClearRules").onclick = () => {
      this.keep.clear(); this.forbid.clear();
      this.drawConstraints();
      this._renderMessage("info", "已清空全部保留/禁止标记（锁定状态保留）。");
    };
    $("#tdLockAll").onclick = () => {
      const all = this.locked.size === this.T;
      if (all) this.locked.clear();
      else for (let t = 0; t < this.T; t++) this.locked.add(t);
      this.drawConstraints();
    };
    $("#tdTreadles").addEventListener("change", (e) => {
      const v = Math.max(2, Math.min(32, +e.target.value || this.T));
      e.target.value = v;
      if (v === this.T) return;
      this.T = v;
      $("#tdMaxPress").max = v;
      if (this.K > v) { this.K = v; $("#tdMaxPress").value = v; }
      this.keep = new Set([...this.keep].filter((k) => +k.split(",")[1] < v));
      this.forbid = new Set([...this.forbid].filter((k) => +k.split(",")[1] < v));
      this.locked = new Set([...this.locked].filter((t) => t < v));
      this.resizeConstraintCanvas();
      this.drawConstraints();
    });
    $("#tdMaxPress").addEventListener("change", (e) => {
      this.K = Math.max(1, Math.min(this.T, +e.target.value || 1));
      e.target.value = this.K;
    });
    $("#tdApply").onclick = () => this.applySelected();
  }

  drawConstraints() {
    if (!this.S) return;
    const ctx = this.ctx, cs = this.cell, d = this.getDraft();
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, this.w, this.h);
    // 锁定列底色
    for (let t = 0; t < this.T; t++) {
      if (this.locked.has(t)) {
        ctx.fillStyle = "rgba(150,160,170,.18)";
        ctx.fillRect(PAD_L + t * cs, 0, cs, this.h);
      }
    }

    // 顶部锁定开关行
    for (let t = 0; t < this.T; t++) {
      const x = PAD_L + t * cs;
      ctx.fillStyle = this.locked.has(t) ? "#8a96a2" : "#eef1f4";
      ctx.fillRect(x + 1, 2, cs - 2, PAD_T - 6);
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = this.locked.has(t) ? "#fff" : "#566575";
      ctx.fillText(this.locked.has(t) ? "🔒" : "🔓", x + cs / 2, PAD_T / 2 - 2);
      ctx.font = "8px sans-serif";
      ctx.fillText(String(t + 1), x + cs / 2, PAD_T - 5);
    }

    // 单元格
    for (let s = 0; s < this.S; s++) {
      for (let t = 0; t < this.T; t++) {
        const x = PAD_L + t * cs, y = PAD_T + s * cs;
        const key = s + "," + t;
        const locked = this.locked.has(t);
        if (locked) {
          // 锁定列：显示现有栓结（深色＝已结）
          if (d.tieup[s] && d.tieup[s][t]) {
            ctx.fillStyle = "#3a4652";
            ctx.fillRect(x + 2, y + 2, cs - 4, cs - 4);
          }
        } else if (this.keep.has(key)) {
          ctx.fillStyle = "#3f9d57";
          ctx.fillRect(x + 2, y + 2, cs - 4, cs - 4);
        } else if (this.forbid.has(key)) {
          ctx.strokeStyle = "#d65a5a";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x + 4, y + 4); ctx.lineTo(x + cs - 4, y + cs - 4);
          ctx.moveTo(x + cs - 4, y + 4); ctx.lineTo(x + 4, y + cs - 4);
          ctx.stroke();
        }
        if (this.hover && !this.hover.header && this.hover.r === s && this.hover.c === t) {
          ctx.strokeStyle = "#3d7ab8";
          ctx.lineWidth = 1.6;
          ctx.strokeRect(x + .8, y + .8, cs - 1.6, cs - 1.6);
        }
      }
    }

    // 网格线
    ctx.strokeStyle = "#d7dde3";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let s = 0; s <= this.S; s++) {
      const y = PAD_T + s * cs + .5;
      ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + this.T * cs, y);
    }
    for (let t = 0; t <= this.T; t++) {
      const x = PAD_L + t * cs + .5;
      ctx.moveTo(x, PAD_T); ctx.lineTo(x, PAD_T + this.S * cs);
    }
    ctx.stroke();

    // 行号（综框）
    ctx.fillStyle = "#8a96a2";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let s = 0; s < this.S; s++)
      ctx.fillText(String(s + 1), PAD_L - 4, PAD_T + s * cs + cs / 2);
  }

  // ------------------------------------------------------------------ //
  // 搜索
  // ------------------------------------------------------------------ //
  run() {
    const d = this.getDraft();
    const a = this.getAnalysis();
    this.K = Math.max(1, Math.min(this.T, +$("#tdMaxPress").value || 1));
    const t0 = performance.now();
    const res = solveTreadle({
      shafts: d.shafts,
      lift: a.lift,
      treadles: this.T,
      maxPress: this.K,
      currentTie: d.tieup,
      locked: [...this.locked],
      keep: [...this.keep].map((k) => { const [s, t] = k.split(",").map(Number); return { s, t }; }),
      forbid: [...this.forbid].map((k) => { const [s, t] = k.split(",").map(Number); return { s, t }; }),
    });
    res.elapsedMs = Math.round(performance.now() - t0);
    this.result = res;
    this.selected = -1;
    $("#tdApply").disabled = true;
    $("#tdPreview").innerHTML = "";

    if (!res.ok) {
      let html = `<div class="td-conflict-head">⛔ 无解：以下纬的提综组合与当前约束冲突（共 ${res.conflicts.length} 项）</div>`;
      res.conflicts.forEach((c) => {
        const loc = c.picks && c.picks.length
          ? `<button class="mini td-locate" data-pick="${c.picks[0]}">定位第 ${c.picks[0] + 1} 纬</button>` : "";
        html += `<div class="td-conflict">${escapeHtml(c.msg)} ${loc}</div>`;
      });
      if (res.warnings.length) {
        html += `<div class="td-warn-head">提醒</div>` + res.warnings.map((w) =>
          `<div class="td-warn">${escapeHtml(w.msg)}</div>`).join("");
      }
      $("#tdResult").innerHTML = html;
      $("#tdResult").querySelectorAll(".td-locate").forEach((b) =>
        b.addEventListener("click", () => { this.close(); this.onLocate(+b.dataset.pick); }));
      return;
    }

    this._renderResult(res, d, a);
  }

  _renderMessage(kind, msg) {
    const cls = kind === "info" ? "td-info" : "td-warn";
    $("#tdResult").innerHTML = `<div class="${cls}">${escapeHtml(msg)}</div>`;
  }

  _renderResult(res, d, a) {
    const box = $("#tdResult");
    box.innerHTML = "";
    const head = document.createElement("div");
    head.className = "td-ok-head";
    head.innerHTML = `✓ 找到 <b>${res.candidates.length}</b> 个候选` +
      (res.truncated ? "（已达搜索上限，仅保留当前最优的一批）" : "") +
      ` · 用时 ${res.elapsedMs} ms。排序：踏板数 → 多踏板纬数 → 总踩踏次数 → 栓结改动量。点击卡片查看。`;
    box.appendChild(head);
    if (res.warnings.length) {
      const wb = document.createElement("div");
      wb.innerHTML = res.warnings.map((w) => `<div class="td-warn">${escapeHtml(w.msg)}</div>`).join("");
      box.appendChild(wb);
    }
    const strip = document.createElement("div");
    strip.className = "td-cards";
    res.candidates.forEach((cand, i) => {
      const card = document.createElement("div");
      card.className = "td-card";
      const cv = document.createElement("canvas");
      card.appendChild(cv);
      const cap = document.createElement("div");
      cap.className = "td-card-cap";
      cap.innerHTML = `#${i + 1}　用 <b>${cand.usedTreadles}</b> 踏 · 多踏 <b>${cand.multiPicks}</b> 纬` +
        `<br>总踩 <b>${cand.totalPresses}</b> 次 · 栓结改 <b>${cand.changeCells}</b> 结`;
      card.appendChild(cap);
      card.addEventListener("click", () => this.select(i));
      strip.appendChild(card);
      this._drawMini(cv, cand, d);
    });
    box.appendChild(strip);
    if (res.candidates.length) this.select(0);
  }

  /** 候选卡片小图：上为栓结，下为踏序（按比例压缩，超高裁切） */
  _drawMini(canvas, cand, d) {
    const cellT = 10;
    const trCell = Math.max(2, Math.min(7, Math.floor(120 / d.picks)));
    const w = Math.max(this.T * cellT, this.T * trCell) + 4;
    const tieH = this.S * cellT;
    const trH = Math.min(120, d.picks * trCell);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = (tieH + 3 + trH + 2) * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = (tieH + 3 + trH + 2) + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const h = tieH + 3 + trH + 2;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    // 栓结
    for (let s = 0; s < this.S; s++)
      for (let t = 0; t < this.T; t++)
        if (cand.tieup[s][t]) {
          ctx.fillStyle = "#2f6ea8";
          ctx.fillRect(2 + t * cellT + 1, s * cellT + 1, cellT - 2, cellT - 2);
        }
    gridLines(ctx, 2, 0, this.T, this.S, cellT);
    // 踏序
    const y0 = tieH + 3;
    for (let p = 0; p < d.picks; p++)
      for (let t = 0; t < this.T; t++)
        if (cand.treadling[p][t]) {
          ctx.fillStyle = "#4a5a6b";
          ctx.fillRect(2 + t * trCell, y0 + p * trCell, trCell, trCell);
        }
    gridLines(ctx, 2, y0, this.T, Math.min(d.picks, Math.floor(trH / trCell)), trCell);
  }

  // ------------------------------------------------------------------ //
  // 候选预览（栓结矩阵、踏序、提综校验、组织图差异）
  // ------------------------------------------------------------------ //
  candidateDraft(cand) {
    const d = this.getDraft();
    const nd = deepClone(d);
    nd.treadles = this.T;
    // 候选矩阵按本次踏板数生成；其余字段保持草稿（穿综、色序、shed 等不变）
    nd.tieup = deepClone(cand.tieup);
    nd.treadling = deepClone(cand.treadling);
    return nd;
  }

  select(i) {
    this.selected = i;
    const cand = this.result.candidates[i];
    document.querySelectorAll(".td-card").forEach((el, j) => el.classList.toggle("sel", j === i));
    const d = this.getDraft();
    const nd = this.candidateDraft(cand);
    const na = analyze(nd);

    // 逐纬提综精确复现校验
    let liftDiff = 0;
    const diffPicks = [];
    for (let p = 0; p < d.picks; p++) {
      for (let s = 0; s < d.shafts; s++) {
        if ((this.getAnalysis().lift[p][s] || 0) !== (na.lift[p][s] || 0)) {
          liftDiff++;
          if (!diffPicks.includes(p)) diffPicks.push(p);
        }
      }
    }
    const dd = diffDrafts(d, nd);

    const box = $("#tdPreview");
    box.innerHTML = "";
    const info = document.createElement("div");
    info.className = "td-preview-info";
    info.innerHTML =
      `<b>候选 #${i + 1}</b>：使用踏板 ${cand.usedList.map((t) => t + 1).join("、")}；` +
      `${cand.multiPicks} 纬需同时踩多个踏板；总踩踏 ${cand.totalPresses} 次；` +
      `相对当前栓结改动 ${cand.changeCells} 个结（栓结矩阵差异 ${dd.counts.tieup} 格、` +
      `踏序差异 ${dd.counts.treadling} 格）。` +
      `提综逐纬复现校验：<b class="${liftDiff ? "bad" : "ok"}">${liftDiff ? "有 " + liftDiff + " 格不一致（第 " + diffPicks.slice(0, 6).map((p) => p + 1).join("、") + " 纬）" : "完全一致 ✓"}</b>，` +
      `组织图差异 <b class="${dd.counts.face ? "bad" : "ok"}">${dd.counts.face} 格</b>。`;
    box.appendChild(info);

    const grids = document.createElement("div");
    grids.className = "td-preview-grids";
    const mk = (cls, title) => {
      const w = document.createElement("div");
      w.className = "td-pgrid " + cls;
      w.innerHTML = `<div class="td-pgrid-title">${title}</div>`;
      const cv = document.createElement("canvas");
      w.appendChild(cv);
      grids.appendChild(w);
      return cv;
    };
    box.appendChild(grids);
    const cvTie = mk("tie", "栓结矩阵（行＝综框，列＝踏板）");
    const cvTr = mk("tread", "踏序（行＝纬，红框为第 1 纬）");
    const cvLift = mk("lift", "候选提综状态（应与当前一致）");
    const cvCmp = mk("cmp", "候选组织全图（穿综/栓结/踏序/组织图）");

    // 可滚动网格
    const gTie = new DraftGrid({ canvas: cvTie, kind: "tieup", rows: nd.shafts, cols: nd.treadles,
                                 cellDefault: 15, readOnly: true });
    gTie.setMatrix(nd.tieup);
    const gTr = new DraftGrid({ canvas: cvTr, kind: "treadling", rows: nd.picks, cols: nd.treadles,
                                cellDefault: 15, readOnly: true });
    gTr.setMatrix(nd.treadling);
    const gL = new DraftGrid({ canvas: cvLift, kind: "lift", rows: nd.picks, cols: nd.shafts,
                               cellDefault: 13, readOnly: true });
    gL.setMatrix(na.lift);
    renderDraftComposite(cvCmp, nd, null);

    $("#tdApply").disabled = false;
  }

  async applySelected() {
    if (this.selected < 0 || !this.result) return;
    const cand = this.result.candidates[this.selected];
    const params = { treadles: this.T, maxPress: this.K,
                     locked: [...this.locked], index: this.selected };
    const msg = `应用候选 #${this.selected + 1}：栓结与踏序将被替换（${this.T} 个踏板）。\n` +
      `系统会先把当前草稿保存为“转换前”版本快照，再保存转换后的新版本，原草稿不会丢失。\n是否继续？`;
    if (!confirm(msg)) return;
    try {
      const label = await this.onApply(cand, params);
      this._renderMessage("info", `已应用候选 #${this.selected + 1}：${label || "新版本已保存"}。`);
    } catch (e) {
      alert("应用失败：" + e.message);
    }
  }
}

function gridLines(ctx, x0, y0, cols, rows, cell) {
  ctx.strokeStyle = "#d7dde3";
  ctx.lineWidth = .6;
  ctx.beginPath();
  for (let r = 0; r <= rows; r++) { ctx.moveTo(x0, y0 + r * cell + .3); ctx.lineTo(x0 + cols * cell, y0 + r * cell + .3); }
  for (let c = 0; c <= cols; c++) { ctx.moveTo(x0 + c * cell + .3, y0); ctx.lineTo(x0 + c * cell + .3, y0 + rows * cell); }
  ctx.stroke();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
