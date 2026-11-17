# 专业模型目录与发布

## 在工作台操作

先在服务端设置 `GEOCSV_MODEL_ADMIN_TOKEN`，再启动工作台。Docker Compose 从启动环境读取这个值。管理员在「专业模型 → 发布管理」输入密钥。普通用户可以在「模型目录」使用已发布的版本。

1. 选择「新建模型」，填写名称和说明，选用 **Moran/LISA 空间自相关 · v2**。分别配置 Queen（共边或共点）和 Rook（仅共边），可以指定置换次数和随机种子。
2. 保存草稿，在「试跑与发布」选择当前场景的面图层和数值字段。可选区域名称字段，用于结果地图和表格里的名称显示。
3. 试跑成功后可以先查看结果，再回到发布管理发布。若草稿有保存后产生的新修订，需在该修订上重新试跑。
4. 在「模型目录」选择已发布的模型、图层和字段，然后运行。目录显示每个模型最新的已发布版本及固定参数。「运行历史」可重新打开当前场景的试跑和正式结果。
5. 修改已发布模型时，先点「创建下一版本草稿」。新版本发布前，目录继续提供上一版。旧任务保留当时的模型版本、算子版本、实际参数和归档结果。

## 代码分工

- [模型表单](../../client/src/features/analysis/components/ProfessionalModelForms.tsx)按算子声明生成邻接规则、置换次数、随机种子和数据字段控件，字段从当前场景的图层读取。
- [专业模型目录](../../server/src/modules/professionalModels/catalog.ts)持久化名称、说明、参数和绑定的算子版本。每次保存产生草稿修订号。发布时用一条数据库更新核对当前修订，并关联该修订成功且已归档的试跑。
- [专业模型接口](../../server/src/modules/professionalModels/router.ts)只允许从具备专业模型输入定义的已注册算子创建配置，管理和试跑操作验证服务端密钥。请求只能提供图层和字段，正式运行按发布版本读取有效参数。
- [统一分析服务](../../server/src/modules/analysis/service.ts)校验场景归属，保存 Plan 和输入快照，并为 Run 记录模型与算子版本。Worker 使用既有 Moran/LISA 实现，Artifact 继续供地图、表格和 CSV 读取。

NeoGIS 的前端将名称、描述、参数 Schema 和固定运行修订一起提交，后端在发布时绑定可信入口和版本。GeoCSV 沿用这些边界，用本机已部署的算子注册表提供执行入口。 [NeoGIS 前端发布参数](https://github.com/GeoScenarioScripter/NeoGIS-Frontend/blob/1920529834d1afe153467c1df7ce410c9f7a5825/src/features/gis/lib/code-tool-publish.ts) · [NeoGIS 后端发布契约](https://github.com/GeoScenarioScripter/neogis-server-micro-service/blob/4635f5182d7c254b3b3283e7d789de1e44c7493e/docs/design/codeenv-tool-projects/contracts.md)

## 四面样例

取四个单位正方形的左下角坐标 `(0,0)`、`(1,0)`、`(2,1)`、`(10,0)`，分别命名 A、B、C、D，给 `value` 字段填入 `1, 3, 5, 7`。A、B 共边，B、C 只共点，D 孤立。

在独立的 Docker 工作台上重现时，将 `GEOCSV_TEST_API` 指向其本地 `/api`，使用该实例的管理密钥执行 `node server/tests/professionalModelsDocker.cjs`。测试会上传四面样例，核对不同预设的 Plan、Run、Artifact、失败发布、修改后重新试跑、任务重试、跨场景限制和旧版历史。

## 验收记录

2026-11-17 在独立实例 `http://127.0.0.1:18085/` 的「浏览器四面验收 53690」场景，通过 Chrome 完成两次表单配置、试跑、发布和目录运行。刷新页面后从「运行历史」重新打开两个正式结果，核对地图、四行区域明细和 CSV 导出入口。

| 目录预设 | 全局 Moran’s I | 正式 Run | Artifact |
| --- | ---: | --- | --- |
| Moran/LISA Queen 53690 · v1 | 0.2 | `15e55761-f7e0-4039-a2cb-1ba813b2dac2` | `494d7d85-6efc-41db-96b3-d96a916fe26c` |
| Moran/LISA Rook 53690 · v1 | 0.6 | `41038c01-aa19-4000-8e9b-edeadde076d3` | `a00ada45-00d2-4863-b008-9fd1afc75607` |

真实 PostGIS 迁移、空间透视和场景资源集成测试 5 项通过。服务端单元测试 23 项、前端任务历史和流解析测试 9 项通过。后续工作为结果体验与 deck.gl 试点。
