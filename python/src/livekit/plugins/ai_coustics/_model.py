from __future__ import annotations

import os
from os import PathLike
from pathlib import Path
from typing import TypeAlias

import aic_sdk

ModelInput: TypeAlias = aic_sdk.Model | str | PathLike[str]

DEFAULT_DOWNLOAD_DIR = Path.home() / ".cache" / "aic-sdk" / "models"


def _is_model_path(value: str) -> bool:
    """Return whether a string is intended to be a local model path."""

    path = Path(value).expanduser()
    return (
        path.suffix == ".aicmodel"
        or path.is_absolute()
        or os.sep in value
        or (os.altsep is not None and os.altsep in value)
    )


def download_model(
    model_id: str,
    download_dir: str | PathLike[str] | None = None,
) -> Path:
    """Download a model ID into the SDK cache and return its resolved file path."""

    target = Path(download_dir).expanduser() if download_dir else DEFAULT_DOWNLOAD_DIR
    target.mkdir(parents=True, exist_ok=True)
    return Path(aic_sdk.Model.download(model_id, target))


def load_model(
    model: ModelInput,
    *,
    download_dir: str | PathLike[str] | None = None,
) -> aic_sdk.Model:
    """Resolve an SDK Model, local ``.aicmodel`` path, or artifact model ID."""

    if not isinstance(model, (str, PathLike)):
        return model
    if isinstance(model, PathLike) or _is_model_path(model):
        return aic_sdk.Model.from_file(Path(model).expanduser())
    return aic_sdk.Model.from_file(download_model(model, download_dir))
