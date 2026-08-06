from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import patch

import aic_sdk
import numpy as np
import pytest

from livekit import rtc
from livekit.plugins.ai_coustics import AudioEnhancement, ModelParameters


@dataclass
class FakeContext:
    parameters: list[tuple[object, float]] = field(default_factory=list)

    def set_parameter(self, parameter: object, value: float) -> None:
        self.parameters.append((parameter, value))


class FakeCore:
    instances: list[FakeCore] = []

    def __init__(
        self,
        *,
        model: object,
        license_key: str,
        otel_config: object | None = None,
    ) -> None:
        self.model = model
        self.license_key = license_key
        self.otel_config = otel_config
        self.context = FakeContext()
        self.validate_count = 0
        self.inits: list[tuple[int, int, int]] = []
        self.blocks: list[np.ndarray] = []
        self.reset_count = 0
        self.gain = 1.0
        self.error: Exception | None = None
        self.output_delay = 42
        self.instances.append(self)

    def validate_license(self) -> None:
        self.validate_count += 1

    def initialize(self, sample_rate: int, channels: int, frames: int) -> None:
        self.inits.append((sample_rate, channels, frames))

    def process(self, block: np.ndarray) -> np.ndarray:
        if self.error is not None:
            raise self.error
        self.blocks.append(block.copy())
        return block * self.gain

    def reset(self) -> None:
        self.reset_count += 1

    def set_parameter(self, parameter: object, value: float) -> None:
        self.context.set_parameter(parameter, value)


@pytest.fixture(autouse=True)
def fake_native_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeCore.instances.clear()
    monkeypatch.setattr(AudioEnhancement, "_core_factory", FakeCore)
    monkeypatch.setattr(
        "livekit.plugins.ai_coustics.processor.load_model",
        lambda model, **_kwargs: model,
    )


def make_frame(
    *,
    sample_rate: int = 16000,
    channels: int = 1,
    frames: int = 800,
    data: np.ndarray | None = None,
    userdata: dict[str, object] | None = None,
) -> rtc.AudioFrame:
    samples = data if data is not None else np.arange(frames * channels, dtype=np.int16)
    return rtc.AudioFrame(
        data=samples.tobytes(),
        sample_rate=sample_rate,
        num_channels=channels,
        samples_per_channel=frames,
        userdata=userdata,
    )


def create_enhancer(**kwargs: object) -> AudioEnhancement:
    return AudioEnhancement(
        model=object(),  # type: ignore[arg-type]
        license_key="test-license",
        **kwargs,  # type: ignore[arg-type]
    )


def test_validates_license_eagerly() -> None:
    create_enhancer()

    assert FakeCore.instances[0].validate_count == 1


def test_processes_one_complete_stereo_livekit_frame() -> None:
    enhancer = create_enhancer(model_parameters=ModelParameters(enhancement_level=0.75))
    pcm = np.array([1000, -1000, 2000, -2000, 3000, -3000], dtype=np.int16)
    userdata = {"source": "test"}
    output = enhancer._process(make_frame(channels=2, frames=3, data=pcm, userdata=userdata))
    core = FakeCore.instances[0]

    assert np.array_equal(np.frombuffer(output.data, dtype=np.int16), pcm)
    assert output.userdata is userdata
    assert core.inits == [(16000, 2, 3)]
    assert [block.shape for block in core.blocks] == [(2, 3)]
    assert np.array_equal(
        core.blocks[0], np.array([[1000, 2000, 3000], [-1000, -2000, -3000]]) / 32768
    )
    expected = (aic_sdk.ProcessorParameter.EnhancementLevel, 0.75)
    assert core.context.parameters.count(expected) == 2  # eager set + after format init
    assert enhancer.output_delay == 42


def test_reinitializes_when_any_frame_geometry_changes() -> None:
    enhancer = create_enhancer()
    enhancer._process(make_frame(frames=800))
    enhancer._process(make_frame(frames=800))
    enhancer._process(make_frame(frames=160))
    enhancer._process(make_frame(sample_rate=48000, frames=2400))

    assert FakeCore.instances[0].inits == [
        (16000, 1, 800),
        (16000, 1, 160),
        (48000, 1, 2400),
    ]


def test_parameter_updates_merge_validate_and_survive_reinit() -> None:
    enhancer = create_enhancer(model_parameters=ModelParameters(bypass=True))
    enhancer._process(make_frame())
    enhancer.update_model_parameters(ModelParameters(enhancement_level=0.9))
    enhancer._process(make_frame(frames=160))
    core = FakeCore.instances[0]

    assert core.context.parameters.count((aic_sdk.ProcessorParameter.Bypass, 1.0)) == 3
    assert core.context.parameters.count((aic_sdk.ProcessorParameter.EnhancementLevel, 0.9)) == 2
    with pytest.raises(ValueError, match="enhancement_level"):
        enhancer.update_model_parameters(ModelParameters(enhancement_level=1.1))


def test_disabled_processor_is_passthrough_and_reenable_resets() -> None:
    enhancer = create_enhancer()
    enhancer._process(make_frame())
    core = FakeCore.instances[0]
    before = len(core.blocks)
    frame = make_frame()

    enhancer.enabled = False
    assert enhancer._process(frame) is frame
    assert len(core.blocks) == before
    enhancer.enabled = True
    enhancer._process(frame)
    assert core.reset_count == 1


def test_processing_error_returns_original_and_deduplicates_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    enhancer = create_enhancer()
    core = FakeCore.instances[0]
    core.error = RuntimeError("boom")
    frame = make_frame()

    with caplog.at_level("ERROR", logger="livekit.plugins.ai_coustics"):
        assert enhancer._process(frame) is frame
        assert enhancer._process(frame) is frame

    assert sum("boom" in record.getMessage() for record in caplog.records) == 1


def test_close_releases_native_core() -> None:
    enhancer = create_enhancer()
    enhancer._close()

    assert enhancer.enabled is False
    with pytest.raises(RuntimeError, match="closed"):
        _ = enhancer.processor_context


def test_requires_license(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AIC_SDK_LICENSE", raising=False)
    with pytest.raises(ValueError, match="AIC_SDK_LICENSE"):
        AudioEnhancement(model=object())  # type: ignore[arg-type]


def test_model_id_download_and_path_loading() -> None:
    with (
        patch(
            "livekit.plugins.ai_coustics._model.aic_sdk.Model.download",
            return_value="/cache/model.aicmodel",
        ) as download,
        patch(
            "livekit.plugins.ai_coustics._model.aic_sdk.Model.from_file",
            return_value=object(),
        ) as from_file,
    ):
        from livekit.plugins.ai_coustics._model import load_model

        load_model("quail-vf-2.2-l-16khz", download_dir="/tmp/aic-test-models")
        download.assert_called_once_with("quail-vf-2.2-l-16khz", Path("/tmp/aic-test-models"))
        from_file.assert_called_once_with(Path("/cache/model.aicmodel"))

        download.reset_mock()
        from_file.reset_mock()
        load_model("/models/local.aicmodel")
        download.assert_not_called()
        from_file.assert_called_once_with(Path("/models/local.aicmodel"))
