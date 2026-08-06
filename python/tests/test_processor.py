from __future__ import annotations

from unittest.mock import patch

import aic_sdk
import numpy as np
import pytest

from livekit import rtc
from livekit.plugins.ai_coustics import AudioEnhancement


class FakeConfig:
    def __init__(self, num_frames: int = 2) -> None:
        self.num_frames = num_frames


class FakeContext:
    def __init__(self) -> None:
        self.parameters: list[tuple[object, float]] = []
        self.reset_count = 0

    def set_parameter(self, parameter: object, value: float) -> None:
        self.parameters.append((parameter, value))

    def get_output_delay(self) -> int:
        return 42

    def reset(self) -> None:
        self.reset_count += 1


class FakeProcessor:
    def __init__(self) -> None:
        self.context = FakeContext()
        self.configs: list[FakeConfig] = []
        self.blocks: list[np.ndarray] = []

    def get_processor_context(self) -> FakeContext:
        return self.context

    def initialize(self, config: FakeConfig) -> None:
        self.configs.append(config)

    def process(self, block: np.ndarray) -> np.ndarray:
        self.blocks.append(block.copy())
        return block.copy()


@pytest.fixture
def enhancer() -> tuple[AudioEnhancement, FakeProcessor, FakeContext, list[dict[str, object]]]:
    processor = FakeProcessor()
    optimal_calls: list[dict[str, object]] = []

    def optimal(_model: object, **kwargs: object) -> FakeConfig:
        optimal_calls.append(kwargs)
        return FakeConfig()

    with (
        patch("livekit.plugins.ai_coustics.processor.aic_sdk.Processor", return_value=processor),
        patch(
            "livekit.plugins.ai_coustics.processor.aic_sdk.ProcessorConfig.optimal",
            side_effect=optimal,
        ),
    ):
        instance = AudioEnhancement(
            model=object(),  # type: ignore[arg-type]
            license_key="test-license",
            enhancement_level=0.75,
        )
        yield instance, processor, processor.context, optimal_calls


def test_processes_interleaved_audio_in_optimal_blocks(
    enhancer: tuple[AudioEnhancement, FakeProcessor, FakeContext, list[dict[str, object]]],
) -> None:
    instance, processor, context, optimal_calls = enhancer
    pcm = np.array([1000, -1000, 2000, -2000, 3000, -3000], dtype=np.int16)
    userdata = {"source": "test"}
    frame = rtc.AudioFrame(
        data=pcm.tobytes(),
        sample_rate=48000,
        num_channels=2,
        samples_per_channel=3,
        userdata=userdata,
    )

    output = instance._process(frame)

    assert np.array_equal(np.frombuffer(output.data, dtype=np.int16), pcm)
    assert output.userdata is userdata
    assert [block.shape for block in processor.blocks] == [(2, 2), (2, 1)]
    assert np.array_equal(processor.blocks[0], np.array([[1000, 2000], [-1000, -2000]]) / 32768)
    assert optimal_calls == [
        {
            "sample_rate": 48000,
            "num_channels": 2,
            "allow_variable_frames": True,
        }
    ]
    assert context.parameters == [(aic_sdk.ProcessorParameter.EnhancementLevel, 0.75)]
    assert instance.output_delay == 42


def test_reinitializes_only_when_stream_format_changes(
    enhancer: tuple[AudioEnhancement, FakeProcessor, FakeContext, list[dict[str, object]]],
) -> None:
    instance, processor, _context, optimal_calls = enhancer

    for samples_per_channel in (4, 3):
        instance._process(
            rtc.AudioFrame(
                data=np.zeros(samples_per_channel, dtype=np.int16).tobytes(),
                sample_rate=16000,
                num_channels=1,
                samples_per_channel=samples_per_channel,
            )
        )
    instance._process(
        rtc.AudioFrame(
            data=np.zeros(3, dtype=np.int16).tobytes(),
            sample_rate=48000,
            num_channels=1,
            samples_per_channel=3,
        )
    )

    assert len(processor.configs) == 2
    assert [call["sample_rate"] for call in optimal_calls] == [16000, 48000]


def test_disabled_processor_is_passthrough(
    enhancer: tuple[AudioEnhancement, FakeProcessor, FakeContext, list[dict[str, object]]],
) -> None:
    instance, processor, _context, _optimal_calls = enhancer
    frame = rtc.AudioFrame(
        data=b"\x00\x00", sample_rate=16000, num_channels=1, samples_per_channel=1
    )
    instance.enabled = False

    assert instance._process(frame) is frame
    assert processor.blocks == []


def test_close_resets_initialized_processor(
    enhancer: tuple[AudioEnhancement, FakeProcessor, FakeContext, list[dict[str, object]]],
) -> None:
    instance, _processor, context, _optimal_calls = enhancer
    frame = rtc.AudioFrame(
        data=b"\x00\x00", sample_rate=16000, num_channels=1, samples_per_channel=1
    )
    instance._process(frame)

    instance._close()

    assert context.reset_count == 1


def test_requires_license(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AIC_SDK_LICENSE", raising=False)
    with pytest.raises(ValueError, match="AIC_SDK_LICENSE"):
        AudioEnhancement(model=object())  # type: ignore[arg-type]
