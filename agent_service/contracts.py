from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


LayerRef = Annotated[str, StringConstraints(pattern=r"^layer_[1-9][0-9]*$")]
FieldName = Annotated[str, StringConstraints(min_length=1, max_length=255)]
OperatorId = Literal["spatial_pivot", "spatial_autocorrelation"]


class Dataset(Contract):
    ref: LayerRef
    name: Annotated[str, StringConstraints(min_length=1, max_length=255)]
    geometryTypes: list[str]
    fields: list[FieldName]
    numericFields: list[FieldName]


class Operator(Contract):
    id: OperatorId
    version: int
    name: str
    inputs: dict[str, dict[Literal["geometryTypes"], list[str]]]


class PivotTarget(Contract):
    fileId: LayerRef
    labelField: FieldName | None


class PivotJoin(Contract):
    fileId: LayerRef
    categoryField: FieldName | None


class PivotSpec(Contract):
    schemaVersion: Literal[1]
    kind: Literal["spatial_pivot"]
    operatorVersion: Literal[1]
    target: PivotTarget
    join: PivotJoin
    boundaryPolicy: Literal["exclude", "include"]


class MoranTarget(Contract):
    fileId: LayerRef
    valueField: FieldName


class MoranSpec(Contract):
    schemaVersion: Literal[1]
    kind: Literal["spatial_autocorrelation"]
    operatorVersion: Literal[2]
    target: MoranTarget
    contiguity: Literal["queen", "rook"]
    permutations: Annotated[int, Field(ge=0, le=9999)]
    seed: Annotated[int, Field(ge=0, le=4294967295)]


class PlanningRequest(Contract):
    userPrompt: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]
    datasets: Annotated[list[Dataset], Field(min_length=1, max_length=30)]
    operators: Annotated[list[Operator], Field(min_length=1, max_length=2)]
    previousTarget: LayerRef | None = None
    previousPivot: PivotSpec | None = None


class View(Contract):
    chartType: Literal["bar", "line", "pie"]


class PivotDraft(Contract):
    status: Literal["ready"]
    spec: PivotSpec
    view: View
    unsupportedRequirements: Annotated[list[str], Field(max_length=0)]


class MoranDraft(Contract):
    status: Literal["ready"]
    spec: MoranSpec


class Clarification(Contract):
    status: Literal["clarification"]
    questions: Annotated[
        list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]],
        Field(min_length=1, max_length=5),
    ]


class Unsupported(Contract):
    status: Literal["unsupported"]
    message: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]


Draft = PivotDraft | MoranDraft | Clarification | Unsupported
draft_adapter = TypeAdapter(Draft)
