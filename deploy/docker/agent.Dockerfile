FROM python:3.12.13-slim-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.11.26 /uv /bin/uv
WORKDIR /app/agent_service
ENV UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/agent_service/.venv/bin:$PATH"
COPY agent_service/pyproject.toml agent_service/uv.lock ./
RUN uv sync --locked --no-dev && useradd --uid 1000 --create-home geocsv
COPY --chown=geocsv:geocsv agent_service/contracts.py agent_service/planner.py agent_service/main.py ./
USER geocsv
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8100"]
