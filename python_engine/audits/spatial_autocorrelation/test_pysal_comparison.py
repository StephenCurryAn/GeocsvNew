from fractions import Fraction
from itertools import permutations
import unittest
from unittest.mock import patch

import geopandas as gpd
import numpy as np
from numpy.testing import assert_allclose, assert_array_equal
from shapely.geometry import Polygon, box

from operators.spatial_autocorrelation import compute_moran_lisa

with patch("socket.socket.connect", side_effect=AssertionError("unexpected network access")):
    from esda import Moran, Moran_Local
    from libpysal.weights import Queen, Rook, lag_spatial


def four_polygons():
    return gpd.GeoDataFrame(
        {"id": list("ABCD"), "value": [1, 3, 5, 7]},
        geometry=[box(0, 0, 1, 1), box(1, 0, 2, 1), box(2, 1, 3, 2), box(10, 0, 11, 1)],
        crs="EPSG:3857",
    )


class PySalComparisonTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch("socket.socket.connect", side_effect=AssertionError("unexpected network access")))

    def test_queen_and_rook_weights_global_and_local_statistics(self):
        frame = four_polygons()
        y = frame["value"].to_numpy()
        expected_weights = (
            ("queen", Queen, [[0, 1, 0, 0], [0.5, 0, 0.5, 0], [0, 1, 0, 0], [0, 0, 0, 0]]),
            ("rook", Rook, [[0, 1, 0, 0], [1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]),
        )
        for mode, weight_class, matrix in expected_weights:
            with self.subTest(mode=mode):
                w = weight_class.from_dataframe(frame, ids="id", silence_warnings=True)
                global_model = Moran(y, w, transformation="r", permutations=0)
                local_model = Moran_Local(y, w, transformation="r", permutations=0)
                result = compute_moran_lisa(frame.iloc[::-1], "value", contiguity=mode, permutations=0)
                rows = result["local"]
                self.assertEqual([row["id"] for row in rows], w.id_order)
                assert_array_equal(w.full()[0], matrix)
                assert_array_equal([row["neighbor_count"] for row in rows], np.count_nonzero(matrix, axis=1))
                self.assertEqual(result["s0"], w.s0)
                self.assertAlmostEqual(result["global_i"], global_model.I, places=12)
                self.assertAlmostEqual(result["global_expected_i"], global_model.EI, places=12)
                assert_allclose([row["i"] for row in rows], local_model.Is, atol=1e-12, rtol=0)
                assert_allclose([row["z"] for row in rows], local_model.z, atol=1e-12, rtol=0)
                assert_allclose([row["lag_z"] for row in rows], lag_spatial(w, local_model.z), atol=1e-12, rtol=0)

    def test_vertex_and_segment_matching_differs_from_boundary_topology(self):
        frame = four_polygons().set_geometry([
            box(0, 0, 2, 2),
            box(2, 0.5, 3, 1.5),
            Polygon([(1, 2), (0.5, 3), (1.5, 3)]),
            box(0, 0, 0.8, 2),
        ])
        for mode, weight_class, core_degrees, reference_neighbors in (
            ("queen", Queen, [2, 1, 1, 0], {"A": ["D"], "B": [], "C": [], "D": ["A"]}),
            ("rook", Rook, [1, 1, 0, 0], {"A": ["D"], "B": [], "C": [], "D": ["A"]}),
        ):
            with self.subTest(mode=mode):
                w = weight_class.from_dataframe(frame, ids="id", silence_warnings=True)
                self.assertEqual(w.neighbors, reference_neighbors)
                result = compute_moran_lisa(frame, "value", contiguity=mode, permutations=0)
                self.assertEqual([row["neighbor_count"] for row in result["local"]], core_degrees)

    def test_permutation_distributions_and_p_values_against_exact_enumeration(self):
        frame = four_polygons()
        y = frame["value"].to_numpy()
        w = Queen.from_dataframe(frame, ids="id", silence_warnings=True)
        draws = 4095
        rng_state = np.random.get_state()
        try:
            np.random.seed(42)
            global_model = Moran(y, w, transformation="r", permutations=draws)
            with np.errstate(invalid="ignore"):  # The island has zero simulated variance.
                local_model = Moran_Local(y, w, transformation="r", permutations=draws, seed=42, n_jobs=1)
        finally:
            np.random.set_state(rng_state)

        exact_global = [
            Fraction(b * (a + c), 10)
            for a, b, c, _ in permutations((-3, -1, 1, 3))
        ]
        exact_local = [
            [Fraction(-9 * b, 20) for b in (-1, 1, 3)],
            [Fraction(-3 * (a + c), 40) for a, c in permutations((-3, 1, 3), 2)],
            [Fraction(3 * b, 20) for b in (-3, -1, 3)],
        ]
        result = compute_moran_lisa(frame, "value", permutations=draws, seed=42)
        self.check_null(exact_global, Fraction(1, 5), global_model.sim, result["global_p"])
        for i, observed in enumerate((Fraction(9, 20), Fraction(3, 20), Fraction(-3, 20))):
            self.check_null(exact_local[i], observed, local_model.sim[:, i], result["local"][i]["p"])

        exact_means = [float(sum(sample) / len(sample)) for sample in exact_local]
        assert_allclose([row["expected_i"] for row in result["local"][:3]], exact_means, atol=1e-12, rtol=0)
        # esda's analytical EIc used the n normalization, even though Is and sim used n-1.
        assert_allclose(local_model.EIc[:3] * 3 / 4, exact_means, atol=1e-12, rtol=0)
        self.assertLess(global_model.p_sim, result["global_p"])
        self.assertLess(local_model.p_sim[2], result["local"][2]["p"])
        assert_array_equal(local_model.sim[:, 3], 0)
        self.assertEqual(local_model.p_sim[3], 1 / (draws + 1))
        self.assertIsNone(result["local"][3]["p"])

    def check_null(self, exact, observed, simulated, core_p):
        expected = sum(exact) / len(exact)
        distance = abs(observed - expected)
        exact_p = sum(abs(value - expected) >= distance for value in exact) / len(exact)
        # Validate the reference draws as well as re-scoring them with the
        # declared tail. The common rounding groups mathematical ties.
        rounded_exact = np.round(np.array(exact, dtype=float), 12)
        support = np.unique(rounded_exact)
        simulated = np.round(simulated, 12)
        assert_array_equal(np.unique(simulated), support)
        for value in support:
            self.assertAlmostEqual(np.mean(simulated == value), np.mean(rounded_exact == value), delta=0.035)
        extreme_support = [
            round(float(value), 12)
            for value in set(exact)
            if abs(value - expected) >= distance
        ]
        py_sal_rescored = (np.count_nonzero(np.isin(simulated, extreme_support)) + 1) / (len(simulated) + 1)
        self.assertAlmostEqual(py_sal_rescored, exact_p, delta=0.035)
        self.assertAlmostEqual(core_p, exact_p, delta=0.035)
        self.assertAlmostEqual(core_p, py_sal_rescored, delta=0.035)
