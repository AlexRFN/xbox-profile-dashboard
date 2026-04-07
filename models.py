from typing import Literal

from pydantic import BaseModel, Field


class ApiError(BaseModel):
    """Standard error envelope returned by all API endpoints on failure."""
    success: bool = False
    error: str


class TrackingUpdate(BaseModel):
    status: Literal["unset", "backlog", "playing", "finished", "dropped"] | None = None
    notes: str | None = Field(None, max_length=5000)
    finished_date: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    rating: int | None = Field(None, ge=0, le=5)


class SyncResult(BaseModel):
    success: bool
    message: str
    games_updated: int = 0
    api_calls_used: int = 0
