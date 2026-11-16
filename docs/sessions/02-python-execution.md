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

## 统一执行

`spatial_autocorrelation@2` 与 `spatial_pivot@1` 共用 `POST /api/analysis/plans`、带 `Idempotency-Key` 的 `POST /api/runs`、状态查询和历史。`MoranLisaSpec` 把目标图层、数值字段、Queen/Rook、置换次数与种子作为有效参数写入 Plan、Run 和 Artifact。计数页面按算子筛选历史，原专业模型 HTTP 路由继续提供旧结果语义。

确认时，Node 在同一事务内核对 Plan 中的输入版本、保存快照和创建 Run。快照只包含按 ID 排列的原始字段值、面 WKB 与 CRS。快照实际字节的 SHA-256 写入 `inputVersions.target.fingerprint`，也是 Artifact 的 `inputDigest`。分析使用 EPSG:4326 的已存几何，首次部署的提交上限是 20,000 个要素和 64 MiB 快照，置换范围 0–9999。保留期七天，重放重用同一快照。超过保留期返回 HTTP 410 `INPUT_SNAPSHOT_EXPIRED`，既有 Artifact 仍可读取。

Node 抢占任务后使用 Run ID 作为稳定执行 ID，向本地 Python 子进程发送快照。计算阶段仅持有调度连接上的会话锁，没有未提交的数据库事务。Python 在原子发布结果前校验输入摘要，Node 校验执行 ID、输入摘要、算法版本、锁文件摘要、有效参数和行 ID，再在短事务内写 Artifact 和终态。Artifact 的 `moran_lisa` v1 支持分页、快照几何预览、CSV，p 值与象限按实际结果提供 `null`。

默认子进程时限为 120 秒。超时进入 `failed/EXECUTION_TIMEOUT`，子进程异常退出进入 `failed/WORKER_INTERRUPTED`。取消先写终态，再停止本机子进程。若取消先提交，已发布的迟到结果也无法归档。Node 退出前停止领取，子进程通过管道感知父进程退出。重启后先恢复 `running` 的 Python Run，复用本机已发布的结果，或用同一快照重新计算。Artifact 的 Run 唯一约束与事务提交确保每个 Run 仅归档一次。

首版调度在同一数据库串行处理任务。运行中占用一个池连接。跨主机共享文件、主机掉电恢复和高并发调度未在本轮验收。跨进程重启需保留私有 `ANALYSIS_WORKER_DIR`，默认使用本工作树 `python_engine/.tmp/analysis-worker`。默认读取 `python_engine/.venv`，可用 `ANALYSIS_PYTHON` 指定已按所在工作树的锁文件同步的解释器。

### 阶段 5 接线条件

- `GET /api/operators` 提供可信入口 `spatial_autocorrelation@2`、目标面类型、`parameterSchema` 引用和输出版本。`GET /api/datasets?ids=...` 提供图层几何类型与字段。仓库的协议 JSON Schema 已给出控件标题、默认值、范围和 Queen/Rook 选项；阶段 5 需将 Schema 随客户端打包或提供运行时读取入口。
- Queen 和 Rook 可复用同一 `MoranLisaSpec`，分别固定 `contiguity=queen` 与 `contiguity=rook`，由相同 Plan/Run/Artifact 接口试跑。全局和局部类型及示例见 [共享协议](../analysis-protocol.md)。
- 阶段 5 负责目录、预设与发布版本持久化、试跑绑定、发布权限及专用结果界面。当前可从 Artifact 核对实际算子版本与有效参数，预设发布版本的绑定还需新增字段。阶段 5 的局部显著性展示需明确校正规则。

### 验收证据

Windows Node 24、CPython 3.12.13 和 WSL 的 PostgreSQL 16／PostGIS 3.5 上，`npm run test:integration` 8 项通过，0 跳过。样例目标为同一图层的 A、B、C、D 四个面，两个预设的输入摘要均为 `5c8f78c38e76261ea5ba14a06fb472953c085d9298a0a7aa74ebaff6ed9ea231`。

| 项目 | Run ID | Artifact ID | 结果 |
| --- | --- | --- | --- |
| Queen，4 次置换 | `b69fc273-9362-4ab1-9806-7cb272a2d6fa` | `ab0da34c-6662-4d37-a5ee-348f5478a4e3` | `I=0.2`，全局 `p=0.4`，局部 p 值 `[0.8,0.8,1,null]` |
| Rook，禁用置换 | `b58fc9c5-7dff-43c3-865b-8041de70876e` | `c787c2ea-6fa7-45ad-98c7-634829ab9df2` | `I=0.6`，局部邻居数 `[1,1,0,0]`，p 值为空 |
| 归档前杀停 Node 并重启 | `eeb10566-bf24-47d0-901b-42db28631ae2` | `0a8aa9f1-29a5-4856-be07-dfc59d37bca2` | 重启实例的 Python 路径设为不可用，读取已完成的 Worker 文件并归档一次 |
| 子进程超时 | `1da27041-6e02-49b4-9bd3-bbfccf1210e7` | — | `failed/EXECUTION_TIMEOUT` |
| 结果发布后、归档前取消 | `be6135b4-1b82-4b38-ab12-38b3a58c8de3` | — | `cancelled`，已发布结果已清理 |

另用正式 `dist/index.js` 入口和 Python 示例客户端运行 Queen。客户端短超时后使用相同的计划和请求键重试，库中只创建一个 Run `5b26d209-2b06-4f6b-a5eb-04fbaaccc321`，由 Artifact `ee6c77ff-1e95-4208-aca2-3e93096fa582` 返回 `I=0.2` 和四行结果。Worker 运行时 `/api/health` 在一秒内返回 200。各轮均清理独立测试 schema。

### PostGIS 复现

使用 [环境基线](../environment-baseline.md) 的独立测试数据库。测试自行创建临时 schema 和四面样例，验收完成后清理；Run/Artifact ID 留在测试输出。

```powershell
uv sync --project python_engine --frozen
Push-Location server
npm ci
npm run build
node -r ts-node/register --test --test-concurrency=1 tests/*.integration.cjs
Pop-Location
```

`TEST_DATABASE_URL` 应指向已启用 PostGIS 的专用测试数据库。对已在运行的隔离服务，可用 `python python_engine/examples/run_moran.py four-faces value --contiguity queen --simulate-timeout` 提交并读取结果。请求等待超时只表示客户端未收到响应，示例用同一计划与请求键重试。收到 Run 后，计算失败通过 `status` 和 `errorCode` 表示。

## Docker 验收

2026-11-16，Docker Engine 29.6.1、Compose 5.2.0。新建项目 `geocsv-moran-check`，仅通过 `127.0.0.1:8082` 暴露 Nginx。四个容器健康。`server` 与 `python` 中均为 CPython 3.12.13，`uv.lock` 文件摘要相同。实测 `server` 进程用户 UID 为 1000、结果卷权限为 `0700`、PID 1 为 `docker-init`，`python` 服务没有挂载结果卷。

四面 GeoJSON 通过场景上传接口进入独立数据库，目标字段 `value` 的值为 `[1,3,5,7]`。Queen 和 Rook 两次请求使用同一输入摘要 `5c8f78c38e76261ea5ba14a06fb472953c085d9298a0a7aa74ebaff6ed9ea231`，算子为 `spatial_autocorrelation@2`，实现为 `moran-lisa/2.0.0`。相同确认请求与幂等键各返回原 Run。独立的 FastAPI 兼容端点也以同一图层返回 200、全局 I `0.2` 和四行。

| 验收 | Run ID | Artifact ID | 实际结果 |
| --- | --- | --- | --- |
| Queen，种子 42，4 次置换 | `522c4386-b019-4b9d-b643-e7a9896505ec` | `c41f549c-f12d-43ab-8885-dd06822cf0ff` | 全局 I `0.2`，p `0.4`，邻居数 `[1,2,1,0]`，局部 p `[0.8,0.8,1,null]` |
| Rook，种子 42，禁用置换 | `64efb2a9-3e83-46b2-bdbf-e06ae92958aa` | `323d24a5-71e2-483d-9bc0-b094c6af6d00` | 全局 I `0.6`，邻居数 `[1,1,0,0]`，p 值为空 |
| 空间计数，排除边界 | `1098feff-ff65-4951-9b9f-5d0d7c208a49` | `c23847ad-4282-4f01-b7fc-1ea866aca1f6` | 逐面计数 `[2,1,0,0]` |
| Queen 归档故障恢复 | `7bfe37cb-8d8f-41be-8ce3-896e2555594d` | `cad699b6-4abe-417d-ae66-a695125e08a5` | 同一 Run 的唯一 Artifact，全局 I `0.2` |

故障注入在独立库锁住 Artifact 表，确认 Worker 结果文件已经原子发布且 Node 正等待归档，再强制终止 `server`。释放测试锁后，把重建实例的 `ANALYSIS_PYTHON` 暂时设为不可执行路径。调度器从持久卷读取结果，将同一 Run 归档一次，卷内测试标记也跨重建保留。恢复正常启动配置并重建容器后，用新 HTTP 连接复读成功，原有历史、四行结果、GeoJSON 和 CSV 均与重建前一致。

复跑正常链路与容器重建验证见 [Docker 验收命令](../docker-local.md#moranlisa-的独立-compose-验收)。
