from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


LayerRef = Annotated[str, StringConstraints(pattern=r"^layer_[1-9][0-9]*$")]
FieldName = Annotated[str, StringConstraints(min_length=1, max_length=255)]
Name = Annotated[str, StringConstraints(pattern=r"^[A-Za-z][A-Za-z0-9_]*$", max_length=64)]
Scalar = str | int | float | bool


class Dataset(Contract):
    ref: LayerRef
    name: Annotated[str, StringConstraints(min_length=1, max_length=255)]
    geometryTypes: list[str]
    fields: list[FieldName]
    numericFields: list[FieldName]


class OperatorRef(Contract):
    id: Name
    version: Annotated[int, Field(ge=1)]


class FieldDefinition(Contract):
    type: Literal["any", "numeric"]
    required: bool
    description: str


class InputDefinition(Contract):
    geometryTypes: list[str]
    fields: dict[Name, FieldDefinition] | None = None


class StringParameter(Contract):
    type: Literal["string"]
    enum: list[str]
    default: str
    description: str


class IntegerParameter(Contract):
    type: Literal["integer"]
    minimum: int
    maximum: int
    default: int
    description: str


class ParameterSchema(Contract):
    type: Literal["object"]
    additionalProperties: Literal[False]
    properties: dict[Name, StringParameter | IntegerParameter]


class Operator(OperatorRef):
    name: str
    aliases: list[str]
    description: str
    inputs: dict[Name, InputDefinition]
    parameterSchema: str
    planningParameters: ParameterSchema
    eligibleRefs: dict[Name, list[LayerRef]]


class PlanningHistory(Contract):
    operator: OperatorRef
    inputs: dict[Name, LayerRef]
    parameters: dict[Name, Scalar] | None = None


class PlanningRequest(Contract):
    userPrompt: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]
    datasets: Annotated[list[Dataset], Field(min_length=1, max_length=30)]
    operators: Annotated[list[Operator], Field(min_length=1, max_length=30)]
    history: PlanningHistory | None = None


class InputBinding(Contract):
    ref: LayerRef
    fields: dict[Name, FieldName]


class ReadyDraft(Contract):
    status: Literal["ready"]
    operator: OperatorRef
    inputs: dict[Name, InputBinding]
    parameters: dict[Name, Scalar]


class Clarification(Contract):
    status: Literal["clarification"]
    questions: Annotated[
        list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]],
        Field(min_length=1, max_length=5),
    ]


class Unsupported(Contract):
    status: Literal["unsupported"]
    message: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]


Draft = ReadyDraft | Clarification | Unsupported
draft_adapter = TypeAdapter(Draft)
