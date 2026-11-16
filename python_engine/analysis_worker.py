"""Execute an immutable analysis snapshot received from the Node scheduler."""

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
from tempfile import NamedTemporaryFile
from threading import Thread


def run_moran(snapshot_bytes, digest, contiguity, permutations, seed):
    if sha256(snapshot_bytes).hexdigest() != digest:
        raise ValueError("input snapshot digest mismatch")

    import geopandas as gpd
    import pandas as pd
    from shapely import from_wkb
    from operators.spatial_autocorrelation import compute_moran_lisa

    snapshot = json.loads(snapshot_bytes)
    features = snapshot["features"]
    frame = gpd.GeoDataFrame(
        {
            "id": [feature["id"] for feature in features],
            "value": pd.Series([feature["value"] for feature in features], dtype=object),
        },
        geometry=from_wkb([bytes.fromhex(feature["wkb"]) for feature in features]),
        crs=snapshot["crs"],
    )
    result = compute_moran_lisa(frame, "value", contiguity=contiguity, permutations=permutations, seed=seed)
    result["value_column"] = snapshot["valueColumn"]
    return result


def publish(path, value):
    # A crash can leave a temporary file, but readers only open the final name.
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=path.stem + "-", suffix=".json.tmp", delete=False) as file:
        temp = Path(file.name)
        try:
            json.dump(value, file, allow_nan=False, separators=(",", ":"))
            file.flush()
            os.fsync(file.fileno())
            file.close()
            os.replace(temp, path)
        finally:
            file.close()
            temp.unlink(missing_ok=True)


def stop_on_parent_exit():
    os.read(sys.stdin.fileno(), 1)
    os._exit(2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execution-id", required=True)
    parser.add_argument("--input-digest", required=True)
    parser.add_argument("--input-bytes", type=int, required=True)
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--contiguity", choices=("queen", "rook"), required=True)
    parser.add_argument("--permutations", type=int, required=True)
    parser.add_argument("--seed", type=int, required=True)
    args = parser.parse_args()

    # Load the native GIS libraries before a thread blocks on the Windows CRT pipe.
    from operators.spatial_autocorrelation import ALGORITHM_VERSION

    snapshot = sys.stdin.buffer.read(args.input_bytes)
    if len(snapshot) != args.input_bytes:
        raise ValueError("incomplete input snapshot")
    Thread(target=stop_on_parent_exit, daemon=True).start()

    outcome = {
        "executionId": args.execution_id,
        "inputDigest": args.input_digest,
        "algorithmVersion": ALGORITHM_VERSION,
        "dependencyLockDigest": sha256(Path(__file__).with_name("uv.lock").read_text(encoding="utf-8").encode()).hexdigest(),
    }
    try:
        outcome["result"] = run_moran(snapshot, args.input_digest, args.contiguity, args.permutations, args.seed)
    except ValueError as error:
        outcome["error"] = str(error)
    publish(args.result, outcome)


if __name__ == "__main__":
    main()
