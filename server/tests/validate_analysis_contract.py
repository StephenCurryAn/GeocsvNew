import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker


contracts = Path(__file__).resolve().parents[2] / "docs" / "contracts"
schema = json.loads((contracts / "analysis.schema.json").read_text(encoding="utf-8"))
examples = json.loads((contracts / "analysis.examples.json").read_text(encoding="utf-8"))
Draft202012Validator.check_schema(schema)

for name, example in examples.items():
    validator = Draft202012Validator(
        {"$defs": schema["$defs"], "$ref": f"#/$defs/{name}"},
        format_checker=FormatChecker(),
    )
    validator.validate(example)

pivot = Draft202012Validator({"$defs": schema["$defs"], "$ref": "#/$defs/SpatialPivotSpec"})
spec = examples["SpatialPivotSpec"]
assert not pivot.is_valid({**spec, "boundaryPolicy": "guess"})
assert not pivot.is_valid({**spec, "unexpected": True})
print(f"{len(examples)} contract examples and 2 invalid specs checked")
