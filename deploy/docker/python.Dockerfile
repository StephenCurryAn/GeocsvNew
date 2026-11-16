FROM python:3.12.13-slim-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.11.26 /uv /bin/uv
WORKDIR /app/python_engine
ENV UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/python_engine/.venv/bin:$PATH"
COPY python_engine/pyproject.toml python_engine/uv.lock python_engine/.python-version ./
RUN uv sync --locked --no-dev && useradd --uid 1000 --create-home geocsv
COPY --chown=geocsv:geocsv python_engine/ ./
USER geocsv
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
