# 多综织物设计台

供手工织布工作室设计多综（shaft drawloom / table loom）织物的本地 Web 应用：
穿综（threading）、栓结（tie-up）、踏序（treadling）草图编辑，实时推演
提综状态（lift plan）与组织图（drawdown），经纬色序、布面预览、用纱估算、
版本快照与并排比较、WIF 导入导出、可打印工艺单。

- 后端：Python 3 + Flask，数据存于本地 SQLite（`data/weaving.db`）
- 前端：原生 HTML / CSS / JavaScript + Canvas，无任何外部 CDN 或在线服务
- 所有织物推演与浮长计算均在浏览器本地完成

## 运行环境

- Python 3.9 及以上
- Flask（唯一运行依赖，见 `requirements.txt`）
- 现代浏览器（Chrome / Edge / Firefox / Safari）

## 启动步骤

```bash
# 1.（可选）建立虚拟环境
python3 -m venv .venv
source .venv/bin/activate

# 2. 安装依赖
pip install -r requirements.txt

# 3. 启动
python3 app.py
```

启动后终端显示：

```
多综织物设计台已启动：http://127.0.0.1:5000  （Ctrl+C 停止）
```

浏览器打开 <http://127.0.0.1:5000> 即可使用。数据库文件与 `data/` 目录会在
首次启动时自动创建；删除 `data/weaving.db` 可清空所有本机项目与版本。

> 如系统 Python 受 PEP 668 保护（Debian/Ubuntu），可用
> `pip install --user --break-system-packages -r requirements.txt`
> 或直接使用虚拟环境。

## 功能速览

- **织机参数**：经纱根数（2–120）、综框数（2–32）、踏板数（2–32）、踏序行数；
  升综（jack）/降综（sinking）逻辑一键切换。
- **草图编辑**：画笔、橡皮、框选；选区复制（可跨三个网格粘贴）、水平/垂直镜像、
  以选区为母版循环平铺、清除选区；格大小可调。
- **实时推演**：每一纬的提综状态表与组织图；第一根经纱/第一纬以红框标示。
- **检查定位**：自定经/纬浮长阈值，超限浮长在组织图描红框；标出未穿综经纱、
  未使用综框/踏板、空梭口；右侧检查列表逐项点击即滚动定位到对应格。
- **色序**：自定义调色板，经/纬色条拖涂、整排循环、反转、填色；组织图支持
  彩色/黑白切换。
- **布面预览**：按经密/纬密比例、横向纵向重复次数平铺，显示预计成品尺寸。
- **用纱估算**：成品幅宽/长度、经纬缩率、上机回丝、线密度（tex）→ 总经根数、
  投纬数、经纬纱总长、总质量及分色用量。
- **版本与比较**：项目保存于本地 SQLite；随时存版本快照（自动先提交屏幕上
  未保存的草稿），任意两版本并排显示、差异格黄底标出。
- **撤销/重做**：Ctrl+Z / Ctrl+Y（或 Ctrl+Shift+Z）；画笔拖动、色条涂色、
  参数键入均按一次操作合并。
- **WIF**：导出标准 WIF 1.1（栓结按 jack 约定书写，降综设置自动转换并保留
  `ShedType` 标记）；可导入含 `[THREADING]`/`[LIFT PLAN]` 的 WIF。
- **工艺单**：打印为 A4 横向，含穿综、栓结、踏序、组织图、经纬色序、参数、
  检查结果与用纱估算；也可在浏览器中另存为 PDF。已保存项目另有独立打印页
  `/print/<项目id>`。

## 数据与隐私

项目、版本仅写入本机 `data/weaving.db`；页面草稿另在浏览器 localStorage
中做七天内的临时恢复。没有任何外部网络请求。

## 目录结构

```
app.py                  Flask 后端（项目/版本 API、WIF 校验）
requirements.txt
data/weaving.db         首次运行自动生成
templates/index.html    主界面
templates/print.html    独立打印页
static/style.css
static/js/
  app.js                主控制器、撤销重做、项目/版本
  model.js              草稿模型、示例
  weave.js              提综/组织图/浮长推演与检查
  grids.js              Canvas 二进制网格与色条组件
  preview.js            布面预览与用纱估算
  wif.js                WIF 导入导出
  compare.js            版本并排差异
  printsheet.js         可打印工艺单
  api.js / utils.js
```
