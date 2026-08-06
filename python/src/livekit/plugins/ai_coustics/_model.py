from __future__ import annotations

import os
from os import PathLike
from pathlib import Path
from typing import TypeAlias

import aic_sdk
import numpy as np

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


class EnhancerCore:
    """Small, testable wrapper around one SDK Processor and its context."""

    def __init__(
        self,
        *,
        model: aic_sdk.Model,
        license_key: str,
        otel_config: aic_sdk.OtelConfig | None = None,
    ) -> None:
        self._model = model
        self._processor = aic_sdk.Processor(
            model,
            license_key,
            otel_config=otel_config,
        )
        self._context = self._processor.get_processor_context()

    def validate_license(self) -> None:
        """Force model authorization before a LiveKit call begins."""

        config = aic_sdk.ProcessorConfig.optimal(self._model, num_channels=1)
        self._processor.initialize(config)
        silence = np.zeros((config.num_channels, config.num_frames), dtype=np.float32)
        self._processor.process(silence)
        self._context.reset()

    def initialize(self, sample_rate: int, num_channels: int, num_frames: int) -> None:
        self._processor.initialize(
            aic_sdk.ProcessorConfig(
                sample_rate=sample_rate,
                num_channels=num_channels,
                num_frames=num_frames,
                allow_variable_frames=False,
            )
        )

    def process(self, planar: np.ndarray) -> np.ndarray:
        return self._processor.process(planar)

    def reset(self) -> None:
        self._context.reset()

    def set_parameter(self, parameter: aic_sdk.ProcessorParameter, value: float) -> None:
        self._context.set_parameter(parameter, value)

    @property
    def context(self) -> aic_sdk.ProcessorContext:
        return self._context

    @property
    def output_delay(self) -> int:
        return self._context.get_output_delay()
