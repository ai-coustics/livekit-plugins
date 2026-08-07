from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import cast
from unittest.mock import patch

import aic_sdk
import numpy as np
import pytest

from livekit import rtc
from livekit.plugins.ai_coustics import Model, Processor, ProcessorParameters

native_calls: list[tuple[str, int | None]] = []


class FakeModel:
    def get_id(self) -> str:
        return "test-model"


@dataclass
class FakeContext:
    parameters: list[tuple[object, float]] = field(default_factory=list)
    reset_count: int = 0

    def set_parameter(self, parameter: object, value: float) -> None:
        self.parameters.append((parameter, value))

    def get_audio_delay(self) -> int:
        return 42

    def reset(self) -> None:
        self.reset_count += 1


class FakeProcessor:
    instances: list[FakeProcessor] = []

    def __init__(
        self,
        model: object,
        license_key: str,
    ) -> None:
        self.model = model
        self.license_key = license_key
        self.context = FakeContext()
        self.inits: list[tuple[int, int, int]] = []
        self.blocks: list[np.ndarray] = []
        self.gain = 1.0
        self.error: Exception | None = None
        self.terminate_calls = 0
        self.instances.append(self)
        native_calls.append(("processor", None))

    def get_context(self) -> FakeContext:
        return self.context

    def initialize(self, config: aic_sdk.ProcessorConfig) -> None:
        self.inits.append((config.sample_rate, config.block_size, config.variable_block_size))

    def process(self, block: np.ndarray) -> np.ndarray:
        if self.error is not None:
            raise self.error
        self.blocks.append(block.copy())
        return block * self.gain

    def terminate_session(self) -> None:
        self.terminate_calls += 1


@pytest.fixture(autouse=True)
def fake_native_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeProcessor.instances.clear()
    native_calls.clear()
    monkeypatch.setattr(
        "livekit.plugins.ai_coustics.processor.aic_sdk.set_sdk_id",
        lambda sdk_id: native_calls.append(("sdk_id", sdk_id)),
    )
    monkeypatch.setattr(
        "livekit.plugins.ai_coustics.processor.aic_sdk.Processor",
        FakeProcessor,
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


def create_enhancer(**kwargs: object) -> Processor:
    return Processor(
        model=cast(aic_sdk.Model, FakeModel()),
        license_key="test-license",
        **kwargs,  # type: ignore[arg-type]
    )


def test_constructs_processor_without_probe_frame() -> None:
    create_enhancer()

    processor = FakeProcessor.instances[0]
    assert native_calls[:2] == [("sdk_id", 8), ("processor", None)]
    assert processor.inits == []
    assert processor.blocks == []
    assert processor.context.reset_count == 0


def test_wraps_processor_construction_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    sdk_error = RuntimeError("invalid license format")

    def fail_processor(*_args: object, **_kwargs: object) -> None:
        raise sdk_error

    monkeypatch.setattr(
        "livekit.plugins.ai_coustics.processor.aic_sdk.Processor",
        fail_processor,
    )

    with pytest.raises(RuntimeError, match="Failed to create ai-coustics Processor") as exc_info:
        create_enhancer()

    assert exc_info.value.__cause__ is sdk_error


def test_downmixes_stereo_for_sdk_and_preserves_livekit_frame_geometry() -> None:
    enhancer = create_enhancer(processor_parameters=ProcessorParameters(enhancement_level=0.75))
    pcm = np.array([1000, 3000, 2000, 4000, 3000, 5000], dtype=np.int16)
    userdata = {"source": "test"}
    output = enhancer._process(make_frame(channels=2, frames=3, data=pcm, userdata=userdata))
    processor = FakeProcessor.instances[0]

    assert np.array_equal(
        np.frombuffer(output.data, dtype=np.int16),
        np.array([2000, 2000, 3000, 3000, 4000, 4000], dtype=np.int16),
    )
    assert output.userdata is userdata
    assert processor.inits == [(16000, 3, False)]
    assert [block.shape for block in processor.blocks] == [(3,)]
    assert np.array_equal(
        processor.blocks[-1],
        np.array([2000, 3000, 4000], dtype=np.float32) / 32768,
    )
    expected = (aic_sdk.ProcessorParameter.EnhancementLevel, 0.75)
    assert processor.context.parameters.count(expected) == 1


def test_reinitializes_when_any_frame_geometry_changes() -> None:
    enhancer = create_enhancer()
    enhancer._process(make_frame(frames=800))
    enhancer._process(make_frame(frames=800))
    enhancer._process(make_frame(frames=160))
    enhancer._process(make_frame(sample_rate=48000, frames=2400))

    assert FakeProcessor.instances[0].inits == [
        (16000, 800, False),
        (16000, 160, False),
        (48000, 2400, False),
    ]


def test_parameter_updates_validate_and_are_not_reapplied() -> None:
    enhancer = create_enhancer(processor_parameters=ProcessorParameters(bypass=True))
    enhancer._process(make_frame())
    enhancer.set_parameters(ProcessorParameters(enhancement_level=0.9))
    enhancer._process(make_frame(frames=160))
    processor = FakeProcessor.instances[0]

    assert processor.context.parameters.count((aic_sdk.ProcessorParameter.Bypass, 1.0)) == 1
    assert (
        processor.context.parameters.count((aic_sdk.ProcessorParameter.EnhancementLevel, 0.9)) == 1
    )
    with pytest.raises(ValueError, match="enhancement_level"):
        enhancer.set_parameters(ProcessorParameters(enhancement_level=1.1))


def test_disabled_processor_is_passthrough_and_reenable_resets_immediately() -> None:
    enhancer = create_enhancer()
    enhancer._process(make_frame())
    processor = FakeProcessor.instances[0]
    before = len(processor.blocks)
    frame = make_frame()

    enhancer.enabled = False
    assert enhancer._process(frame) is frame
    assert len(processor.blocks) == before
    enhancer.enabled = True
    assert processor.context.reset_count == 1
    enhancer._process(frame)


def test_processing_error_is_structured_rate_limited_and_reports_recovery(
    caplog: pytest.LogCaptureFixture,
) -> None:
    enhancer = create_enhancer()
    processor = FakeProcessor.instances[0]
    processor.error = RuntimeError("boom")
    frame = make_frame()

    with caplog.at_level("ERROR", logger="livekit.plugins.ai_coustics"):
        assert enhancer._process(frame) is frame
        assert enhancer._process(frame) is frame

    failures = [
        record
        for record in caplog.records
        if "failed; passing audio through" in record.getMessage()
    ]
    assert len(failures) == 1
    assert failures[0].processing_stage == "process"
    assert failures[0].error_message == "boom"
    assert failures[0].model_name == "test-model"
    assert failures[0].exc_info is not None

    processor.error = None
    with caplog.at_level("INFO", logger="livekit.plugins.ai_coustics"):
        enhancer._process(frame)
    recovery = next(
        record for record in caplog.records if "Processor recovered" in record.getMessage()
    )
    assert recovery.recovered_failure_count == 2
    assert recovery.failed_frame_count == 2


def test_stream_context_is_added_to_logs_and_resets_between_publications(
    caplog: pytest.LogCaptureFixture,
) -> None:
    enhancer = create_enhancer()
    processor = FakeProcessor.instances[0]

    enhancer._on_stream_info_updated(
        room_name="diagnostic-room",
        participant_identity="caller",
        publication_sid="TR_first",
    )
    with caplog.at_level("INFO", logger="livekit.plugins.ai_coustics"):
        enhancer._process(make_frame())

    initialized = next(
        record for record in caplog.records if "Processor initialized" in record.getMessage()
    )
    assert initialized.room_name == "diagnostic-room"
    assert initialized.participant_identity == "caller"
    assert initialized.publication_sid == "TR_first"
    assert initialized.audio_delay_samples == 42
    assert initialized.audio_delay == pytest.approx(42 / 16000)

    enhancer._on_stream_info_updated(
        room_name="diagnostic-room",
        participant_identity="caller",
        publication_sid="TR_second",
    )
    enhancer._on_stream_info_cleared()
    assert processor.context.reset_count == 2


def test_warns_immediately_for_cumulative_processing_backlog(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    clock = deque([0.0, 0.0, 0.0, 0.0, 0.31, 0.31])
    monkeypatch.setattr(
        "livekit.plugins.ai_coustics.processor.time.perf_counter",
        lambda: clock.popleft(),
    )
    enhancer = create_enhancer()

    with caplog.at_level("WARNING", logger="livekit.plugins.ai_coustics"):
        enhancer._process(make_frame(sample_rate=100, frames=10))

    warning = next(
        record for record in caplog.records if "falling behind realtime" in record.getMessage()
    )
    assert warning.processing_duration == pytest.approx(0.31)
    assert warning.sdk_processing_duration == pytest.approx(0.31)
    assert warning.frame_duration == pytest.approx(0.1)
    assert warning.realtime_factor == pytest.approx(3.1)
    assert warning.processing_backlog == pytest.approx(0.21)


def test_close_terminates_releases_and_reports_summary(
    caplog: pytest.LogCaptureFixture,
) -> None:
    enhancer = create_enhancer()
    processor = FakeProcessor.instances[0]
    frame = make_frame()
    enhancer._process(frame)
    with caplog.at_level("INFO", logger="livekit.plugins.ai_coustics"):
        enhancer._close()
    enhancer._close()

    assert processor.terminate_calls == 1
    assert enhancer.enabled is False
    assert enhancer._process(frame) is frame
    summary = next(
        record for record in caplog.records if record.getMessage() == "ai-coustics Processor closed"
    )
    assert summary.frame_count == 1
    assert summary.processed_frame_count == 1
    assert summary.failed_frame_count == 0
    assert summary.input_audio_duration == pytest.approx(0.05)
    assert summary.initialization_count == 1
    assert summary.audio_delay_samples == 42
    assert summary.audio_delay == pytest.approx(42 / 16000)


def test_requires_license(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AIC_SDK_LICENSE", raising=False)
    with pytest.raises(ValueError, match="AIC_SDK_LICENSE"):
        Processor(model=object())  # type: ignore[arg-type]


def test_exposes_sdk_model_download_and_file_loading() -> None:
    with (
        patch.object(
            Model,
            "download",
            return_value="/cache/model.aicmodel",
        ) as download,
        patch.object(
            Model,
            "from_file",
            return_value=object(),
        ) as from_file,
    ):
        model_path = Model.download("quail-vf-2.2-l-16khz", "/tmp/aic-test-models")
        model = Model.from_file(model_path)

        assert model is from_file.return_value
        download.assert_called_once_with("quail-vf-2.2-l-16khz", "/tmp/aic-test-models")
        from_file.assert_called_once_with("/cache/model.aicmodel")
