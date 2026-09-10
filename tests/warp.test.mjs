// 整经/穿筘核心逻辑回归测试（纯计算，无 DOM；node tests/warp.test.mjs）
import { sampleDraft } from "../static/js/model.js";
import {
  computeWarpPlan, defaultWarpPlan, suggestDentPattern, dentsPerCm,
  parsePattern, setBoutSize, ensureProgress, sanitizeBounds,
} from "../static/js/warp.js";

let fails = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) console.log("  ✓", label);
  else { console.error("  ✗", label, "期望", b, "实际", a); fails++; }
}
function ok(cond, label) {
  if (cond) console.log("  ✓", label);
  else { console.error("  ✗", label); fails++; }
}

console.log("— 建议穿筘模式 —");
eq(suggestDentPattern(10, 5), [2], "10根/cm ÷ 5齿/cm = [2]");
eq(suggestDentPattern(10, 4), [2, 3], "10÷4=2.5 → [2,3]");
eq(suggestDentPattern(8, 3), [2, 3, 3, 2, 3, 3, 2, 3], "8÷3≈2.67 误差扩散周期");
eq(suggestDentPattern(12, 5).reduce((a, b) => a + b, 0) / suggestDentPattern(12, 5).length > 2.3, true, "12÷5≈2.4 均值接近");
eq(parsePattern("2,3  4"), [2, 3, 4], "解析模式文本");
eq(parsePattern("", [2]), [2], "空文本回退");
eq(dentsPerCm({ reedDensity: 12, reedUnit: "in" }).toFixed(2), (12 / 2.54).toFixed(2), "英寸换算");

console.log("— 基础方案（示例草稿：24 根循环、幅宽 20cm、经密 10） —");
const d = sampleDraft();
d.warpPlan = defaultWarpPlan();          // 筘 5 齿/cm，模式 [2]，无边纱，每束 ≤40
let m = computeWarpPlan(d);
eq(m.totals.bodyEnds, 200, "布身 200 根");
eq(m.totals.totalEnds, 200, "总经 200 根");
eq(m.bodyDents, 100, "布身 100 齿");
eq(m.actualEpc, 10, "实际经密 10");
eq(m.devPct, 0, "密度偏差 0");
eq(m.bouts.length, 5, "5 束");
eq(m.bouts.map((b) => b.count), [40, 40, 40, 40, 40], "每束 40 根");
eq(m.totals.warpLenEach.toFixed(1), (30 / 0.92 + 60).toFixed(1), "单根长与用纱估算一致");
eq(m.issues.length, 0, "单色全幅：无切色误报、无其他问题");

console.log("— 多色色序：束界应避开色界 —");
const d2 = sampleDraft();
for (let e = 0; e < d2.ends; e++) d2.warpColors[e] = Math.floor(e / 4) % 2;   // 4 白 4 红
d2.warpPlan = defaultWarpPlan();
d2.warpPlan.maxBout = 36;
m = computeWarpPlan(d2);
ok(m.bouts.every((b) => b.count <= 36), "束均 ≤36");
eq(m.issues.filter((i) => i.kind === "boutCut").length, 0, "自动分束未切断色序");
eq(m.bounds[m.bounds.length - 1], 200, "边界止于总根数");
d2.warpPlan.boutBounds = [0, 35, 72, 108, 144, 200];
m = computeWarpPlan(d2);
eq(m.issues.filter((i) => i.kind === "boutCut").length > 0, true, "手动束界切色被标出");
eq(m.boundsAuto, false, "手动边界生效");

console.log("— 密度偏差与筘齿不匀 —");
const d3 = sampleDraft();
d3.warpPlan = defaultWarpPlan();
d3.warpPlan.reedDensity = 4.7;           // 实际 9.4 vs 目标 10 → -6%
m = computeWarpPlan(d3);
eq(m.issues.some((i) => i.kind === "density" && i.level === "error"), true, "偏差 >5% 报错");
d3.warpPlan.reedDensity = 5;
d3.warpPlan.dentPattern = [2, 3];        // 200 根 ÷ 5 根循环 → 整除，无残齿
m = computeWarpPlan(d3);
eq(m.issues.filter((i) => i.kind === "dentUneven").length, 0, "模式整除无不匀");
eq(m.actualEpc, 12.5, "模式[2,3] → 实际经密 12.5");
d3.warpPlan.dentPattern = [3];           // 200 ÷ 3 = 66×3 + 2 → 末齿 2 根不匀
m = computeWarpPlan(d3);
eq(m.issues.filter((i) => i.kind === "dentUneven").length, 1, "末齿不足被标出");
eq(m.dents[m.bodyDents - 1].count, 2, "末齿 2 根");

console.log("— 边纱规则 —");
const d4 = sampleDraft();
d4.warpPlan = defaultWarpPlan();
d4.warpPlan.selvEnds = 8;
d4.warpPlan.selvPerDent = 2;
m = computeWarpPlan(d4);
eq(m.totals.totalEnds, 216, "总经 216 根（200+8×2）");
eq(m.dents.filter((x) => x.zone === "L").length, 4, "左边纱 4 齿");
eq(m.dents.filter((x) => x.zone === "R").length, 4, "右边纱 4 齿");
eq(m.ends[0].zone, "L", "第 1 根为左边纱");
eq(m.ends[215].zone, "R", "末根为右边纱");
eq(m.ends[0].color, m.ends[8].color, "边纱颜色跟随相邻布身");
eq(m.issues.filter((i) => i.kind === "selvPlace").length, 0, "自动分束边纱落位正常");
d4.warpPlan.boutBounds = [0, 4, 60, 120, 216];
m = computeWarpPlan(d4);
eq(m.issues.some((i) => i.kind === "selvPlace" && i.level === "error"), true, "束界落入边纱区报错");
d4.warpPlan.boutBounds = null;
d4.warpPlan.selvEnds = 7;
m = computeWarpPlan(d4);
eq(m.issues.some((i) => i.kind === "selvDent"), true, "边纱余数被标出");

console.log("— 束界调整 —");
eq(setBoutSize([0, 40, 80, 120], 0, 30, 120), [0, 30, 80, 120], "首束调小");
eq(setBoutSize([0, 40, 80, 120], 1, 75, 120), [0, 40, 115, 120], "次束调大移动束界");
eq(setBoutSize([0, 40, 80, 120], 1, 100, 120), [0, 40, 119, 120], "次束最多撑到下一界前");
eq(setBoutSize([0, 40, 80, 120], 2, 10, 120), [0, 40, 80, 120], "末束不可调");
eq(sanitizeBounds([0, 40, 120], 120), [0, 40, 120], "合法边界");
eq(sanitizeBounds([0, 40, 100], 120), null, "末界不等于总根数 → 无效");
eq(sanitizeBounds([0, 50, 50, 120], 120), null, "非递增 → 无效");

console.log("— 进度结构 —");
const wp = defaultWarpPlan();
let p = ensureProgress(wp, 10);
eq(p.warped.length, 10, "整经数组长度 10");
p.warped[3] = true;
p = ensureProgress(wp, 10);
eq(p.warped[3], true, "同长度保留进度");
p = ensureProgress(wp, 12);
eq(p.warped.length, 12, "总根数变化后重置");
eq(p.warped[3], false, "重置后清空");

console.log("— 汇总与分色 —");
const d5 = sampleDraft();
for (let e = 0; e < d5.ends; e++) d5.warpColors[e] = e % 2;   // 两色交替
d5.warpPlan = defaultWarpPlan();
m = computeWarpPlan(d5);
eq(m.totals.byColor.map((c) => c.ends), [100, 100], "两色各 100 根");
eq(m.bouts[0].colors, { 0: 20, 1: 20 }, "首束分色各 20");
eq(m.totals.totalM.toFixed(1), (200 * m.totals.warpLenEach / 100).toFixed(1), "总长一致");
eq(m.bouts[1].startDent, 21, "第 2 束起始齿 21（40 根 ÷ 2/齿）");

console.log("— tex 换算回归（tex = g/km，cm → km 须 ÷100000） —");
// 200 根 × 100.0175 cm = 200.035 m，30 tex → 0.200035 km × 30 ≈ 6.001 g
const d6 = sampleDraft();
d6.settings.length = 100;
d6.settings.warpTakeup = 0;
d6.settings.wasteWarp = 0.0175;
d6.settings.warpTex = 30;
d6.warpPlan = defaultWarpPlan();
const m6 = computeWarpPlan(d6);
eq(m6.totals.totalM.toFixed(3), "200.035", "总长 200.035 m");
eq(m6.totals.weightG.toFixed(3), "6.001", "30 tex → 6.001 g（回归：曾误算为 600.104 g）");
ok(m6.totals.weightG < 10, "总量级为克而非百克");
// 整数情形：200 根 × 1 m = 200 m，30 tex → 6 g
const d7 = sampleDraft();
d7.settings.length = 100;
d7.settings.warpTakeup = 0;
d7.settings.wasteWarp = 0;
d7.settings.warpTex = 30;
d7.warpPlan = defaultWarpPlan();
eq(computeWarpPlan(d7).totals.weightG, 6, "200 m × 30 tex = 6 g");
// 分束、分色与全幅汇总互相吻合（屏幕分束表、全幅汇总、打印操作单均取同一字段）
eq(m6.bouts.reduce((a, b) => a + b.weightG, 0).toFixed(9), m6.totals.weightG.toFixed(9), "各束质量之和 = 全幅质量");
eq(m6.totals.byColor.reduce((a, c) => a + c.weightG, 0).toFixed(9), m6.totals.weightG.toFixed(9), "分色质量之和 = 全幅质量");
eq(m6.bouts[0].weightG.toFixed(3), (40 * 100.0175 / 100000 * 30).toFixed(3), "单束质量按同一公式");

console.log("— 屏幕与打印一致（操作单渲染同一模型） —");
// 最小 document 存根：buildWarpSheet 只用 createElement/innerHTML/appendChild
global.document = {
  createElement: () => ({
    innerHTML: "", textContent: "", children: [],
    appendChild(c) { this.children.push(c); },
  }),
};
const { buildWarpSheet } = await import("../static/js/warpsheet.js");
const root = { innerHTML: "", children: [], appendChild(c) { this.children.push(c); } };
buildWarpSheet(root, "回归", d6);
const html = root.children.map((c) => c.innerHTML || "").join("\n");
ok(html.includes("<th>6</th>"), `操作单全幅合计 6 g（屏幕显示 ${m6.totals.weightG.toFixed(1)} g，同源）`);
ok(html.includes("<td>1.2</td>"), `操作单每束 1.2 g（屏幕分束表同为 ${m6.bouts[0].weightG.toFixed(1)} g）`);
ok(!html.includes("600.1"), "操作单不再出现放大 100 倍的数值");

console.log(fails ? `\n共 ${fails} 项失败` : "\n全部通过");
process.exit(fails ? 1 : 0);
