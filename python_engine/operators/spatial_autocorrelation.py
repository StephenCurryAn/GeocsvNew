"""Offline Moran/LISA operator with explicit contiguity and inference rules."""

from numbers import Integral, Real

import geopandas as gpd
import numpy as np
import shapely


ALGORITHM_VERSION = "moran-lisa/2.0.0"


def _finite_value(value):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (Real, str)):
        return np.nan
    try:
        return float(value)
    except (ValueError, OverflowError):
        return np.nan


def _contiguity_edges(layer, contiguity):
    # The spatial index returns sorted pairs of row positions. A polygon does
    # not touch itself. Touches excludes any pair with intersecting interiors.
    geometries = layer.geometry.array
    sources, targets = layer.sindex.query(geometries, predicate="touches", sort=True)
    if contiguity == "rook":
        boundaries = shapely.boundary(geometries)
        shared_boundary = shapely.intersection(boundaries[sources], boundaries[targets])
        shared_edge = shapely.length(shared_boundary) > 0
        sources, targets = sources[shared_edge], targets[shared_edge]
    return sources, targets


def _as_extreme(simulated, observed, expected):
    simulated_distance = np.abs(simulated - expected)
    observed_distance = np.abs(observed - expected)
    tied = np.isclose(simulated_distance, observed_distance, rtol=1e-12, atol=1e-15)
    return (simulated_distance > observed_distance) | tied


def _permutation_p_values(
    z, sources, targets, degrees, weights, global_scale, local_scale,
    global_i, local_i, global_expected, local_expected, permutations, seed,
):
    n = len(z)
    global_rng, local_rng = np.random.default_rng(seed).spawn(2)
    global_count = 0
    local_counts = np.zeros(n, dtype=np.int64)
    starts = np.cumsum(degrees) - degrees
    neighbor_slots = np.arange(len(sources)) - starts[sources]
    max_degree = int(degrees.max())
    for _ in range(permutations):
        shuffled = global_rng.permutation(z)
        permuted_lag = np.bincount(sources, weights * shuffled[targets], minlength=n)
        global_draw = global_scale * (shuffled @ permuted_lag)
        global_count += int(_as_extreme(global_draw, global_i, global_expected))

        # Each row gets a uniform prefix of ranks in its n-1 eligible values.
        # Skip the focal position when mapping ranks back into the full array.
        ranks = local_rng.choice(n - 1, max_degree, replace=False)[neighbor_slots]
        sampled_z = z[ranks + (ranks >= sources)]
        conditional_lag = np.bincount(sources, weights * sampled_z, minlength=n)
        local_counts += _as_extreme(local_scale * conditional_lag, local_i, local_expected)

    return (global_count + 1) / (permutations + 1), (local_counts + 1) / (permutations + 1)


def _quadrant(z, lag):
    if z == 0 or lag == 0:
        return None
    return ("H" if z > 0 else "L") + ("H" if lag > 0 else "L")


def compute_moran_lisa(
    layer: gpd.GeoDataFrame,
    value_column: str,
    *,
    contiguity: str = "queen",
    permutations: int = 199,
    seed: int = 42,
) -> dict:
    """Evaluate a polygon snapshot with unique string IDs in its 'id' column."""
    if contiguity not in ("queen", "rook"):
        raise ValueError("contiguity must be 'queen' or 'rook'")
    for name, value in (("permutations", permutations), ("seed", seed)):
        if isinstance(value, bool) or not isinstance(value, Integral) or value < 0:
            raise ValueError(f"{name} must be a non-negative integer")
    permutations, seed = int(permutations), int(seed)
    if layer.active_geometry_name is None:
        raise ValueError("the layer must have an active polygon geometry column")
    crs = layer.crs
    if crs is None or len(crs.axis_info) != 2 or not (crs.is_geographic or crs.is_projected):
        raise ValueError("a two-dimensional geographic or projected CRS is required")
    if not layer.columns.is_unique or value_column not in layer.columns:
        raise ValueError("columns must have unique names and include the value column")
    if "id" not in layer or not all(isinstance(fid, str) and fid.strip() for fid in layer["id"]):
        raise ValueError("feature IDs must be non-empty strings")
    if not layer["id"].is_unique:
        raise ValueError("feature IDs must be unique")

    geometry = layer.geometry
    if (
        not geometry.geom_type.isin(["Polygon", "MultiPolygon"]).all()
        or geometry.is_empty.any()
        or (shapely.get_coordinate_dimension(geometry.array) != 2).any()
        or not np.isfinite(shapely.get_coordinates(geometry.array)).all()
        or not geometry.is_valid.all()
    ):
        raise ValueError("each feature must have a valid, non-empty, finite 2D polygon or multipolygon")

    ordered = layer.sort_values("id")
    values = np.array([_finite_value(value) for value in ordered[value_column]], dtype=np.float64)
    finite = np.isfinite(values)
    retained = ordered.iloc[finite]
    ids = retained["id"].tolist()
    n = len(ids)
    if n < 3:
        raise ValueError("at least three finite values are required")

    values = values[finite]
    # Binary scaling keeps finite extreme magnitudes safe when squaring.
    _, exponent = np.frexp(np.max(np.abs(values)))
    centered = np.ldexp(values, -int(exponent))
    centered -= centered.mean()
    # Remove the rounding residual when values have a large common offset.
    centered -= centered.mean()
    sum_squares = centered @ centered
    if sum_squares == 0:
        raise ValueError("the value column is constant among retained features")
    z = centered / np.sqrt(sum_squares / n)

    sources, targets = _contiguity_edges(retained, contiguity)
    degrees = np.bincount(sources, minlength=n)
    s0 = int(np.count_nonzero(degrees))
    if s0 == 0:
        raise ValueError("all features are islands under the selected contiguity")
    weights = 1.0 / degrees[sources]
    lag = np.bincount(sources, weights * z[targets], minlength=n)
    denominator = z @ z
    global_scale = (n / s0) / denominator
    local_scale = (n - 1) * z / denominator
    global_i = global_scale * (z @ lag)
    local_i = local_scale * lag
    global_expected = -1.0 / (n - 1)
    local_expected = np.where(degrees > 0, -z**2 / denominator, 0.0)

    global_p, local_p = None, None
    if permutations:
        global_p, local_p = _permutation_p_values(
            z, sources, targets, degrees, weights, global_scale, local_scale,
            global_i, local_i, global_expected, local_expected, permutations, seed,
        )

    return {
        "algorithm_version": ALGORITHM_VERSION,
        "value_column": value_column,
        "crs": crs.to_string(),
        "contiguity": contiguity,
        "permutations": permutations,
        "seed": seed,
        "excluded_value_ids": ordered.iloc[~finite]["id"].tolist(),
        "s0": s0,
        "global_i": float(global_i),
        "global_expected_i": global_expected,
        "global_p": global_p,
        "local": [
            {
                "id": fid,
                "i": float(local_i[i]),
                "expected_i": float(local_expected[i]),
                "z": float(z[i]),
                "lag_z": float(lag[i]),
                "neighbor_count": int(degrees[i]),
                "p": float(local_p[i]) if local_p is not None and degrees[i] else None,
                "quadrant": _quadrant(z[i], lag[i]),
            }
            for i, fid in enumerate(ids)
        ],
    }
