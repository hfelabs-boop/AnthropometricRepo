"""Military anthropometry data as a service: Python API, REST (FastAPI), MCP server and a static JSON snapshot."""
from .core import ApiError, BadRequest, NotFound, Repo, VERSION, get_repo  # noqa: F401
