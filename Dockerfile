# Live REST API (default) or MCP server for the military anthropometry data.
#   docker build -t anthro-api .
#   docker run -p 8000:8000 anthro-api                                   REST on :8000, docs at /docs
#   docker run -p 8001:8001 anthro-api mcp --transport streamable-http --host 0.0.0.0 --port 8001
# Environment: ANTHRO_API_KEYS (comma separated; enables key checking), ANTHRO_CORS_ORIGINS.
FROM python:3.12-slim
WORKDIR /app
COPY anthro_service/requirements.txt anthro_service/requirements.txt
RUN pip install --no-cache-dir -r anthro_service/requirements.txt
COPY anthro_service anthro_service
COPY aggregates/rollup.csv aggregates/aggregates.csv aggregates/official_documents.csv aggregates/
COPY database/harmonized_measures.csv database/
COPY catalog/surveys.csv catalog/papers.csv catalog/
ENV ANTHRO_DATA_DIR=/app
EXPOSE 8000
ENTRYPOINT ["python", "-m", "anthro_service"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8000"]
