"""Submit a Moran/LISA plan to GeoCSV and read the archived result."""

import argparse
import json
from time import monotonic, sleep
from urllib.error import URLError
from urllib.request import Request, urlopen
from uuid import uuid4


def api(base, path, body=None, key=None, timeout=10):
    headers = {"Content-Type": "application/json"} if body is not None else {}
    if key is not None:
        headers["Idempotency-Key"] = key
    data = json.dumps(body).encode() if body is not None else None
    with urlopen(Request(base + path, data=data, headers=headers), timeout=timeout) as response:
        return json.load(response)["data"]


def submit(base, plan, simulate_timeout):
    confirmation = {"planId": plan["id"], "planVersion": plan["version"]}
    key = str(uuid4())
    for attempt in range(3):
        try:
            timeout = 0.00001 if attempt == 0 and simulate_timeout else 10
            return api(base, "/runs", confirmation, key=key, timeout=timeout)
        except (TimeoutError, URLError) as error:
            cause = error.reason if isinstance(error, URLError) else error
            if not isinstance(cause, TimeoutError) or attempt == 2:
                raise
            print("提交等待超时。使用同一个计划和请求键重试。", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file_id")
    parser.add_argument("value_field")
    parser.add_argument("--api", default="http://127.0.0.1:3000/api")
    parser.add_argument("--contiguity", choices=["queen", "rook"], required=True)
    parser.add_argument("--simulate-timeout", action="store_true")
    args = parser.parse_args()
    base = args.api.rstrip("/")
    plan = api(base, "/analysis/plans", {"spec": {
        "schemaVersion": 1, "kind": "spatial_autocorrelation", "operatorVersion": 2,
        "target": {"fileId": args.file_id, "valueField": args.value_field},
        "contiguity": args.contiguity,
    }})
    run = submit(base, plan, args.simulate_timeout)
    deadline = monotonic() + 180
    while run["status"] in {"queued", "running"}:
        if monotonic() > deadline:
            raise SystemExit(f"等待截止。可继续查询 Run {run['id']}")
        sleep(0.5)
        run = api(base, f"/runs/{run['id']}")
    if run["status"] != "succeeded":
        raise SystemExit(f"Run {run['id']} {run['status']} {run['errorCode'] or ''} {run['error'] or ''}")
    path = f"/artifacts/{run['artifactId']}"
    print(json.dumps({"run": run, "artifact": api(base, path), "page": api(base, path + "/rows")},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
