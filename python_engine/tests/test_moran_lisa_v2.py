import math
import unittest

import geopandas as gpd
import numpy as np
from numpy.testing import assert_allclose
from shapely.geometry import Point, Polygon, box

from operators.spatial_autocorrelation import compute_moran_lisa


def layer(values=(1, 3, 5, 7), geometries=None, crs="EPSG:4326", ids=None):
    # A-B share an edge, B-C share a point, and D is an island.
    if geometries is None:
        geometries = [box(0, 0, 1, 1), box(1, 0, 2, 1), box(2, 1, 3, 2), box(10, 0, 11, 1)]
    return gpd.GeoDataFrame(
        {"id": list("ABCD") if ids is None else ids, "value": values},
        geometry=geometries,
        crs=crs,
        index=[30, 10, 20, 40],
    )


class MoranLisaTests(unittest.TestCase):
    def test_observed_statistics_and_island(self):
        result = compute_moran_lisa(layer(), "value", permutations=0)
        self.assertAlmostEqual(result["global_i"], 1 / 5, places=12)
        self.assertAlmostEqual(result["global_expected_i"], -1 / 3, places=12)
        self.assertIsNone(result["global_p"])
        self.assertEqual(result["s0"], 3)
        self.assertEqual(result["crs"], "EPSG:4326")
        rows = result["local"]
        self.assertEqual([row["id"] for row in rows], list("ABCD"))
        assert_allclose([row["i"] for row in rows], [9 / 20, 3 / 20, -3 / 20, 0], atol=1e-12)
        assert_allclose([row["expected_i"] for row in rows], [-9 / 20, -1 / 20, -1 / 20, 0], atol=1e-12)
        assert_allclose([row["lag_z"] for row in rows], np.array([-1, -1, -1, 0]) / math.sqrt(5))
        self.assertEqual([row["neighbor_count"] for row in rows], [1, 2, 1, 0])
        self.assertEqual([row["quadrant"] for row in rows], ["LL", "LL", "HL", None])
        self.assertEqual([row["p"] for row in rows], [None] * 4)

    def test_four_seeded_draws_have_inclusive_tails_and_add_one_correction(self):
        # Global I draws: -6/5, 0, -3/5, -2/5. Only -6/5 is extreme.
        # Conditional local draws: A [-9, 9, 9, 9]/20, B [3, 3, 0, 3]/20,
        # C [-3, -9, -9, -9]/20. Three, three and four draws are extreme.
        result = compute_moran_lisa(layer(), "value", permutations=4, seed=42)
        self.assertEqual(result["global_p"], 2 / 5)
        self.assertEqual(
            [row["p"] for row in result["local"]], [4 / 5, 4 / 5, 1.0, None]
        )

    def test_seeded_inference_matches_hand_enumerated_probabilities(self):
        # Global draws: 8 of 24 permutations are at least as far from -1/3 as
        # the observed 1/5. Conditional local draws: A and B each have 2/3
        # extreme outcomes; for C the observed outcome is closest to its mean.
        result = compute_moran_lisa(layer(), "value", permutations=4095, seed=42)
        self.assertAlmostEqual(result["global_p"], 1 / 3, delta=0.035)
        assert_allclose([row["p"] for row in result["local"][:3]], [2 / 3, 2 / 3, 1], atol=0.035, rtol=0)
        self.assertEqual(result["local"][2]["p"], 1.0)
        self.assertIsNone(result["local"][3]["p"])

    def test_row_order_and_global_rng_do_not_affect_replay(self):
        source = layer()
        kwargs = {"permutations": 19, "seed": 751}
        before = np.random.get_state()
        first = compute_moran_lisa(source, "value", **kwargs)
        assert_allclose(np.random.get_state()[1], before[1], atol=0, rtol=0)
        self.assertEqual(np.random.get_state()[2:], before[2:])
        self.assertEqual(compute_moran_lisa(source.iloc[[3, 1, 0, 2]], "value", **kwargs), first)
        self.assertEqual(first["seed"], 751)
        self.assertEqual(first["permutations"], 19)

    def test_nonfinite_or_nonnumeric_values_are_reported_and_weights_rebuilt(self):
        chain = [box(i, 0, i + 1, 1) for i in range(4)]
        for invalid in (math.inf, "-inf", np.nan, "invalid", None, True, 2 + 1j):
            with self.subTest(invalid=invalid):
                source = layer((1, invalid, "5", 7), chain)
                result = compute_moran_lisa(source, "value", permutations=0)
                self.assertEqual(result["excluded_value_ids"], ["B"])
                self.assertEqual([row["id"] for row in result["local"]], list("ACD"))
                self.assertEqual([row["neighbor_count"] for row in result["local"]], [0, 1, 1])
                self.assertAlmostEqual(result["global_i"], 2 / 7, places=12)
                assert_allclose([row["i"] for row in result["local"]], [0, 4 / 21, 4 / 21])

    def test_partially_shared_edges_and_vertex_inside_an_edge(self):
        geometries = [
            box(0, 0, 2, 2),
            box(2, 0.5, 3, 1.5),  # Partial shared segment with A and no common vertices.
            Polygon([(1, 2), (0.5, 3), (1.5, 3)]),  # Vertex in the interior of A's edge.
            box(0.2, 0.2, 0.4, 0.4),  # Contained by A.
        ]
        for mode, counts in (("queen", [2, 1, 1, 0]), ("rook", [1, 1, 0, 0])):
            with self.subTest(mode=mode):
                result = compute_moran_lisa(layer(geometries=geometries), "value", contiguity=mode, permutations=0)
                self.assertEqual([row["neighbor_count"] for row in result["local"]], counts)

    def test_polygon_overlap_is_excluded_even_with_shared_vertices(self):
        geometries = [box(0, 0, 2, 2), box(0, 0, 1, 2), box(2, 0, 3, 2), box(3, 0, 4, 2)]
        for mode in ("queen", "rook"):
            with self.subTest(mode=mode):
                result = compute_moran_lisa(layer(geometries=geometries), "value", contiguity=mode, permutations=0)
                self.assertEqual([row["neighbor_count"] for row in result["local"]], [1, 0, 2, 1])

    def test_degenerate_permutation_distribution_counts_all_ties(self):
        # Three pairwise-touching polygons form a complete graph. The sums
        # of the other values are fixed for each focal row.
        complete = [
            Polygon([(0, 0), (-1, -1), (1, -1)]),
            Polygon([(0, 0), (1, -1), (0, 1)]),
            Polygon([(0, 0), (0, 1), (-1, -1)]),
        ]
        result = compute_moran_lisa(layer(geometries=complete + [box(5, 5, 6, 6)]).iloc[:3], "value", permutations=16)
        self.assertAlmostEqual(result["global_i"], -0.5, places=12)
        self.assertEqual(result["global_p"], 1.0)
        self.assertEqual([row["p"] for row in result["local"]], [1.0, 1.0, 1.0])

    def test_finite_extreme_magnitudes_can_be_standardized(self):
        for values in ((-1e308, 0, 0, 1e308), (-5e-324, 0, 0, 5e-324)):
            with self.subTest(values=values):
                result = compute_moran_lisa(layer(values), "value", permutations=8)
                self.assertEqual(result, compute_moran_lisa(layer((-1, 0, 0, 1)), "value", permutations=8))

    def test_invalid_inputs_have_explicit_errors(self):
        bad_polygon = Polygon([(0, 0), (1, 1), (0, 1), (1, 0)])
        cases = (
            (layer().iloc[:0], {}, "at least three"),
            (layer(crs=None), {}, "CRS"),
            (layer(crs="EPSG:4979"), {}, "CRS"),
            (layer(geometries=[bad_polygon] + list(layer().geometry[1:])), {}, "polygon"),
            (layer(geometries=[Point(0, 0)] + list(layer().geometry[1:])), {}, "polygon"),
            (layer(geometries=[box(i, 0, i + 1, 1) for i in (0, 2, 4, 6)]), {}, "all features are islands"),
            (layer((3, 3, 3, 3)), {}, "constant"),
            (layer(ids=["A", "A", "C", "D"]), {}, "unique"),
            (layer(ids=["A", "", "C", "D"]), {}, "non-empty"),
            (layer(), {"contiguity": "queen "}, "contiguity"),
            (layer(), {"permutations": -1}, "permutations"),
            (layer(), {"seed": True}, "seed"),
        )
        for frame, kwargs, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                compute_moran_lisa(frame, "value", **kwargs)
        with self.assertRaisesRegex(ValueError, "value column"):
            compute_moran_lisa(layer(), "absent")
