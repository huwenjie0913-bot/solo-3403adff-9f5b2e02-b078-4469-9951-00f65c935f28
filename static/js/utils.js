// utils.js —— 通用小工具：矩阵、颜色、DOM

/** 创建 rows×cols 的零矩阵 */
export function makeMatrix(rows, cols, fill = 0) {
  const m = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols);
    row.fill(fill);
    m.push(row);
  }
  return m;
}

/** 深拷贝矩阵 */
export function cloneMatrix(m) {
  return m.map((row) => row.slice());
}

/**
 * 把矩阵调整为 rows×cols，尽量保留左上角旧数据，新增格填 0。
 */
export function resizeMatrix(m, rows, cols) {
  const out = makeMatrix(rows, cols, 0);
  if (m) {
    for (let r = 0; r < Math.min(rows, m.length); r++) {
      const n = Math.min(cols, m[r].length);
      for (let c = 0; c < n; c++) out[r][c] = m[r][c];
    }
  }
  return out;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

/** 数组长度调整：保留旧值，新元素填 fill */
export function resizeArray(arr, len, fill = 0) {
  const out = new Array(len).fill(fill);
  if (arr) for (let i = 0; i < Math.min(len, arr.length); i++) out[i] = arr[i];
  return out;
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}
export function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

/** hex(#rrggbb) -> [r,g,b] */
export function hexToRgb(hex) {
  const h = (hex || "#000000").replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((x) => x + x).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 根据底色深浅选黑/白文字色 */
export function contrastText(hex) {
  const [r, g, b] = hexToRgb(hex);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return lum > 150 ? "#222" : "#fff";
}

export function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
}

/** 两个颜色混合，t∈[0,1]，t 越大越接近 b */
export function mixHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}

export function todayText() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatTime(iso) {
  if (!iso) return "";
  return iso.replace("T", " ").slice(0, 16);
}

/** 防抖 */
export function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}
