// warpview.js —— 逐根上机视图：把经纱编号、颜色、综框、筘齿串成可缩放路径，
// 三阶段（整经/穿综/穿筘）逐根勾选。视口裁剪渲染，数千根也能流畅滚动。
import { STAGES } from "./warp.js";

const GUTTER = 56;                 // 左侧行标签列宽
const ROW_DEF = [
  { key: "bout",  label: "束",   h: 16 },
  { key: "num",   label: "编号", h: 15 },
  { key: "color", label: "颜色", h: 20 },
  { key: "shaft", label: "综框", h: 15 },
  { key: "dent",  label: "筘齿", h: 15 },
  { key: "s0",    label: "整经", h: 18 },
  { key: "s1",    label: "穿综", h: 18 },
  { key: "s2",    label: "穿筘", h: 18 },
];

export class WarpView {
  /**
   * opts: canvas, scroller(滚动容器), spacer(撑宽内层),
   *   onToggle(endIdx, stageKey), onCursor(endIdx), onLocate(endIdx)
   */
  constructor(opts) {
    this.cv = opts.canvas;
    this.ctx = this.cv.getContext("2d");
    this.scroller = opts.scroller;
    this.spacer = opts.spacer;
    this.onToggle = opts.onToggle || (() => {});
    this.onCursor = opts.onCursor || (() => {});
    this.onLocate = opts.onLocate || (() => {});

    this.cw = 10;                  // 每根经纱像素宽（缩放）
    this.model = null;
    this.palette = [];
    this.progress = null;
    this.cursor = 0;
    this.stage = 0;                // STAGES 下标

    this.rowY = {}; this.rowH = {};
    let y = 0;
    for (const r of ROW_DEF) { this.rowY[r.key] = y; this.rowH[r.key] = r.h; y += r.h; }
    this.height = y + 2;

    this._bind();
  }

  setModel(model, palette, progress) {
    this.model = model;
    this.palette = palette;
    this.progress = progress;
    if (this.cursor >= model.ends.length) this.cursor = model.ends.length - 1;
    this.resize();
  }

  setZoom(px) {
    this.cw = Math.max(3, Math.min(36, px | 0));
    this.resize();
  }

  setCursor(i, scroll = true) {
    if (!this.model) return;
    this.cursor = Math.max(0, Math.min(this.model.ends.length - 1, i));
    if (scroll) this.ensureVisible();
    this.onCursor(this.cursor);
    this.draw();
  }

  ensureVisible() {
    const x = GUTTER + this.cursor * this.cw;
    const sl = this.scroller.scrollLeft, W = this.scroller.clientWidth;
    if (x < sl + GUTTER + this.cw) this.scroller.scrollLeft = Math.max(0, x - GUTTER - this.cw * 2);
    else if (x + this.cw > sl + W - 8) this.scroller.scrollLeft = x - W + this.cw * 3;
  }

  resize() {
    if (!this.model) return;
    const total = this.model.ends.length;
    this.spacer.style.width = GUTTER + total * this.cw + 8 + "px";
    this.spacer.style.height = this.height + "px";
    const W = Math.max(120, this.scroller.clientWidth);
    const dpr = window.devicePixelRatio || 1;
    this.cv.style.width = W + "px";
    this.cv.style.height = this.height + "px";
    this.cv.width = Math.round(W * dpr);
    this.cv.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  // ------------------------------------------------------------------ #
  _bind() {
    this.cv.addEventListener("mousedown", (e) => {
      if (!this.model || e.button !== 0) return;
      const rect = this.cv.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (x < GUTTER) return;
      const i = Math.floor((x - GUTTER + this.scroller.scrollLeft) / this.cw);
      if (i < 0 || i >= this.model.ends.length) return;
      e.preventDefault();
      let row = null;
      for (const r of ROW_DEF) if (y >= this.rowY[r.key] && y < this.rowY[r.key] + r.h) { row = r.key; break; }
      if (row === "s0" || row === "s1" || row === "s2") {
        const st = +row[1];
        this.stage = st;
        this.onToggle(i, STAGES[st].key);
      }
      this.setCursor(i, false);
    });
    this.cv.addEventListener("dblclick", () => this.onLocate(this.cursor));
    this.scroller.addEventListener("scroll", () => {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
    });
  }

  // ------------------------------------------------------------------ #
  draw() {
    if (!this.model) return;
    const ctx = this.ctx, cw = this.cw, m = this.model;
    const W = this.cv.clientWidth || 120, H = this.height;
    const sl = this.scroller.scrollLeft;
    const total = m.ends.length;
    const e0 = Math.max(0, Math.floor((sl - GUTTER) / cw));
    const e1 = Math.min(total - 1, Math.ceil((sl + W - GUTTER) / cw));
    const X = (i) => GUTTER + i * cw - sl;
    const Y = this.rowY, RH = this.rowH;
    const stageTop = Y.s0, stageBot = Y.s2 + RH.s2;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);

    // 当前阶段行底色
    ctx.fillStyle = "rgba(61,122,184,.08)";
    ctx.fillRect(0, Y["s" + this.stage], W, RH["s" + this.stage]);

    // 边纱区底色
    for (let i = e0; i <= e1; i++) {
      if (m.ends[i].zone !== "B") {
        ctx.fillStyle = "rgba(90,107,122,.10)";
        ctx.fillRect(X(i), Y.num, cw, stageBot - Y.num);
      }
    }
    // 布身/边纱分界
    if (m.selv > 0) {
      ctx.strokeStyle = "#5a93d6";
      ctx.lineWidth = 1.5;
      for (const b of [m.selv, total - m.selv]) {
        const x = X(b);
        if (x < GUTTER - 2 || x > W + 2) continue;
        ctx.beginPath(); ctx.moveTo(x, Y.num); ctx.lineTo(x, stageBot); ctx.stroke();
      }
    }

    // 束号与束边界
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "10px sans-serif";
    for (const bt of m.bouts) {
      const xs = X(bt.start), xe = X(bt.end);
      if (xe < GUTTER || xs > W) continue;
      const cx = (Math.max(xs, GUTTER) + Math.min(xe, W)) / 2;
      ctx.fillStyle = "#5a6b7a";
      ctx.fillText(`束${bt.idx + 1}`, cx, Y.bout + RH.bout / 2);
      if (bt.start > 0) {
        ctx.strokeStyle = "#8a96a2";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(xs, Y.bout); ctx.lineTo(xs, stageBot); ctx.stroke();
      }
    }

    // 筘齿边界与齿号
    ctx.strokeStyle = "#dde3e9";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const dt of m.dents) {
      if (dt.start === 0) continue;
      const x = X(dt.start);
      if (x < GUTTER || x > W) continue;
      ctx.moveTo(x + .5, Y.dent); ctx.lineTo(x + .5, Y.dent + RH.dent);
    }
    ctx.stroke();
    ctx.fillStyle = "#8a96a2";
    ctx.font = "8px sans-serif";
    for (const dt of m.dents) {
      const xs = X(dt.start), xe = X(dt.end);
      if (xe < GUTTER || xs > W) continue;
      if (xe - xs >= 12) ctx.fillText(String(dt.idx + 1), (xs + xe) / 2, Y.dent + RH.dent / 2);
    }

    // 逐根：编号 / 颜色 / 综框 / 三阶段格
    const numStep = cw >= 11 ? 1 : cw >= 7 ? 2 : cw >= 5 ? 5 : 10;
    ctx.font = cw >= 9 ? "8px sans-serif" : "7px sans-serif";
    for (let i = e0; i <= e1; i++) {
      const x = X(i);
      const e = m.ends[i];
      if (i === 0 || (i + 1) % numStep === 0) {
        ctx.fillStyle = "#8a96a2";
        ctx.fillText(String(i + 1), x + cw / 2, Y.num + RH.num / 2);
      }
      ctx.fillStyle = this.palette[e.color] || "#ccc";
      ctx.fillRect(x + .5, Y.color + 1, cw - 1, RH.color - 2);
      if (cw >= 7) {
        ctx.fillStyle = "#46535f";
        ctx.fillText(e.shaft >= 0 ? String(e.shaft + 1) : "—", x + cw / 2, Y.shaft + RH.shaft / 2);
      }
      for (let s = 0; s < 3; s++) {
        const key = STAGES[s].key;
        const yy = Y["s" + s], hh = RH["s" + s];
        const done = !!(this.progress && this.progress[key] && this.progress[key][i]);
        ctx.fillStyle = done ? "#3d9950" : "#ffffff";
        ctx.fillRect(x + 1, yy + 2, cw - 2, hh - 4);
        ctx.strokeStyle = done ? "#2c7a3c" : "#c3ccd4";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 1.5, yy + 2.5, cw - 3, hh - 5);
        if (done && cw >= 8) {
          ctx.fillStyle = "#ffffff";
          ctx.fillText("✓", x + cw / 2, yy + hh / 2 + .5);
        }
      }
    }

    // 竖向细格线
    if (cw >= 5) {
      ctx.strokeStyle = "#eef1f4";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = e0; i <= e1 + 1; i++) {
        const x = X(i) + .5;
        if (x < GUTTER) continue;
        ctx.moveTo(x, Y.num); ctx.lineTo(x, stageBot);
      }
      ctx.stroke();
    }

    // 行分隔线
    ctx.strokeStyle = "#d7dde3";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const r of ROW_DEF) {
      const yy = this.rowY[r.key] + .5;
      ctx.moveTo(0, yy); ctx.lineTo(W, yy);
    }
    ctx.moveTo(0, stageBot + .5); ctx.lineTo(W, stageBot + .5);
    ctx.stroke();

    // 光标列
    const cx = X(this.cursor);
    if (cx + cw >= GUTTER && cx <= W) {
      ctx.strokeStyle = "#e07b39";
      ctx.lineWidth = 2;
      ctx.strokeRect(cx + .5, Y.bout + .5, cw - 1, stageBot - Y.bout - 1);
      const yy = Y["s" + this.stage];
      ctx.strokeStyle = "#b5531d";
      ctx.strokeRect(cx + 1, yy + 1.5, cw - 2, RH["s" + this.stage] - 3);
    }

    // 左侧行标签列（最后画，盖住滑过的内容）
    ctx.fillStyle = "#f2f5f8";
    ctx.fillRect(0, 0, GUTTER, H);
    ctx.strokeStyle = "#c3ccd4";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(GUTTER + .5, 0); ctx.lineTo(GUTTER + .5, H); ctx.stroke();
    ctx.fillStyle = "#566575";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    for (const r of ROW_DEF) ctx.fillText(r.label, GUTTER - 6, this.rowY[r.key] + r.h / 2);
    ctx.textAlign = "center";
  }
}
