# 02 Python 执行 · Moran/LISA 离线算法验收

日期 2026-11-16。分支 `codex/02-python-execution`，基线 `4c56763f98b6e140ecb09dfd9707bb8d9dc1c98a`。

## 算子与输入规则

[`compute_moran_lisa`](../../python_engine/operators/spatial_autocorrelation.py) 接收已物化的 `GeoDataFrame` 和目标字段，返回 `moran-lisa/2.0.0`、有效参数、全局统计和按要素 ID 对齐的局部结果。当前 REST 路由继续运行 [旧版基线](01-python-baseline.md) 的实现。

| 维度 | `moran-lisa/2.0.0` |
| --- | --- |
| 标识与顺序 | `id` 是唯一、非空的字符串，按字符串字典序排列。GeoDataFrame 索引及读取顺序不参与计算。 |
| 数值 | 转成 `float64`。保留实数及可解析的数字字符串，排除缺失、布尔、复数、非法值和正负无穷，返回 `excluded_value_ids` 并基于剩余要素建权重。至少需要三条有限数值且字段有离散性。 |
| 几何与 CRS | 要求声明二维地理或投影 CRS，使用输入平面的二维坐标直接判定拓扑。快照中的几何必须是有效、非空、坐标有限的 Polygon 或 MultiPolygon。跨日期变更线的几何由上游按分析范围处理。 |
| 邻接 | `queen` 要求内部互不相交且边界接触。`rook` 另要求共享边界的长度大于零。顶点落在另一面的边段上属于 Queen，未按相同顶点切分的共享线段仍可属于 Rook。重叠和包含的面之间无边，配对无自环。 |
| 权重和孤岛 | 每行的每条边使用 `1 / 邻居数`，孤岛行全零。部分孤岛参与均值、方差及置换候选，局部 I、期望和滞后为 0，p 值和象限为 `null`。全孤岛、常量、缺失 CRS、无效几何及有效样本不足以 `ValueError` 表示。 |
| 推断与展示 | 默认 199 次置换，种子 42，使用两个独立的 NumPy PCG64 随机数流。`permutations=0` 时 p 值为 `null`。局部 p 值未做多重检验校正。象限由标准化值与滞后的符号确定，任一为零时为空。象限可和原始 p 值一起展示，显著性或热点分类须先约定校正规则。 |

设 `z` 为以总体标准差标准化的值，`D = Σ zᵢ²`，`S0` 为全部权重的和。全局统计为 `(n/S0) × zᵀWz / D`，局部统计为 `(n−1) × zᵢ(Wz)ᵢ / D`。全局在全部要素间打乱值，零假设期望为 `−1/(n−1)`。局部固定焦点和权重行，在其他 `n−1` 个位置中无放回抽满该行邻居数。同行抽样不重复位置，同轮的不同行共享候选秩，映射时跳过各自焦点位置。每个局部边际抽样均匀。

非孤岛行的条件滞后均值为 `−zᵢ/(n−1)`，故局部 I 的条件期望为 `−zᵢ²/D`。全局和局部均以距各自零假设期望的绝对距离为检验量。计入距离并列，比较容差为 `rtol=1e-12, atol=1e-15`。Monte Carlo p 值为 `(极端次数 + 1)/(置换次数 + 1)`。

## 四面样例手算

沿用旧基线形状和数值 `[1,3,5,7]`。Queen 的非零边为 `A→B=1`、`B→A=1/2`、`B→C=1/2`、`C→B=1`。D 为孤岛。用中心化值 `[-3,-1,1,3]` 代替 `z` 时，分母为 20、滞后为 `[-1,-1,-1,0]`、`S0=3`，全局 I 为 `1/5`，局部 I 为 `[9/20,3/20,−3/20,0]`。Rook 仅保留 A 与 B 的双向边，`S0=2`，全局 I 为 `3/5`，局部 I 为 `[9/20,9/20,0,0]`。

Queen 下全局置换的公式为 `b(a+c)/10`。24 个分配得到 `−6/5、−3/5、−2/5、0、1/5`，频数分别为 `4、4、4、8、4`。围绕 `−1/3` 的极端值为 `−6/5` 和 `1/5`，精确概率为 `1/3`。固定焦点后，A 的局部候选 I 为 `9/20、−9/20、−27/20`，B 的候选为 `3/20、0、−3/10`，C 的候选为 `−9/20、−3/20、9/20`。每个取值等概率。局部期望依次为 `−9/20、−1/20、−1/20`，尾概率为 `2/3、2/3、1`。

种子 42 的前四次抽样给出全局 I `[-6/5,0,−3/5,−2/5]`。相同四轮局部条件置换的 I 为 A `[-9,9,9,9]/20`、B `[3,3,0,3]/20`、C `[-3,-9,-9,-9]/20`。全局、A、B、C 的极端次数为 `1、3、3、4`，加一后分别得到 `2/5、4/5、4/5、1`。

## PySAL 选型与实测

锁定 `esda==2.9.0` 和 `libpysal==4.14.1`。前者有版本化的局部统计 API 和可检查的置换源码，后者提供本批需要的 Queen/Rook 和行标准化 `W`。这两版已在 Windows CPython 3.12.13 上实际验证，底层 GeoPandas、NumPy、pandas、pyproj 和 Shapely 与服务锁文件同版。独立审计环境执行单进程的 esda Python 路径，未安装可选 Numba。结论适用于本次锁定环境。

四面样例的两种权重、观测 I、z 及滞后均与 PySAL 对齐，浮点绝对容差 `1e-12`。另一个样例中，libpysal 以坐标相同的边界顶点或完整边段匹配邻居，漏掉未切分的共享线段和落在边上的顶点，并把一对具有同坐标边段的包含面连起来。新版使用 Shapely 边界拓扑保留前两种接触，排除内部相交的配对。 [libpysal 4.14.1 邻接源码](https://github.com/pysal/libpysal/blob/v4.14.1/libpysal/weights/_contW_lists.py#L66-L120)

下表为 Queen 样例、4095 次置换、种子 42。复算列对 esda 的 `sim` 样本按同一中心、双尾及并列规则计数。固定版本下，新版与 esda 的随机引擎不同，置换流分别复现。测试核对 esda 模拟值的完整取值集合、各取值频率及两组 p 值，各概率绝对容差为 0.035。

| 检验 | 精确尾概率 | 新版 p | esda 样本复算 p | esda 原生 `p_sim` |
| --- | ---: | ---: | ---: | ---: |
| 全局 | 0.333333 | 0.335938 | 0.332031 | 0.159668 |
| A | 0.666667 | 0.675537 | 0.662109 | 0.335449 |
| B | 0.666667 | 0.667969 | 0.663574 | 0.332764 |
| C | 1 | 1 | 1 | 0.335449 |
| D 孤岛 | — | `null` | — | 0.000244 |

esda 2.9 的 `p_sim` 比较不小于观测值的一侧和严格小于观测值的一侧，取较小计数并加一。`Moran.two_tailed` 影响正态和随机化的解析 p 值。孤岛的模拟值全部为 0，因此按该原生计数得到 `1/4096`。局部 `EIc` 使用了总体二阶矩的 `n` 归一化，在本样例返回 `[-0.6,−1/15,−1/15,0]`。同一库的 `Is` 与置换样本使用 `n−1` 归一化，该分布的确切均值由上面的穷举得到。 [esda 2.9 统计与尾部源码](https://pysal.org/esda/v2.9.0/_modules/esda/moran.html) · [局部 API](https://pysal.org/esda/v2.9.0/source/generated/esda.Moran_Local.html) · [条件置换源码](https://github.com/pysal/esda/blob/v2.9.0/esda/crand.py)

选用现有 GeoPandas/Shapely 构建拓扑边，使用 NumPy 计算统计及置换，将 PySAL 保留为独立验收环境的参考实现。旧版与新版在相同有效权重上全局 I 一致。旧局部 I 使用 `n`，新版乘 `n−1`，因此四面样例结果缩为旧值的 `3/4`。旧版按距零计尾并置换整列来构造局部滞后，新版的零假设中心及局部候选均有调整。旧版会为缺失 CRS 填入 EPSG:4326、尝试修补无效面，并为禁用置换或部分孤岛给出 p=1。历史结果按旧来源解释。

## 复现

从本阶段工作树根目录运行。首次同步需要包缓存或网络。测试数据由本地坐标构造，PySAL 对照禁止打开网络连接。旧路由测试直接调用处理函数并替换数据库读取。

```powershell
$env:UV_CACHE_DIR = Join-Path $PWD 'python_engine/__pycache__/uv-cache'
uv sync --project python_engine --frozen --no-python-downloads --link-mode copy
uv sync --project python_engine/audits/spatial_autocorrelation --frozen --no-python-downloads --link-mode copy
uv lock --project python_engine --check --offline
uv lock --project python_engine/audits/spatial_autocorrelation --check --offline
Push-Location python_engine
uv run --frozen --offline python -m unittest discover -s tests -v
uv run --project audits/spatial_autocorrelation --frozen --offline python -m unittest discover -s audits/spatial_autocorrelation -v
Pop-Location
```

## Worker 接入条件

阶段 1 契约验收后，由 Worker 适配器读取不可变快照，按其要素 ID、字段和 CRS 组装输入。Run/Artifact 需保存快照摘要、算法版本、有效参数、依赖锁摘要、清洗记录及推断规则。先确认 `null` p 值、局部象限、浮点字段和几何如何映射到实际 Artifact，再联调两类算子共用接口。需在独立进程容量验证中确定置换上限、超时和取消策略，随后验收稳定执行 ID、迟到返回、恢复回收及幂等归档。
