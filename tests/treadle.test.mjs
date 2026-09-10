// 提综→踏板转换核心逻辑回归测试（纯计算，无 DOM；node tests/treadle.test.mjs）
import { sampleDraft, createDraft } from "../static/js/model.js";
import { analyze } from "../static/js/weave.js";
import { solveTreadle } from "../static/js/treadle.js";

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

/** 用候选栓结/踏序推演逐纬提综位掩码（BigInt），与目标 lift 比较 */
function reproduced(draft, cand) {
  const nd = createDraft({
    ...draft, treadles: cand.tieup[0].length,
    tieup: cand.tieup, treadling: cand.treadling,
  });
  const got = analyze(nd).lift;
  const want = analyze(draft).lift;
  let diff = 0;
  for (let p = 0; p < draft.picks; p++)
    for (let s = 0; s < draft.shafts; s++)
      if ((got[p][s] || 0) !== (want[p][s] || 0)) diff++;
  return diff;
}

console.log("— 2/2 斜纹示例（4 综 4 踏，每纬 ≤2 踏）—");
let d = sampleDraft();
let r = solveTreadle({ shafts: 4, lift: analyze(d).lift, treadles: 4, maxPress: 2,
                       currentTie: d.tieup, locked: [], keep: [], forbid: [] });
ok(r.ok, "有解");
ok(r.candidates.length >= 1, "至少一个候选");
eq(reproduced(d, r.candidates[0]), 0, "最优候选逐纬精确复现提综");
ok(r.candidates[0].usedTreadles <= 4, "用踏数不超过 4");
// 排序：用踏数、多踏纬数、总踩踏、改动量
const keys = r.candidates.map((c) => [c.usedTreadles, c.multiPicks, c.totalPresses, c.changeCells]);
let sorted = true;
for (let i = 1; i < keys.length; i++)
  for (let k = 0; k < 4; k++) {
    if (keys[i - 1][k] !== keys[i][k]) {
      if (keys[i - 1][k] > keys[i][k]) sorted = false;
      break;
    }
  }
ok(sorted, "候选按四级键排序");

console.log("— 原栓结（零改动）方案排在同等候选前列 —");
eq(r.candidates[0].changeCells, 0, "首候选栓结改动量为 0（沿用现有栓结）");

console.log("— 踏板数压缩：含并集组合（4 综，3 种提综 → 2 踏，需多踏）—");
d = createDraft({ ends: 8, shafts: 4, treadles: 4, picks: 6 });
for (let e = 0; e < 8; e++) d.threading[e % 4][e] = 1;
// 现有 4 踏：全综、{2,3}、{0,1}、全综
d.tieup[0][0] = d.tieup[1][0] = d.tieup[2][0] = d.tieup[3][0] = 1;
d.tieup[2][1] = d.tieup[3][1] = 1;
d.tieup[0][2] = d.tieup[1][2] = 1;
d.tieup[0][3] = d.tieup[1][3] = d.tieup[2][3] = d.tieup[3][3] = 1;
for (let p = 0; p < 6; p++) d.treadling[p][[0, 1, 2][p % 3]] = 1;
r = solveTreadle({ shafts: 4, lift: analyze(d).lift, treadles: 2, maxPress: 2,
                   currentTie: d.tieup, locked: [], keep: [], forbid: [] });
ok(r.ok, "2 踏 ≤2 有解");
eq(reproduced(d, r.candidates[0]), 0, "压缩候选精确复现");
eq(r.candidates[0].usedTreadles, 2, "使用 2 个踏板");
eq(r.candidates[0].multiPicks, 2, "两纬全综组合需同时踩 2 个踏板");
ok(r.candidates[0].totalPresses === 8, "总踩踏 8 次（全综 2 纬×2 踏 + 其余 4 纬×1 踏）");

console.log("— 踏板数少于提综组合数且 K=1：无解并指出冲突纬 —");
// 3 种不同提综组合、2 个踏板、每纬只许踩 1 个：装不下
r = solveTreadle({ shafts: 4, lift: analyze(d).lift, treadles: 2, maxPress: 1,
                   currentTie: d.tieup, locked: [], keep: [], forbid: [] });
ok(!r.ok, "无解时返回冲突");
ok(r.conflicts.some((c) => c.type === "comboUncoverable"), "comboUncoverable 类型");
ok(r.conflicts.every((c) => c.type !== "comboUncoverable" || (Array.isArray(c.picks) && c.picks.length)), "冲突项带发生冲突的纬号");

console.log("— 预检给出最少踩踏数：锁定 {3,4} 列并禁止自由列栓综 4，K=1 → 全综需 2 踏 —");
r = solveTreadle({ shafts: 4, lift: analyze(d).lift, treadles: 4, maxPress: 1,
                   currentTie: d.tieup, locked: [1],
                   forbid: [0, 2, 3].map((t) => ({ s: 3, t })), keep: [] });
ok(!r.ok, "K=1 无解");
ok(r.conflicts.some((c) => c.type === "comboUncoverable" && c.minPresses === 2), "指出全综组合至少需踩 2 个踏板");

console.log("— 禁止栓结导致无解：禁掉所有能提起综 1 的列 —");
const d4 = sampleDraft();
r = solveTreadle({ shafts: 4, lift: analyze(d4).lift, treadles: 4, maxPress: 2,
                   currentTie: d4.tieup, locked: [], keep: [],
                   forbid: [0, 1, 2, 3].map((t) => ({ s: 0, t })) });
ok(!r.ok, "整综被禁止时无解");
ok(r.conflicts.some((c) => c.type === "shaftForbidden" && c.shaft === 0), "报告综框 1 被全部禁止");

console.log("— 必须保留的栓结得到满足 —");
r = solveTreadle({ shafts: 4, lift: analyze(d4).lift, treadles: 4, maxPress: 2,
                   currentTie: d4.tieup, locked: [], keep: [{ s: 0, t: 0 }], forbid: [] });
ok(r.ok, "带保留约束有解");
eq(r.candidates[0].tieup[0][0], 1, "候选在踏板 1 保留了综 1 的栓结");

console.log("— 同格同时保留与禁止：前置冲突 —");
r = solveTreadle({ shafts: 4, lift: analyze(d4).lift, treadles: 4, maxPress: 2,
                   currentTie: d4.tieup, locked: [],
                   keep: [{ s: 2, t: 1 }], forbid: [{ s: 2, t: 1 }] });
ok(!r.ok && r.conflicts.some((c) => c.type === "cellConflict"), "cellConflict 前置报告");

console.log("— 锁定部分踏板后重新求解 —");
// 锁定 4 个踏板为现有 2/2 栓结：应直接复现
r = solveTreadle({ shafts: 4, lift: analyze(d4).lift, treadles: 4, maxPress: 2,
                   currentTie: d4.tieup, locked: [0, 1, 2, 3], keep: [], forbid: [] });
ok(r.ok, "全列锁定仍有解");
eq(reproduced(d4, r.candidates[0]), 0, "锁定方案精确复现");
eq(r.candidates[0].changeCells, 0, "全锁定时改动量为 0");

console.log("— 锁定列与禁止约束冲突 —");
// 现有栓结中踏板 1 栓了综 1 和综 2；再禁止综 1-踏 1
r = solveTreadle({ shafts: 4, lift: analyze(d4).lift, treadles: 4, maxPress: 2,
                   currentTie: d4.tieup, locked: [0], keep: [], forbid: [{ s: 0, t: 0 }] });
ok(!r.ok && r.conflicts.some((c) => c.type === "lockConstraint"), "lockConstraint 报告");

console.log("— 降综草稿：lift 取物理提起，求解器不区分升降综 —");
const dSink = sampleDraft();
dSink.shed = "sinking";
r = solveTreadle({ shafts: 4, lift: analyze(dSink).lift, treadles: 4, maxPress: 2,
                   currentTie: dSink.tieup, locked: [], keep: [], forbid: [] });
ok(r.ok && reproduced(dSink, r.candidates[0]) === 0, "降综示例同样精确复现");

console.log("— 空梭口纬保持不踩踏板 —");
d = createDraft({ ends: 8, shafts: 2, treadles: 2, picks: 4 });
for (let e = 0; e < 8; e++) d.threading[e % 2][e] = 1;
d.tieup[0][0] = 1; d.tieup[1][1] = 1;
d.treadling[0][0] = 1; d.treadling[1][1] = 1;
// 第 3 纬（下标 2）故意空梭口
d.treadling[3][0] = 1;
r = solveTreadle({ shafts: 2, lift: analyze(d).lift, treadles: 2, maxPress: 1,
                   currentTie: d.tieup, locked: [], keep: [], forbid: [] });
ok(r.ok && reproduced(d, r.candidates[0]) === 0, "含空梭口的提综精确复现");
eq(r.candidates[0].treadling[2].reduce((a, b) => a + b, 0), 0, "空梭口纬不踩任何踏板");
ok(r.stats.zeroPicks.includes(2), "stats 记录空梭口纬");

console.log("— LIFT PLAN 式导入（平纹 2 综）单踏可解 —");
d = createDraft({ ends: 8, shafts: 2, treadles: 2, picks: 4 });
for (let e = 0; e < 8; e++) d.threading[e % 2][e] = 1;
d.tieup[0][0] = 1; d.tieup[1][1] = 1;
d.treadling[0][0] = 1; d.treadling[1][1] = 1; d.treadling[2][0] = 1; d.treadling[3][1] = 1;
r = solveTreadle({ shafts: 2, lift: analyze(d).lift, treadles: 2, maxPress: 1,
                   currentTie: d.tieup, locked: [], keep: [], forbid: [] });
ok(r.ok, "平纹有解");
eq([r.candidates[0].usedTreadles, r.candidates[0].multiPicks], [2, 0], "用 2 踏、无多踏纬");
eq(reproduced(d, r.candidates[0]), 0, "平纹精确复现");

console.log("— 候选踏序每行踩踏数均不超上限 —");
d = createDraft({ ends: 8, shafts: 4, treadles: 4, picks: 6 });
for (let e = 0; e < 8; e++) d.threading[e % 4][e] = 1;
d.tieup[0][0] = d.tieup[1][0] = d.tieup[2][0] = d.tieup[3][0] = 1;
d.tieup[2][1] = d.tieup[3][1] = 1;
d.tieup[0][2] = d.tieup[1][2] = 1;
for (let p = 0; p < 6; p++) d.treadling[p][[0, 1, 2][p % 3]] = 1;
r = solveTreadle({ shafts: 4, lift: analyze(d).lift, treadles: 2, maxPress: 2,
                   currentTie: d.tieup, locked: [], keep: [], forbid: [] });
ok(r.candidates.every((c) => c.treadling.every((row) => row.reduce((a, b) => a + b, 0) <= 2)),
  "全部候选满足每纬 ≤2 踏");

console.log(fails ? `\n${fails} 项失败` : "\n全部通过");
process.exit(fails ? 1 : 0);
