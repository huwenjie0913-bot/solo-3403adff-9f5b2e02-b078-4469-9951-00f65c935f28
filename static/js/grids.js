// grids.js —— Canvas 二进制网格与色条组件
import { makeMatrix, clamp, contrastText } from "./utils.js";

const PAD_TOP = 18;
const PAD_LEFT = 26;

/**
 * 通用二进制网格。
 * opts:
 *   canvas, rows, cols, cellDefault(px),
 *   kind: 'threading' | 'tieup' | 'treadling' | 'lift' | 'drawdown'
 *   singlePerColumn: 每列至多一个 1（穿综）
 *   readOnly
 *   onChange() 任何编辑后回调；onEdit([{r,c,val}]) 提交给撤销栈
 *   cellColor(r,c,v) 自定义填色；rowBad / colBad 行/列整行弱红
 */
export class DraftGrid {
  constructor(opts) {
    this.cv = opts.canvas;
    this.ctx = this.cv.getContext("2d");
    this.kind = opts.kind || "grid";
    this.rows = opts.rows;
    this.cols = opts.cols;
    this.cell = opts.cellDefault || 16;
    this.singlePerColumn = !!opts.singlePerColumn;
    this.readOnly = !!opts.readOnly;
    this.onChange = opts.onChange || (() => {});
    this.onEdit = opts.onEdit || (() => {});
    this.onBeginEdit = opts.onBeginEdit || (() => {});
    this.cellColor = opts.cellColor || null;
    this.rowBad = opts.rowBad || (() => false);
    this.colBad = opts.colBad || (() => false);
    this.rowEmpty = opts.rowEmpty || (() => false);
    this.floatCells = opts.floatCells || null;
    this.once = null;

    this.tool = "paint";
    this.data = makeMatrix(this.rows, this.cols);
    this.sel = null;                 // {r1,c1,r2,c2} 含端点
    this.hover = null;
    this.drag = null;                // {mode:'paint'|'erase'|'select', startR,startC, val}
    this.flash = null;               // {r,c,t}
    this.markRects = [];             // 额外高亮矩形 [{r,c,color}]
    this.clipboard = null;           // 共享 {rows,cols,data,singlePerColumn}
    this.majorEvery = 5;

    this._bind();
    this.resize();
  }

  setMatrix(m) {
    this.rows = m.length;
    this.cols = m[0] ? m[0].length : 0;
    this.data = m;
    this.sel = null;
    this.markRects = [];
    this.resize();
  }

  setCellSize(px) {
    this.cell = clamp(px | 0, 6, 40);
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = PAD_LEFT + this.cols * this.cell;
    this.h = PAD_TOP + this.rows * this.cell;
    this.cv.style.width = this.w + "px";
    this.cv.style.height = this.h + "px";
    this.cv.width = Math.round(this.w * dpr);
    this.cv.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  // ------------------------------------------------------------------ #
  cellAt(evt) {
    const rect = this.cv.getBoundingClientRect();
    const x = evt.clientX - rect.left - PAD_LEFT;
    const y = evt.clientY - rect.top - PAD_TOP;
    const c = Math.floor(x / this.cell);
    const r = Math.floor(y / this.cell);
    if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) return null;
    return { r, c };
  }

  _bind() {
    const down = (e) => {
      if (this.readOnly || e.button !== 0) return;
      const p = this.cellAt(e);
      if (!p) return;
      e.preventDefault();
      window._gridFocus = this;
      if (this.tool === "select") {
        this.drag = { mode: "select", startR: p.r, startC: p.c };
        this.sel = { r1: p.r, c1: p.c, r2: p.r, c2: p.c };
      } else if (this.tool === "paint") {
        const val = this.singlePerColumn ? 1 : (this.data[p.r][p.c] ? 0 : 1);
        // 只有第一格确实会改值时，才在改动前建立撤销快照
        const willChange = this.singlePerColumn
          ? this.data.some((row, s) => row[p.c] !== (s === p.r ? val : 0))
          : !!this.data[p.r][p.c] !== !!val;
        if (willChange && !this.drag) this.onBeginEdit();
        this.drag = { mode: "paint", val };
        this._paintCell(p.r, p.c, val);
        this.once = [p];
      } else {
        if (this.data[p.r][p.c] !== 0 && !this.drag) this.onBeginEdit();
        this.drag = { mode: "erase" };
        this._paintCell(p.r, p.c, 0);
        this.once = [p];
      }
      this.draw();
    };
    const move = (e) => {
      const p = this.cellAt(e);
      this.hover = p;
      if (this.drag && p) {
        if (this.drag.mode === "select") {
          this.sel = {
            r1: this.drag.startR, c1: this.drag.startC,
            r2: clamp(p.r, 0, this.rows - 1), c2: clamp(p.c, 0, this.cols - 1),
          };
        } else {
          const val = this.drag.mode === "erase" ? 0 : this.drag.val;
          this._paintCell(p.r, p.c, val);
          if (this.once) this.once.push(p);
        }
      }
      this.draw();
    };
    const up = () => {
      if (this.drag) {
        this.once = null;
        this.drag = null;
        this.onChange();
      }
    };
    this.cv.addEventListener("mousedown", down);
    this.cv.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    this.cv.addEventListener("mouseleave", () => { this.hover = null; this.draw(); });
  }

  _paintCell(r, c, val) {
    if (this.singlePerColumn) {
      let changed = false;
      for (let s = 0; s < this.rows; s++) {
        const v = s === r ? val : 0;
        if (this.data[s][c] !== v) changed = true;
        this.data[s][c] = v;
      }
      return changed;
    }
    this.data[r][c] = val ? 1 : 0;
    return true;
  }

  setTool(t) { this.tool = t; }

  // ------------------------------------------------------------------ #
  // 选区操作
  selBounds() {
    if (!this.sel) return null;
    return {
      r1: Math.min(this.sel.r1, this.sel.r2),
      r2: Math.max(this.sel.r1, this.sel.r2),
      c1: Math.min(this.sel.c1, this.sel.c2),
      c2: Math.max(this.sel.c1, this.sel.c2),
    };
  }

  clearSelection() { this.sel = null; this.draw(); }
  selectAll() {
    this.sel = { r1: 0, c1: 0, r2: this.rows - 1, c2: this.cols - 1 };
    this.draw();
  }

  copySelection() {
    const b = this.selBounds();
    if (!b) return null;
    const rows = b.r2 - b.r1 + 1, cols = b.c2 - b.c1 + 1;
    const data = makeMatrix(rows, cols);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        data[r][c] = this.data[b.r1 + r][b.c1 + c];
    this.clipboard = { rows, cols, data, singlePerColumn: this.singlePerColumn };
    return this.clipboard;
  }

  getClipboard() {
    return window._gridClipboard || null;
  }
  setClipboard(cb) { window._gridClipboard = cb; }

  /** 在选区/点击处粘贴；没有则左上角。返回变更列表 */
  pasteClipboard(cb, at = null) {
    if (!cb) return [];
    const edits = [];
    const r0 = at ? at.r : (this.selBounds() ? this.selBounds().r1 : 0);
    const c0 = at ? at.c : (this.selBounds() ? this.selBounds().c1 : 0);
    // 穿综每列只保留母版中最上面一个 1；未被母版覆盖的列保持原样
    const chosen = {};
    for (let dr = 0; dr < cb.rows; dr++) {
      for (let dc = 0; dc < cb.cols; dc++) {
        const r = r0 + dr, c = c0 + dc;
        if (r >= this.rows || c >= this.cols) continue;
        if (this.singlePerColumn) {
          if (!(c in chosen) && cb.data[dr][dc]) chosen[c] = r;
        } else if (this.data[r][c] !== cb.data[dr][dc]) {
          this.data[r][c] = cb.data[dr][dc] ? 1 : 0;
          edits.push({ r, c, val: cb.data[dr][dc] ? 1 : 0 });
        }
      }
    }
    if (this.singlePerColumn) {
      for (const cStr of Object.keys(chosen)) {
        const c = +cStr, target = chosen[c];
        for (let r = 0; r < this.rows; r++) {
          const v = r === target ? 1 : 0;
          if (this.data[r][c] !== v) { this.data[r][c] = v; edits.push({ r, c, val: v }); }
        }
      }
    }
    this.sel = { r1: r0, c1: c0, r2: Math.min(this.rows - 1, r0 + cb.rows - 1),
                 c2: Math.min(this.cols - 1, c0 + cb.cols - 1) };
    this.draw();
    return edits;
  }

  mirror(horizontal) {
    const b = this.selBounds();
    const r1 = b ? b.r1 : 0, r2 = b ? b.r2 : this.rows - 1;
    const c1 = b ? b.c1 : 0, c2 = b ? b.c2 : this.cols - 1;
    const sub = [];
    for (let r = r1; r <= r2; r++) sub.push(this.data[r].slice(c1, c2 + 1));
    const R = sub.length, C = sub[0].length;
    const out = makeMatrix(R, C);
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++) {
        if (horizontal) out[r][c] = sub[r][C - 1 - c];
        else out[r][c] = sub[R - 1 - r][c];
      }
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++)
        this.data[r1 + r][c1 + c] = out[r][c];
    if (this.singlePerColumn) this._enforceSingle(c1, c2);
    this.draw();
  }

  _enforceSingle(c1, c2) {
    for (let c = c1; c <= c2; c++) {
      let seen = false;
      for (let r = 0; r < this.rows; r++) {
        if (this.data[r][c]) {
          if (seen) this.data[r][c] = 0;
          else seen = true;
        }
      }
    }
  }

  clearRegion() {
    const b = this.selBounds();
    if (!b) return;
    for (let r = b.r1; r <= b.r2; r++)
      for (let c = b.c1; c <= b.c2; c++) this.data[r][c] = 0;
    this.draw();
  }

  /** 以选区内图案为母版，按 dir（'h'|'v'|'both'）平铺到整个网格 */
  cycleFill(dir = "both") {
    const b = this.selBounds();
    if (!b) return;
    const R = b.r2 - b.r1 + 1, C = b.c2 - b.c1 + 1;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const rr = (dir === "h") ? r : (b.r1 + ((r - b.r1) % R + R) % R);
        const cc = (dir === "v") ? c : (b.c1 + ((c - b.c1) % C + C) % C);
        this.data[r][c] = this.data[rr][cc];
      }
    }
    if (this.singlePerColumn) this._enforceSingle(0, this.cols - 1);
    this.draw();
  }

  locate(r, c) {
    this.flash = { r: clamp(r, 0, this.rows - 1), c: clamp(c, 0, this.cols - 1), n: 4 };
    this.draw();
    const cv = this.cv;
    const x = PAD_LEFT + this.flash.c * this.cell;
    const y = PAD_TOP + this.flash.r * this.cell;
    const scroller = cv.closest(".center-scroll") || cv.parentElement;
    if (scroller) {
      scroller.scrollLeft = Math.max(0, x + scroller.clientLeft - 120);
      scroller.scrollTop = Math.max(0, y + scroller.clientTop - 140);
    }
    clearInterval(this._flashTimer);
    this._flashTimer = setInterval(() => {
      this.flash.n--;
      if (this.flash.n <= 0) { clearInterval(this._flashTimer); this.flash = null; }
      this.draw();
    }, 350);
  }

  // ------------------------------------------------------------------ #
  // 绘制
  draw() {
    const ctx = this.ctx, cs = this.cell;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, this.w, this.h);

    // 空梭口行底色（踏序/提综/组织图）
    for (let r = 0; r < this.rows; r++) {
      if (this.rowEmpty(r)) {
        ctx.fillStyle = "rgba(214,90,90,.10)";
        ctx.fillRect(PAD_LEFT, PAD_TOP + r * cs, this.cols * cs, cs);
      }
    }

    // 未使用综框列/行弱色（由 colBad/rowBad 提供）
    for (let r = 0; r < this.rows; r++) if (this.rowBad(r)) {
      ctx.fillStyle = "rgba(224,162,61,.10)";
      ctx.fillRect(PAD_LEFT, PAD_TOP + r * cs, this.cols * cs, cs);
    }
    for (let c = 0; c < this.cols; c++) if (this.colBad(c)) {
      ctx.fillStyle = "rgba(224,162,61,.10)";
      ctx.fillRect(PAD_LEFT + c * cs, PAD_TOP, cs, this.rows * cs);
    }

    // 单元
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const x = PAD_LEFT + c * cs, y = PAD_TOP + r * cs;
        const v = this.data[r][c];
        if (this.cellColor) {
          const fill = this.cellColor(r, c, v);
          if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, cs, cs); }
        } else if (v) {
          ctx.fillStyle = this.readOnly ? "#4a5a6b" : "#2f6ea8";
          ctx.fillRect(x + 1, y + 1, cs - 2, cs - 2);
        }
      }
    }

    // 浮长描边
    if (this.floatCells) {
      ctx.strokeStyle = "#d65a5a";
      ctx.lineWidth = 1.6;
      for (const k of this.floatCells) {
        const [p, e] = k.split(",").map(Number);
        if (p < this.rows && e < this.cols)
          ctx.strokeRect(PAD_LEFT + e * cs + .8, PAD_TOP + p * cs + .8, cs - 1.6, cs - 1.6);
      }
    }

    // 额外标记
    for (const m of this.markRects) {
      ctx.strokeStyle = m.color || "#e0a23d";
      ctx.lineWidth = 2;
      ctx.strokeRect(PAD_LEFT + m.c * cs + 1, PAD_TOP + m.r * cs + 1, cs - 2, cs - 2);
    }

    // 网格线
    ctx.strokeStyle = "#d7dde3";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let r = 0; r <= this.rows; r++) {
      const y = PAD_TOP + r * cs + .5;
      ctx.moveTo(PAD_LEFT, y); ctx.lineTo(PAD_LEFT + this.cols * cs, y);
    }
    for (let c = 0; c <= this.cols; c++) {
      const x = PAD_LEFT + c * cs + .5;
      ctx.moveTo(x, PAD_TOP); ctx.lineTo(x, PAD_TOP + this.rows * cs);
    }
    ctx.stroke();
    // 每 5 格加深
    ctx.strokeStyle = "#aeb9c4";
    ctx.beginPath();
    for (let r = 0; r <= this.rows; r += this.majorEvery) {
      const y = PAD_TOP + r * cs + .5;
      ctx.moveTo(PAD_LEFT, y); ctx.lineTo(PAD_LEFT + this.cols * cs, y);
    }
    for (let c = 0; c <= this.cols; c += this.majorEvery) {
      const x = PAD_LEFT + c * cs + .5;
      ctx.moveTo(x, PAD_TOP); ctx.lineTo(x, PAD_TOP + this.rows * cs);
    }
    ctx.stroke();

    // 第一根经纱/第一纬红框
    ctx.strokeStyle = "#d65a5a";
    ctx.lineWidth = 1.4;
    if (this.kind === "threading")
      ctx.strokeRect(PAD_LEFT + .7, PAD_TOP + .7, cs - 1.4, this.rows * cs - 1.4);
    if (this.kind === "treadling")
      ctx.strokeRect(PAD_LEFT + .7, PAD_TOP + .7, this.cols * cs - 1.4, cs - 1.4);

    // 选区
    if (this.sel) {
      const b = {
        r1: Math.min(this.sel.r1, this.sel.r2), c1: Math.min(this.sel.c1, this.sel.c2),
        r2: Math.max(this.sel.r1, this.sel.r2), c2: Math.max(this.sel.c1, this.sel.c2),
      };
      ctx.fillStyle = "rgba(61,122,184,.14)";
      ctx.fillRect(PAD_LEFT + b.c1 * cs, PAD_TOP + b.r1 * cs,
                   (b.c2 - b.c1 + 1) * cs, (b.r2 - b.r1 + 1) * cs);
      ctx.strokeStyle = "#3d7ab8";
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(PAD_LEFT + b.c1 * cs + .5, PAD_TOP + b.r1 * cs + .5,
                     (b.c2 - b.c1 + 1) * cs - 1, (b.r2 - b.r1 + 1) * cs - 1);
      ctx.setLineDash([]);
    }

    // 粘贴预览
    const cb = this.getClipboard();
    if (!this.readOnly && cb && this.hover && this.tool !== "select") {
      ctx.strokeStyle = "#7a9bb8";
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(PAD_LEFT + this.hover.c * cs + .5, PAD_TOP + this.hover.r * cs + .5,
                     Math.min(cb.cols, this.cols - this.hover.c) * cs - 1,
                     Math.min(cb.rows, this.rows - this.hover.r) * cs - 1);
      ctx.setLineDash([]);
    }

    // 定位闪烁
    if (this.flash) {
      const alpha = this.flash.n % 2 ? .85 : .25;
      ctx.fillStyle = `rgba(230,160,40,${alpha})`;
      ctx.fillRect(PAD_LEFT + this.flash.c * cs, PAD_TOP + this.flash.r * cs, cs, cs);
      ctx.strokeStyle = "#b5651d";
      ctx.lineWidth = 2.5;
      ctx.strokeRect(PAD_LEFT + this.flash.c * cs + 1, PAD_TOP + this.flash.r * cs + 1, cs - 2, cs - 2);
    }

    this._drawLabels(ctx, cs);
  }

  _drawLabels(ctx, cs) {
    ctx.fillStyle = "#8a96a2";
    ctx.font = cs >= 12 ? "9px sans-serif" : "8px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const step = this.cols > 60 ? 10 : 5;
    for (let c = 0; c < this.cols; c += step) {
      ctx.fillText(String(c + 1), PAD_LEFT + c * cs + cs / 2, 9);
    }
    const rstep = this.rows > 60 ? 10 : 5;
    ctx.textAlign = "right";
    for (let r = 0; r < this.rows; r += rstep) {
      ctx.fillText(String(r + 1), PAD_LEFT - 3, PAD_TOP + r * cs + cs / 2);
    }
  }
}

/**
 * 色条：单行颜色序列。
 * opts: canvas, onChange, onEdit
 */
export class ColorStrip {
  constructor(opts) {
    this.cv = opts.canvas;
    this.ctx = this.cv.getContext("2d");
    this.palette = opts.palette || ["#eee", "#333"];
    this.values = opts.values || [];
    this.onChange = opts.onChange || (() => {});
    this.onEdit = opts.onEdit || (() => {});
    this.onBeginEdit = opts.onBeginEdit || (() => {});
    this.tool = "paint";          // 'paint' | 'cycle' | 'reverse'
    this.cell = 18;
    this.h = 30;
    this.flash = null;
    this.drag = null;
    this._bind();
    this.resize();
  }

  setValues(values, palette) {
    this.values = values;
    this.palette = palette;
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = PAD_LEFT + this.values.length * this.cell;
    this.cv.style.width = this.w + "px";
    this.cv.style.height = this.h + "px";
    this.cv.width = Math.round(this.w * dpr);
    this.cv.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  cellAt(evt) {
    const rect = this.cv.getBoundingClientRect();
    const x = evt.clientX - rect.left - PAD_LEFT;
    const c = Math.floor(x / this.cell);
    return (c >= 0 && c < this.values.length) ? c : null;
  }

  _bind() {
    const down = (e) => {
      const c = this.cellAt(e);
      if (c == null) return;
      e.preventDefault();
      const active = this.activeColor ?? 0;
      if (this.tool === "cycle") {
        // 从点击处开始，用整个调色板循环铺满
        let any = false;
        for (let i = c; i < this.values.length; i++) {
          if (this.values[i] !== ((i - c) + active) % this.palette.length) { any = true; break; }
        }
        if (!any) return;
        this.onBeginEdit();
        for (let i = c; i < this.values.length; i++)
          this.values[i] = ((i - c) + active) % this.palette.length;
        this.onChange();
        this.draw();
      } else if (this.tool === "reverse") {
        // 反转整个色序（镜像）
        this.onBeginEdit();
        this.values.reverse();
        this.onChange();
        this.draw();
      } else {
        // paint：在第一次真正改值前建立撤销快照
        let began = false;
        const apply = (idx) => {
          const val = active;
          if (this.values[idx] !== val) {
            if (!began) { this.onBeginEdit(); began = true; }
            this.values[idx] = val;
          }
        };
        apply(c);
        this.drag = true;
        const move = (ev) => {
          const cc = this.cellAt(ev);
          if (cc != null) apply(cc);
          this.draw();
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          this.drag = null;
          if (began) this.onChange();
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        this.draw();
      }
    };
    this.cv.addEventListener("mousedown", down);
  }

  setTool(t) { this.tool = t; }
  setActiveColor(idx) { this.activeColor = idx; }

  locate(c) {
    this.flash = clamp(c, 0, this.values.length - 1);
    this.draw();
    clearInterval(this._ft);
    let n = 4;
    this._ft = setInterval(() => {
      n--;
      if (n <= 0) { clearInterval(this._ft); this.flash = null; }
      this.draw();
    }, 350);
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, this.w, this.h);
    for (let c = 0; c < this.values.length; c++) {
      const x = PAD_LEFT + c * this.cell;
      const col = this.palette[this.values[c]] || "#ccc";
      ctx.fillStyle = col;
      ctx.fillRect(x + 1, 2, this.cell - 2, this.h - 4);
      // 5 格分隔
      if (c % 5 === 0) {
        ctx.fillStyle = contrastText(col);
        ctx.font = "8px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(c + 1), x + this.cell / 2, this.h / 2);
      }
      ctx.strokeStyle = "rgba(0,0,0,.18)";
      ctx.strokeRect(x + .5, 2.5, this.cell - 1, this.h - 5);
    }
    if (this.flash != null) {
      ctx.strokeStyle = "#b5651d";
      ctx.lineWidth = 2.5;
      ctx.strokeRect(PAD_LEFT + this.flash * this.cell + 1, 3, this.cell - 2, this.h - 6);
    }
  }
}
