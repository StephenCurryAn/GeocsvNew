import { Request, Response } from 'express';
import Feature from '../models/Feature';
import ModelRegistry from '../models/ModelRegistry';
import { generateModelCodeFromAI } from '../utils/llmService';
import mongoose from 'mongoose';
import * as turf from '@turf/turf';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

// WSL2 中 FastAPI 运行的地址
const PYTHON_API_URL = 'http://127.0.0.1:8000/api';
// 更新后的 Python API 返回结构 (API 契约)
interface PythonApiResponse {
  status: string;
  result_col_names: string[];
  result_data: Array<any>; // 明确告诉 TS 这是一个包含 id 和 score 的对象数组
  execution_time_ms: number;
}

// 简易空间索引
class SimpleGridIndex {
    private buckets: Map<string, any[]> = new Map();
    private cellSize: number;

    constructor(bbox: number[], resolution: number = 20) { // 稍微调大 resolution 提高精度
        const width = bbox[2] - bbox[0];
        const height = bbox[3] - bbox[1];
        this.cellSize = Math.max(width, height) / resolution;
    }

    insert(item: any) {
        const bbox = turf.bbox(item);
        const minX = Math.floor(bbox[0] / this.cellSize);
        const maxX = Math.floor(bbox[2] / this.cellSize);
        const minY = Math.floor(bbox[1] / this.cellSize);
        const maxY = Math.floor(bbox[3] / this.cellSize);

        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                const key = `${x},${y}`;
                if (!this.buckets.has(key)) this.buckets.set(key, []);
                this.buckets.get(key)!.push(item);
            }
        }
    }

    query(feature: any): any[] {
        const bbox = turf.bbox(feature);
        return this.queryByBbox(bbox);
    }

    //   [新增] 支持直接通过 bbox 查询，方便做邻域搜索
    queryByBbox(bbox: number[]): any[] {
        const candidates = new Set<any>();
        const minX = Math.floor(bbox[0] / this.cellSize);
        const maxX = Math.floor(bbox[2] / this.cellSize);
        const minY = Math.floor(bbox[1] / this.cellSize);
        const maxY = Math.floor(bbox[3] / this.cellSize);

        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                const key = `${x},${y}`;
                const items = this.buckets.get(key);
                if (items) items.forEach(item => candidates.add(item));
            }
        }
        return Array.from(candidates);
    }
}

function safeIntersect(poly1: any, poly2: any): any {
    try {
        // @ts-ignore
        let intersection = turf.intersect(poly1, poly2);
        if (!intersection) {
             // @ts-ignore
             intersection = turf.intersect(turf.featureCollection([poly1, poly2]));
        }
        return intersection;
    } catch (e) {
        try {
            // @ts-ignore
            return turf.intersect(turf.featureCollection([poly1, poly2]));
        } catch (e2) {
            return null;
        }
    }
}

export const pivotAnalysis = async (req: Request, res: Response) => {
    try {
        const { 
            fileId, 
            groupByRow,   // 行分组 (必填) e.g. "properties.District"
            groupByCol,   // 列分组 (选填) e.g. "properties.Year"
            valueField,   // 统计值 (必填) e.g. "properties.Rainfall"
            method        // "sum", "avg", "max", "min", "count"
        } = req.body;

        if (!fileId || !groupByRow) {
            return res.status(400).json({ message:'缺少参数' });
        }

        // 构建MongoDB聚合累加器
        let accumulator: any = {};
        if (method === 'count') {
            accumulator = { $sum: 1 };
        } else {
            // 前端传来的只是字段名 "Rainfall"，Mongo需要 "$properties.Rainfall"
            // 如果前端没传 properties. 前缀，加上
            const vField = valueField.startsWith('properties.') ? valueField : `properties.${valueField}`;
            const fieldPath = `$${vField}`;
            
            switch (method) {
                case 'sum': accumulator = { $sum: fieldPath }; break;
                case 'avg': accumulator = { $avg: fieldPath }; break;
                case 'max': accumulator = { $max: fieldPath }; break;
                case 'min': accumulator = { $min: fieldPath }; break;
                // 使用$push把同一分组下的所有原始数据塞进一个数组里返回
                case 'boxplot': accumulator = { $push: fieldPath }; break;
                case 'ridgeline': accumulator = { $push: fieldPath }; break;
                default: accumulator = { $sum: fieldPath };
            }
        }

        const rField = groupByRow.startsWith('properties.') ? groupByRow : `properties.${groupByRow}`;
        const cField = groupByCol && !groupByCol.startsWith('properties.') ? `properties.${groupByCol}` : groupByCol;

        // 文件ID过滤条件
        const pipeline: any[] = [
            { $match: { fileId: new mongoose.Types.ObjectId(fileId) } }
        ];

        // 区分一维还是二维分析
        if (!cField) {
            // 一维分组
            pipeline.push({
                $group: {
                    _id: `$${rField}`,
                    value: accumulator
                }
            });
            pipeline.push({ $sort: { value: -1 } }); // 默认降序
        } else {
            // 二维透视

            if (method === 'boxplot' || method === 'ridgeline') {
                return res.status(400).json({ message: '二维模式不支持 raw array 聚合' });
            }
            
            // 按行列分组计算统计值
            pipeline.push({
                $group: {
                    _id: {
                        row: `$${rField}`,
                        col: `$${cField}`
                    },
                    val: accumulator
                }

            });
        }
        // 示例的格式：
        //         [
        //   { 
        //     "_id": { "row": "南京", "col": "2020" }, 
        //     "val": 30   // (10 + 20)
        //   },
        //   { 
        //     "_id": { "row": "南京", "col": "2021" }, 
        //     "val": 50 
        //   },
        //   { 
        //     "_id": { "row": "苏州", "col": "2020" }, 
        //     "val": 30 
        //   }
        // ]
        const rawResults = await Feature.aggregate(pipeline);

        // 数据格式化（转成echarts格式）
        let finalData: any[] = [];
        let dynamicColumns: string[] = [];

        if (!cField) {
            // 一维格式化
            finalData = rawResults.map((item, idx) => ({
                key: idx,
                rowKey: (item._id === null || item._id === undefined || item._id === '') ? '未分类' : item._id,
                // 要是是boxplot和ridgeline，则返回数组
                value: (method === 'boxplot' || method === 'ridgeline')
                    ? item.value 
                    : (typeof item.value === 'number' ? parseFloat(item.value.toFixed(2)) : item.value)
            }));
            // 标记列类型
            if (method === 'boxplot') dynamicColumns = ['boxplot_raw'];
            else if (method === 'ridgeline') dynamicColumns = ['ridgeline_raw'];
            else dynamicColumns = ['value'];
        } else {
            // 二维格式化(Matrix转置)
            const map = new Map<string, any>();
            const colSet = new Set<string>();

            rawResults.forEach(item => {
                const rKey = (item._id.row === null || item._id.row === undefined || item._id.row === '') ? '未分类' : item._id.row;
                const cKey = String(item._id.col || '未分类'); // 列名必须是字符串
                const val = typeof item.val === 'number' ? parseFloat(item.val.toFixed(2)) : item.val;

                // 把所有列名自动去重，做表头
                colSet.add(cKey);

                // 行列交叉值的存储
                if (!map.has(rKey)) {
                    map.set(rKey, { key: rKey, rowKey: rKey });
                }
                const rowObj = map.get(rKey);
                rowObj[cKey] = val; // { rowKey: '南京', '2020': 100, '2021': 200 }
            });

            dynamicColumns = Array.from(colSet).sort(); // 列排序

            // 最终数据格式 [ { rowKey: '南京', '2020': 100, '2021': 200 }, { rowKey: '苏州', '2020': 150, '2021': 120 } ]
            finalData = Array.from(map.values());
        }

        res.json({
            success: true,
            data: finalData,
            columns: dynamicColumns,
            meta: { groupByRow, groupByCol, valueField, method }
        });

    } catch (error) {
        console.error('Pivot error:', error);
        res.status(500).json({ message: 'Analysis failed' });
    }
};

export const generateGrid = async (req: Request, res: Response): Promise<void> => {
    try {
        const { fileId, shape, size, method, targetField } = req.body;

        if (!fileId || !shape || !size) {
            res.status(400).json({ error: 'Missing required parameters' });
            return;
        }
        
        //   [配置] 定义缓冲区圈数 n (可在此处修改，或从前端传入)
        const BUFFER_RINGS = 2; // 显示周围 2 圈网格

        console.log(`[Grid] Generating ${shape} grid (${size}km) for file ${fileId}`);
        
        const rawFeatures = await Feature.find({ fileId }).lean();
        if (!rawFeatures || rawFeatures.length === 0) {
                res.status(404).json({ error: 'No features found' });
                return;
        }

        const features = rawFeatures.map((f: any) => turf.feature(f.geometry, f.properties));
        
        //   [新增] 预判数据类型，用于覆盖率计算
        const firstGeom = features[0]?.geometry.type;
        const isPolygonLayer = firstGeom?.includes('Polygon');
        const isLineLayer = firstGeom?.includes('Line');
        
        const featureCollection = turf.featureCollection(features);
        const bbox = turf.bbox(featureCollection);
        
        // 2. 生成网格
        const options: any = { units: 'kilometers' };
        let grid: any;
        try {
            if (shape === 'hex') {
                grid = turf.hexGrid(bbox, size, options);
            } else {
                grid = turf.squareGrid(bbox, size, options);
            }
        } catch (e) {
            res.status(500).json({ error: 'Grid generation error' });
            return;
        }

        // 初始化属性，并给每个网格打上唯一 ID 方便索引
        grid.features.forEach((cell: any, index: number) => {
            cell.properties = { 
                value: 0, 
                count: 0,
                _id: index // 内部临时 ID
            };
        });

        // 3. 建立索引
        const gridIndex = new SimpleGridIndex(bbox, 25);
        grid.features.forEach((cell: any) => gridIndex.insert(cell));

        // 4. 聚合计算
        // 记录所有“活跃”网格的 ID (即与数据相交的网格)
        const activeCellIds = new Set<number>();

        let processedCount = 0;
        let intersectCount = 0;

        features.forEach((feature: any) => {
            const geometryType = feature.geometry.type;
            let rawValue = 1;
            
            //   [修改] 确定 rawValue (根据模式)
            if (method === 'coverage') {
                // 覆盖率模式：计算几何体自身的绝对量（面积或长度）
                if (isPolygonLayer) {
                    // 面：使用平方米
                    rawValue = turf.area(feature); 
                } else if (isLineLayer) {
                    // 线：使用千米
                    rawValue = turf.length(feature, { units: 'kilometers' });
                } else {
                    // 点数据不支持覆盖率，忽略
                    return; 
                }
            } else if (method !== 'count' && targetField) {
                // 属性聚合模式
                const val = Number(feature.properties[targetField]);
                if (isNaN(val)) return;
                rawValue = val;
            }
            // 计数模式 rawValue 默认为 1

            const candidateCells = gridIndex.query(feature);
            
            candidateCells.forEach((cell: any) => {
                let ratio = 0;
                try {
                    // A. 点数据
                    if (geometryType === 'Point') {
                        if (turf.booleanPointInPolygon(feature, cell)) ratio = 1;
                    } 
                    // B. 线数据
                    else if (geometryType === 'LineString' || geometryType === 'MultiLineString') {
                        if (!turf.booleanIntersects(cell, feature)) return;
                        const totalLen = turf.length(feature);
                        if (totalLen === 0) return;

                        if (turf.booleanContains(cell, feature)) {
                            ratio = 1;
                        } else {
                            const cellBoundary = turf.polygonToLine(cell);
                            // @ts-ignore
                            const splitLines = turf.lineSplit(feature, cellBoundary);
                            let insideLen = 0;
                            splitLines.features.forEach((seg: any) => {
                                const len = turf.length(seg);
                                if (len > 0) {
                                    const mid = turf.along(seg, len / 2);
                                    if (turf.booleanPointInPolygon(mid, cell)) insideLen += len;
                                }
                            });
                            if (splitLines.features.length === 0) {
                                    const mid = turf.along(feature, totalLen / 2);
                                    if (turf.booleanPointInPolygon(mid, cell)) ratio = 1;
                            } else {
                                    ratio = insideLen / totalLen;
                            }
                        }
                    } 
                    // C. 面数据
                    else if (geometryType === 'Polygon' || geometryType === 'MultiPolygon') {
                        if (!turf.booleanIntersects(cell, feature)) return;
                        if (turf.booleanContains(cell, feature)) {
                            ratio = 1; 
                        } else if (turf.booleanContains(feature, cell)) {
                            const cellArea = turf.area(cell);
                            const featArea = turf.area(feature);
                            if (featArea > 0) ratio = cellArea / featArea;
                        } else {
                            const intersection = safeIntersect(cell, feature);
                            if (intersection) {
                                const totalArea = turf.area(feature);
                                const partArea = turf.area(intersection);
                                if (totalArea > 0) ratio = partArea / totalArea;
                            }
                        }
                    }

                    if (ratio > 0) {
                        cell.properties.value += rawValue * ratio;
                        cell.properties.count += 1;
                        intersectCount++;
                        //   [标记] 该网格是活跃的
                        activeCellIds.add(cell.properties._id);
                    }
                } catch (err) {}
            });
            processedCount++;
        });

        console.log(`[Grid] Processed ${processedCount} features. Active cells: ${activeCellIds.size}`);

        //   [新增] 覆盖率模式的后处理：除以网格面积
        if (method === 'coverage') {
            grid.features.forEach((cell: any) => {
                if (activeCellIds.has(cell.properties._id)) {
                    const cellAreaSqM = turf.area(cell); // 网格面积 (m²)
                    
                    if (isPolygonLayer) {
                        // 面覆盖率 = (网格内建筑总面积 m²) / (网格面积 m²)
                        // 结果范围 0.0 - 1.0
                        cell.properties.value = cell.properties.value / cellAreaSqM;
                        // 修正可能的浮点误差，最大不超过 1
                        if (cell.properties.value > 1) cell.properties.value = 1;
                    } else if (isLineLayer) {
                        // 线密度 = (网格内道路总长 km) / (网格面积 km²)
                        // 结果单位：km/km²
                        const cellAreaSqKm = cellAreaSqM / 1_000_000;
                        if (cellAreaSqKm > 0) {
                            cell.properties.value = cell.properties.value / cellAreaSqKm;
                        }
                    }
                }
            });
        }

        // 5. 修约数值
        grid.features.forEach((cell: any) => {
            // 覆盖率通常保留更多小数位
            const decimals = method === 'coverage' ? 4 : 2;
            cell.properties.value = Number(cell.properties.value.toFixed(decimals));
        });

        //   [新增] 缓冲区过滤逻辑
        // 无论点、线、面，都执行这个通用的视觉优化
        if (activeCellIds.size > 0) {
            const cellsToKeep = new Set<number>(activeCellIds);
            
            // 将所有活跃网格对象找出来
            const activeCells = grid.features.filter((f: any) => activeCellIds.has(f.properties._id));
            
            // 计算缓冲区半径 (km)
            // 假设 size 是半径或边长，我们向外扩展 n * size * 2 (确保覆盖够宽)
            // 这里用一个近似值：size * 1.5 * n
            const bufferDist = size * 1.5 * BUFFER_RINGS;

            // 对每个活跃网格，寻找其周边的邻居
            activeCells.forEach((cell: any) => {
                const cellBbox = turf.bbox(cell);
                // 扩大 BBox
                const expandedBbox = [
                    cellBbox[0] - 0.02 * size * BUFFER_RINGS, // 经度简易换算
                    cellBbox[1] - 0.02 * size * BUFFER_RINGS, // 纬度简易换算
                    cellBbox[2] + 0.02 * size * BUFFER_RINGS,
                    cellBbox[3] + 0.02 * size * BUFFER_RINGS
                ];
                
                // 利用 turf.buffer 更精确 (但这比较慢)，或者直接用 GridIndex 查邻居 (极快)
                // 这里我们用 GridIndex + 几何中心距离判断
                const center = turf.centroid(cell);
                // 搜索范围略大于缓冲区
                const neighbors = gridIndex.queryByBbox(expandedBbox);
                
                neighbors.forEach((neighbor: any) => {
                    if (cellsToKeep.has(neighbor.properties._id)) return;
                    
                    // 计算距离，判断是否在 n 圈内
                    const dist = turf.distance(center, turf.centroid(neighbor), { units: 'kilometers' });
                    // 两个相邻六边形中心距离约为 size * 1.732
                    // n 圈大约是 n * 2 * size
                    if (dist <= size * 2.0 * BUFFER_RINGS) {
                        cellsToKeep.add(neighbor.properties._id);
                    }
                });
            });

            console.log(`[Grid Filter] Buffer expansion (${BUFFER_RINGS} rings): ${activeCellIds.size} -> ${cellsToKeep.size} cells`);
            
            // 执行过滤
            grid.features = grid.features.filter((f: any) => cellsToKeep.has(f.properties._id));
        } else {
            // 如果没有任何相交，返回空
            grid.features = [];
        }

        // 清理临时 ID
        grid.features.forEach((f: any) => delete f.properties._id);

        res.json({ success: true, data: grid });

    } catch (error) {
        console.error('Grid generation failed:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// 辅助函数：确保 Key 生成逻辑在“初始化阶段”和“聚合阶段”完全一致
const getSafeKey = (field: string, val: any) => {
    const strVal = String(val); // 强制转字符串
    const safeVal = strVal.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_');
    return `${field}_${safeVal}`;
};

export const exportGrid = async (req: Request, res: Response): Promise<void> => {
    try {
        const { fileId, shape, size, method, categoryFields } = req.body;

        if (!fileId || !shape || !size) {
            res.status(400).json({ error: 'Missing required parameters' });
            return;
        }

        const selectedCategories: string[] = Array.isArray(categoryFields) 
            ? categoryFields 
            : (categoryFields ? [categoryFields] : []);

        console.log(`[Export] Exporting ${shape} grid (${size}km) for file ${fileId}. Method: ${method}`);

        const getSafeKey = (field: string, val: any) => {
            const strVal = String(val);
            const safeVal = strVal.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_');
            return `${field}_${safeVal}`;
        };

        // 1. 获取原始数据
        const rawFeatures = await Feature.find({ fileId }).lean();
        if (!rawFeatures || rawFeatures.length === 0) {
                res.status(404).json({ error: 'No features found' });
                return;
        }

        //   [Fix: 移动定义到这里] 统一在最前面将原始数据转为 Turf Feature，供后续所有步骤使用
        const features = rawFeatures.map((f: any) => turf.feature(f.geometry, f.properties));
        
        //   [新增] 预判数据类型 (用于覆盖率计算)
        const firstGeom = features[0]?.geometry.type;
        const isPolygonLayer = firstGeom?.includes('Polygon');
        const isLineLayer = firstGeom?.includes('Line');

        // 2. 识别字段 & 收集分类值
        const numericFields = new Set<string>();
        const categoryValueMap = new Map<string, Set<string>>();

        selectedCategories.forEach(field => categoryValueMap.set(field, new Set()));

        rawFeatures.forEach((f: any) => {
            if (f.properties) {
                Object.keys(f.properties).forEach(key => {
                    if (typeof f.properties[key] === 'number') {
                        numericFields.add(key);
                    }
                });
                selectedCategories.forEach(field => {
                    const val = f.properties[field];
                    if (val !== undefined && val !== null) {
                        categoryValueMap.get(field)?.add(String(val));
                    }
                });
            }
        });

        const fieldsToAggregate = Array.from(numericFields);
        const allCategoryColumns: string[] = [];
        categoryValueMap.forEach((values, field) => {
            Array.from(values).sort().forEach(val => {
                allCategoryColumns.push(getSafeKey(field, val));
            });
        });

        // 3. 准备网格
        // ❌ [删除] 原来的 const features = ... 删掉，防止重复声明错误
        const featureCollection = turf.featureCollection(features);
        const bbox = turf.bbox(featureCollection);
        
        const options: any = { units: 'kilometers' };
        let grid: any;
        try {
            if (shape === 'hex') {
                grid = turf.hexGrid(bbox, size, options);
            } else {
                grid = turf.squareGrid(bbox, size, options);
            }
        } catch (e) {
            res.status(500).json({ error: 'Grid generation error' });
            return;
        }

        // 初始化网格属性
        grid.features.forEach((cell: any) => {
            const props: any = { 
                count: 0, 
                value: 0, //   [新增] 显式初始化 value 字段
                _weight: 0 
            };
            
            // A. 常规数值
            fieldsToAggregate.forEach(field => {
                props[field] = (method === 'max' || method === 'min') 
                    ? (method === 'max' ? -Infinity : Infinity) 
                    : 0;
            });

            // B. 分类列
            allCategoryColumns.forEach(key => {
                props[key] = 0;
            });

            cell.properties = props;
        });

        // 4. 建立索引 & 聚合
        const gridIndex = new SimpleGridIndex(bbox, 25);
        grid.features.forEach((cell: any) => gridIndex.insert(cell));

        features.forEach((feature: any) => {
            const geometryType = feature.geometry.type;
            const candidateCells = gridIndex.query(feature);

            //   [新增] 计算 rawValue (核心指标)
            let rawValue = 1; // 默认为计数 (count)
            if (method === 'coverage') {
                if (isPolygonLayer) {
                    rawValue = turf.area(feature); // m²
                } else if (isLineLayer) {
                    rawValue = turf.length(feature, { units: 'kilometers' }); // km
                }
            } else if (method !== 'count' && method !== 'coverage') {
                 // 其他模式下 value 默认记为 1 (类似 count)，主要看具体属性字段
                 rawValue = 1; 
            }

            const activeCategoryKeys: string[] = [];
            selectedCategories.forEach(field => {
                const rawCat = feature.properties[field];
                if (rawCat !== undefined && rawCat !== null) {
                    activeCategoryKeys.push(getSafeKey(field, rawCat));
                }
            });

            candidateCells.forEach((cell: any) => {
                let ratio = 0;
                try {
                    // --- 几何计算 ---
                    if (geometryType === 'Point') {
                        if (turf.booleanPointInPolygon(feature, cell)) ratio = 1;
                    } 
                    else if (geometryType.includes('Line')) {
                        if (turf.booleanIntersects(cell, feature)) {
                            // 简化处理，若需要更高精度可换回 lineSplit
                            if (turf.booleanContains(cell, feature)) ratio = 1;
                            else ratio = 0.5; 
                        }
                    }
                    else if (geometryType.includes('Polygon')) {
                        if (turf.booleanIntersects(cell, feature)) {
                            const intersect = safeIntersect(cell, feature);
                            if (intersect) ratio = turf.area(intersect) / turf.area(feature);
                        }
                    }
                    // ------------------------------

                    if (ratio > 0) {
                        cell.properties.count += 1;
                        cell.properties._weight += ratio;
                        
                        //   [新增] 累加核心 Value
                        // Count模式: 1 * ratio
                        // Coverage模式: Area * ratio (即网格内的实际面积)
                        cell.properties.value += rawValue * ratio;

                        // 1. 常规聚合
                        if (method !== 'count' && method !== 'coverage') {
                            fieldsToAggregate.forEach(field => {
                                const val = Number(feature.properties[field]);
                                if (!isNaN(val)) {
                                    if (method === 'sum' || method === 'avg') cell.properties[field] += val * ratio;
                                    else if (method === 'max') cell.properties[field] = Math.max(cell.properties[field], val);
                                    else if (method === 'min') cell.properties[field] = Math.min(cell.properties[field], val);
                                }
                            });
                        }

                        // 2. 多分类拆分聚合
                        activeCategoryKeys.forEach(key => {
                            if (typeof cell.properties[key] === 'undefined') cell.properties[key] = 0;
                            cell.properties[key] += ratio;
                        });
                    }
                } catch (e) {}
            });
        });

        // 5. 后处理
        const resultFeatures = grid.features.filter((f: any) => f.properties.count > 0);
        
        resultFeatures.forEach((cell: any) => {
            //   [新增] 覆盖率模式归一化处理
            if (method === 'coverage') {
                const cellAreaSqM = turf.area(cell);
                
                if (isPolygonLayer) {
                    // 面覆盖率 = 网格内总面积 / 网格面积
                    cell.properties.value = cell.properties.value / cellAreaSqM;
                    if (cell.properties.value > 1) cell.properties.value = 1;
                } else if (isLineLayer) {
                    // 线密度 = 网格内总长度(km) / 网格面积(km²)
                    const cellAreaSqKm = cellAreaSqM / 1_000_000;
                    if (cellAreaSqKm > 0) {
                        cell.properties.value = cell.properties.value / cellAreaSqKm;
                    }
                }
                cell.properties.value = Number(cell.properties.value.toFixed(4));
            } else {
                // 其他模式保留两位小数
                cell.properties.value = Number(cell.properties.value.toFixed(2));
            }

            // 常规字段修约
            fieldsToAggregate.forEach(field => {
                if (method === 'avg' && cell.properties._weight > 0) {
                    cell.properties[field] = Number((cell.properties[field] / cell.properties._weight).toFixed(2));
                } else if (method !== 'count' && method !== 'coverage') {
                    if (cell.properties[field] !== Infinity && cell.properties[field] !== -Infinity) {
                            cell.properties[field] = Number(cell.properties[field].toFixed(2));
                    } else {
                            cell.properties[field] = 0;
                    }
                }
            });
            
            // 分类字段修约
            allCategoryColumns.forEach(key => {
                if (typeof cell.properties[key] !== 'undefined') {
                    cell.properties[key] = Number(cell.properties[key].toFixed(3));
                }
            });
            
            delete cell.properties._weight;
        });

        const finalGeoJSON = turf.featureCollection(resultFeatures);
        const fileName = `grid_export_${fileId}_${method}_${Date.now()}.geojson`;
        res.setHeader('Content-Type', 'application/geo+json');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        res.send(JSON.stringify(finalGeoJSON));

    } catch (error) {
        console.error('Export failed:', error);
        res.status(500).json({ error: 'Export failed' });
    }
}

// 获取所有已注册的活跃模型
export const getRegisteredModels = async (req: Request, res: Response) => {
  try {
    // 只返回 active 状态的模型，并且不要把底层的 pythonCode 传给前端（节省带宽）
    const models = await ModelRegistry.find({ status: 'active' }).select('-pythonCode');
    res.json({ code: 200, data: models });
  } catch (error) {
    console.error("获取模型列表失败:", error);
    res.status(500).json({ error: '获取模型列表失败' });
  }
};

// ==========================================
// LLM 智能体代理注册接口 (API 机械臂)
// ==========================================
export const registerModelByAI = async (req: Request, res: Response) => {
  try {
    // 接收 LLM 生成的模型名称、描述、参数规范，以及最关键的：Python 源代码字符串
    const { modelName, displayName, description, parameters, pythonCode } = req.body;

    if (!pythonCode) {
      return res.status(400).json({ error: '智能体未能提供有效的 Python 代码' });
    }

    // 步骤 A：物理隔离写入（绝对不碰 main.py，只向 models 文件夹注入“零件”）
    // 解析出 python_engine/models 的绝对路径 (根据你的目录结构可能需要微调 ../ 的数量)
    const modelsDir = path.join(process.cwd(), '../python_engine/models');
    
    // 确保 models 文件夹存在
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true });
    }

    // 将 AI 写的代码保存为 .py 文件（例如 lsi_ahp.py）
    const fileName = `${modelName.toLowerCase()}.py`;
    const filePath = path.join(modelsDir, fileName);
    fs.writeFileSync(filePath, pythonCode, 'utf8');

    // 步骤 B：元数据落库（记录在案，供前端动态读取公式列表）
    const newModel = await ModelRegistry.findOneAndUpdate(
      { modelName: modelName.toUpperCase() }, // 统一大写，如 LSI_AHP
      { 
        modelName: modelName.toUpperCase(), 
        displayName, 
        description, 
        parameters, 
        status: 'active' 
      },
      { upsert: true, new: true } // 如果存在则更新，不存在则创建
    );

    res.json({ 
      code: 200, 
      message: `智能体已成功将模型 ${modelName} 注入系统并注册完毕！`, 
      data: newModel 
    });
  } catch (error: any) {
    res.status(500).json({ error: '模型代理注册失败: ' + error.message });
  }
};

// ==========================================
// 2. 核心模型函数计算 (高速调度网关 BFF)
// ==========================================
export const executeTableFormula = async (req: Request, res: Response) => {
  try {
    const { fileId, modelName, rawArgs } = req.body;
    
    // 兼容老代码接口
    let reqColumns: string[] = req.body.columns || [];
    let reqParams: Record<string, any> = req.body.params || {};

    let modelDef = await ModelRegistry.findOne({ modelName: modelName.toUpperCase() });
    if (!modelDef) {
        console.warn(`[BFF 警告] MongoDB 未找到模型元数据: ${modelName}，将尝试直接穿透调度到底层引擎...`);
        // 构造一个虚拟的 modelDef，防止后面映射参数时报错
        modelDef = { parameters: [] } as any; 
    }

    //   核心突破：动态参数分类与路由 (保持原有优秀逻辑)
    if (rawArgs && Array.isArray(rawArgs)) {
        reqColumns = [];
        reqParams = {};
        
        rawArgs.forEach((arg: string, index: number) => {
            const numVal = Number(arg);
            const paramName = modelDef?.parameters?.[index]?.name || `param_${index}`;

            if (!isNaN(numVal) && arg.trim() !== '') {
                reqParams[paramName] = numVal;
            } else if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
                reqParams[paramName] = arg.slice(1, -1);
            } else {
                reqColumns.push(arg);
                reqParams[paramName] = arg;       //   2. 【新增这一行】：绑定参数键值对！
            }
        });
    }

    console.log(`[BFF调度层] 向底层空间引擎下发计算指令... 文件: ${fileId}, 模型: ${modelName}`);

    // ==========================================
    //   终极瘦身：彻底斩断 Node.js 的数据搬运！
    // ==========================================

    //   新增：合并前端传来的列（reqColumns）与模型注册时 AI 提取的必填列（requiredColumns）
    // 用 Set 去重，防止同一个列名传两遍
    const finalColumns = Array.from(new Set([
        ...reqColumns, 
        ...(modelDef?.requiredColumns || []) // 👈 从 MongoDB 里读出 AI 存下的列名
    ]));

    // 发送给 Python
    const response = await axios.post<PythonApiResponse>(`${PYTHON_API_URL}/models/execute`, {
      model_name: modelName,
      file_id: fileId,         
      columns: finalColumns,   //   将合并后的终极列名数组发给 Python 引擎
      parameters: reqParams    
    });

    // ==========================================
    //   接收轻量级结果与协同渲染
    // ==========================================
    // 此时 Python 已经在底层完成了“拉取 -> 计算 -> MongoDB 回写”的闭环！
    // Node.js 只需要拿到轻量级的绘图数据返回给前端即可。
    const { result_col_names, result_data, execution_time_ms } = response.data;

    console.log(`[BFF调度层] 底层引擎计算并落盘完毕，新增 ${result_col_names.length} 列，总耗时 ${execution_time_ms.toFixed(2)}ms`);

    // 直接返回给前端更新 UI
    res.json({ 
        code: 200, 
        resultColName: result_col_names, 
        resultData: result_data 
    });

  } catch (error: any) {
    console.error("模型执行错误:", error.response?.data || error.message);
    res.status(500).json({ error: '模型执行异常', details: error.response?.data?.detail || error.message });
  }
};

// ==========================================
//   核心突破：Agentic Workflow 模型智能生成与元数据提取
// ==========================================
export const createModelViaNaturalLanguage = async (req: Request, res: Response) => {
    try {
        const { userDescription } = req.body;

        if (!userDescription) {
            return res.status(400).json({ error: "需求描述不能为空" });
        }

        console.log(`[GeoAI Agent] 收到用户指令: ${userDescription}`);
        console.log(`[GeoAI Agent] 正在思考并提取模型特征...`);

        // 1. 唤醒大模型，返回结构化的 JSON 数据（包含名字、描述、参数、代码）
        const aiResult = await generateModelCodeFromAI(userDescription);
        
        //   关键修改：在这里解构出 parameters
        const { modelName, displayName, description, parameters, requiredColumns, pythonCode } = aiResult;

        console.log(`[GeoAI Agent] 思考完成！模型名: ${modelName}，提取到 ${parameters?.length || 0} 个参数。准备注入系统。`);

        // 2. 物理隔离写入 (存入 python_engine/models)
        const modelsDir = path.join(process.cwd(), '../python_engine/models');
        if (!fs.existsSync(modelsDir)) {
            fs.mkdirSync(modelsDir, { recursive: true });
        }
        
        const fileName = `${modelName.toLowerCase()}.py`;
        const filePath = path.join(modelsDir, fileName);
        fs.writeFileSync(filePath, pythonCode, 'utf8');

        // 3. 元数据落库 (MongoDB)
        const newModel = await ModelRegistry.findOneAndUpdate(
            { modelName: modelName.toUpperCase() },
            { 
                modelName: modelName.toUpperCase(), 
                displayName: displayName, 
                description: description, 
                parameters: parameters || [], //   核心：把大模型解析出的参数定义直接存入数据库！
                requiredColumns: requiredColumns || [], //   新增：存入必须的列名
                status: 'active' 
            },
            { upsert: true, new: true }
        );

        res.json({ 
            code: 200, 
            message: `🎉 成功！GeoAI 为您构建了 ${displayName} (${modelName})。`, 
            data: newModel,
            previewCode: pythonCode 
        });

    } catch (error: any) {
        console.error("大模型 Agent 执行失败:", error);
        res.status(500).json({ error: error.message || '系统内部异常' });
    }
};