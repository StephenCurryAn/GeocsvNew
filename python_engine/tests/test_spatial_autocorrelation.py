import io
import math
import os
import unittest
import warnings
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

import geopandas as gpd
import numpy as np
from fastapi import HTTPException
from numpy.testing import assert_allclose, assert_array_equal
from shapely.geometry import box

# SQLAlchemy creates the engine lazily. Never use the caller's database settings.
with patch.dict(os.environ, {"PG_URI": "postgresql://offline.invalid/geocsv_baseline"}):
    from legacy import spatial_autocorrelation as engine_api


def four_polygons():
    # A and B share an edge, B and C share a vertex, and D is isolated.
    return gpd.GeoDataFrame(
        geometry=[box(0, 0, 1, 1), box(1, 0, 2, 1), box(2, 1, 3, 2), box(10, 0, 11, 1)],
        index=[10, 30, 20, 40],
    )


class PolygonNeighborsTests(unittest.TestCase):
    def test_shared_edge_shared_corner_and_island(self):
        cases = (
            ("queen", [[1], [0, 2], [1], []]),
            (" ROOK ", [[1], [0], [], []]),
            ("unknown", [[1], [0, 2], [1], []]),
        )
        for mode, expected in cases:
            with self.subTest(mode=mode):
                self.assertEqual(engine_api._build_polygon_neighbors(four_polygons(), mode), expected)

    def test_overlap_and_containment_count_as_queen_neighbors(self):
        layer = gpd.GeoDataFrame(
            geometry=[box(0, 0, 4, 4), box(1, 1, 5, 5), box(2, 2, 3, 3)]
        )
        self.assertEqual(engine_api._build_polygon_neighbors(layer, "queen"), [[1, 2], [0, 2], [0, 1]])
        self.assertEqual(engine_api._build_polygon_neighbors(layer, "rook"), [[], [], []])


class MoranStatisticsTests(unittest.TestCase):
    def test_row_standardized_path_and_island(self):
        stats = engine_api._compute_spatial_autocorrelation(
            np.array([1.0, 3.0, 5.0, 7.0]),
            [[1], [0, 2], [1], []],
            permutations=0,
        )
        # The centered values are [-3, -1, 1, 3]; the path has lag -1 at
        # each vertex and contributes 3 to the global numerator (D contributes 0).
        self.assertAlmostEqual(stats["global_moran_i"], 1 / 5, places=12)
        self.assertAlmostEqual(stats["global_expected_i"], -1 / 3, places=12)
        self.assertEqual(stats["global_p_value"], 1.0)
        self.assertIsNone(stats["global_z_score"])
        assert_allclose(stats["local_i"], [3 / 5, 1 / 5, -1 / 5, 0], atol=1e-12, rtol=0)
        assert_allclose(stats["lag_z"], np.array([-1, -1, -1, 0]) / math.sqrt(5), atol=1e-12, rtol=0)
        assert_allclose(stats["z_scores"], np.array([-3, -1, 1, 3]) / math.sqrt(5), atol=1e-12, rtol=0)
        assert_array_equal(stats["local_p_values"], [1, 1, 1, 1])
        assert_array_equal(stats["neighbor_counts"], [1, 2, 1, 0])

    def test_four_seeded_permutations(self):
        stats = engine_api._compute_spatial_autocorrelation(
            np.array([1.0, 3.0, 5.0, 7.0]),
            [[1], [0, 2], [1], []],
            permutations=4,
        )
        # Seed-42 draws give global I of 1/5, 0, -3/5, -3/5. The audit
        # record shows the four assignments and the individual local comparisons.
        self.assertAlmostEqual(stats["global_p_value"], 4 / 5, places=12)
        self.assertAlmostEqual(stats["global_z_score"], 9 / math.sqrt(51), places=12)
        assert_allclose(stats["local_p_values"], [1, 4 / 5, 1, 1], atol=1e-12, rtol=0)


class SpatialAutocorrelationRouteTests(unittest.IsolatedAsyncioTestCase):
    async def run_with_layer(self, properties, geometries=None):
        size = len(properties)
        layer = gpd.GeoDataFrame(
            {
                "id": [f"feature-{i}" for i in range(size)],
                "properties": properties,
                "geom": geometries if geometries is not None else [box(i, 0, i + 1, 1) for i in range(size)],
            },
            geometry="geom",
            crs="EPSG:4326",
        )
        payload = engine_api.SpatialAutocorrelationInput(
            target_file_id="offline-polygons", value_column="value", permutations=0
        )
        with (
            patch.object(engine_api, "engine"),
            patch.object(engine_api.gpd, "read_postgis", return_value=layer),
        ):
            return await engine_api.compute_spatial_autocorrelation(payload)

    async def test_filtering_values_rebuilds_neighbors_and_preserves_feature_ids(self):
        properties = [
            {"id": "attribute-id", "value": 1},
            {},
            {"value": "5"},
            {"value": 7},
            {"value": "invalid"},
            {"value": None},
        ]
        with warnings.catch_warnings():
            # The legacy export computes centroids in WGS84.
            warnings.filterwarnings("ignore", message="Geometry is in a geographic CRS", category=UserWarning)
            result = await self.run_with_layer(properties)

        rows = result["local_rows"]
        self.assertEqual([row["id"] for row in rows], ["feature-0", "feature-2", "feature-3"])
        self.assertEqual([row["value"] for row in rows], [1.0, 5.0, 7.0])
        self.assertEqual([row["LISA_Neighbor_Count"] for row in rows], [0, 1, 1])
        self.assertEqual([row["LISA_Local_I"] for row in rows], [0.0, 0.285714, 0.285714])
        self.assertEqual([row["LISA_P_Value"] for row in rows], [1.0, 1.0, 1.0])
        self.assertEqual(result["summary"]["global_moran_i"], 0.285714)
        self.assertEqual(result["summary"]["cluster_counts"], {"孤立街道": 1, "不显著": 2})
        features = result["map_payload"][0]["geojson"]["features"]
        self.assertEqual([feature["properties"]["value"] for feature in features], [1.0, 5.0, 7.0])

    async def test_fewer_than_three_numeric_values_returns_400(self):
        with self.assertRaises(HTTPException) as raised:
            await self.run_with_layer([{"value": 1}, {"value": 2}, {}, {"value": "invalid"}])
        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("不足 3 个", raised.exception.detail)

    async def test_constants_and_infinities_return_500(self):
        cases = ([2.0, 2.0, 2.0], [1.0, 3.0, 5.0, math.inf], [1.0, 3.0, 5.0, "-inf"])
        for values in cases:
            with self.subTest(values=values):
                with (
                    self.assertRaises(HTTPException) as raised,
                    redirect_stdout(io.StringIO()),
                    redirect_stderr(io.StringIO()),
                    np.errstate(invalid="ignore"),
                ):
                    await self.run_with_layer([{"value": value} for value in values])
                self.assertEqual(raised.exception.status_code, 500)
                self.assertIn("没有足够的数值离散性", raised.exception.detail)

    async def test_all_islands_return_500(self):
        with (
            self.assertRaises(HTTPException) as raised,
            redirect_stdout(io.StringIO()),
            redirect_stderr(io.StringIO()),
        ):
            await self.run_with_layer(
                [{"value": 1}, {"value": 3}, {"value": 5}],
                geometries=[box(i, 0, i + 1, 1) for i in (0, 2, 4)],
            )
        self.assertEqual(raised.exception.status_code, 500)
        self.assertIn("无法构建空间权重矩阵", raised.exception.detail)
