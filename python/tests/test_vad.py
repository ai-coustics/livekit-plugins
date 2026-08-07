from __future__ import annotations

from collections import deque
from typing import cast

import aic_sdk
import numpy as np
import pytest

from livekit import agents, rtc
from livekit.plugins.ai_coustics import VAD, VADParameters

native_calls: list[tuple[str, int | None]] = []


class FakeModel:
    def __init__(self, *, sample_rate: int = 16000, block_size: int = 160) -> None:
        self.sample_rate = sample_rate
        self.block_size = block_size

    def get_id(self) -> str:
        return "vad-test-model"

    def get_optimal_sample_rate(self) -> int:
        return self.sample_rate

    def get_optimal_block_size(self, sample_rate: int) -> int:
        return round(self.block_size * sample_rate / self.sample_rate)


class FakeVadContext:
    def __init__(self) -> None:
        self.parameters = {
            str(aic_sdk.VadParameter.Sensitivity): 0.5,
            str(aic_sdk.VadParameter.SpeechHoldDuration): 0.25,
            str(aic_sdk.VadParameter.MinimumSpeechDuration): 0.05,
        }
        self.probability = 0.0
        self.detected = False
        self.prediction_delay_samples = 0
        self.reset_count = 0

    def set_parameter(self, parameter: aic_sdk.VadParameter, value: float) -> None:
        self.parameters[str(parameter)] = value

    def get_parameter(self, parameter: aic_sdk.VadParameter) -> float:
        return self.parameters[str(parameter)]

    def raw_vad_probability(self) -> float:
        return self.probability

    def is_speech_detected(self) -> bool:
        return self.detected

    def get_prediction_delay(self) -> int:
        return self.prediction_delay_samples

    def reset(self) -> None:
        self.probability = 0.0
        self.detected = False
        self.reset_count += 1


class FakeVadAsync:
    instances: list[FakeVadAsync] = []

    def __init__(
        self,
        model: object,
        license_key: str,
        config: aic_sdk.ProcessorConfig | None = None,
    ) -> None:
        self.model = model
        self.license_key = license_key
        self.config = config
        self.context = FakeVadContext()
        self.predictions: deque[tuple[float, bool]] = deque()
        self.blocks: list[np.ndarray] = []
        self.initialized_configs: list[aic_sdk.ProcessorConfig] = []
        self.terminate_calls = 0
        self.instances.append(self)
        native_calls.append(("vad", None))

    def get_context(self) -> FakeVadContext:
        return self.context

    async def initialize_async(self, config: aic_sdk.ProcessorConfig) -> None:
        self.config = config
        self.initialized_configs.append(config)

    async def process_async(self, block: np.ndarray) -> None:
        self.blocks.append(block.copy())
        if self.predictions:
            self.context.probability, self.context.detected = self.predictions.popleft()

    async def terminate_session_async(self) -> None:
        self.terminate_calls += 1


@pytest.fixture(autouse=True)
def fake_native_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeVadAsync.instances.clear()
    native_calls.clear()
    monkeypatch.setattr(
        "livekit.plugins.ai_coustics.vad.aic_sdk.set_sdk_id",
        lambda sdk_id: native_calls.append(("sdk_id", sdk_id)),
    )
    monkeypatch.setattr(
        "livekit.plugins.ai_coustics.vad.aic_sdk.VadAsync",
        FakeVadAsync,
    )


def create_vad(
    *,
    model: FakeModel | None = None,
    vad_parameters: VADParameters | None = None,
    **kwargs: object,
) -> VAD:
    return VAD(
        model=cast(aic_sdk.Model, model or FakeModel()),
        license_key="test-license",
        vad_parameters=vad_parameters,
        **kwargs,  # type: ignore[arg-type]
    )


def make_frame(
    data: np.ndarray,
    *,
    sample_rate: int = 16000,
    channels: int = 1,
) -> rtc.AudioFrame:
    return rtc.AudioFrame(
        data=data.tobytes(),
        sample_rate=sample_rate,
        num_channels=channels,
        samples_per_channel=data.size // channels,
    )


async def collect_events(stream: agents.vad.VADStream) -> list[agents.vad.VADEvent]:
    stream.end_input()
    return [event async for event in stream]


def test_constructs_first_native_vad_eagerly_without_an_audio_config() -> None:
    vad = create_vad(
        vad_parameters=VADParameters(
            sensitivity=0.7,
            speech_hold_duration=0.4,
            minimum_speech_duration=0.1,
        )
    )

    native = FakeVadAsync.instances[0]
    assert isinstance(vad, agents.vad.VAD)
    assert native_calls[:2] == [("sdk_id", 8), ("vad", None)]
    assert native.config is None
    assert native.context.get_parameter(aic_sdk.VadParameter.Sensitivity) == 0.7
    assert native.context.get_parameter(aic_sdk.VadParameter.SpeechHoldDuration) == 0.4
    assert native.context.get_parameter(aic_sdk.VadParameter.MinimumSpeechDuration) == 0.1
    assert vad.capabilities.update_interval == pytest.approx(0.01)
    assert vad.model == "vad-test-model"
    assert vad.provider == "ai-coustics"
    assert vad.min_silence_duration == 0.4


def test_wraps_native_vad_construction_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    sdk_error = RuntimeError("not a VAD model")

    def fail_vad(*_args: object, **_kwargs: object) -> None:
        raise sdk_error

    monkeypatch.setattr("livekit.plugins.ai_coustics.vad.aic_sdk.VadAsync", fail_vad)

    with pytest.raises(RuntimeError, match="Failed to create ai-coustics VAD") as exc_info:
        create_vad()

    assert exc_info.value.__cause__ is sdk_error


@pytest.mark.asyncio
async def test_emits_inference_and_speech_transition_events() -> None:
    vad = create_vad()
    stream = vad.stream()
    native = FakeVadAsync.instances[0]
    native.predictions.extend(
        [
            (0.1, False),
            (0.9, True),
            (0.8, True),
            (0.1, False),
        ]
    )

    stream.push_frame(make_frame(np.arange(640, dtype=np.int16)))
    events = await collect_events(stream)

    assert [event.type for event in events] == [
        agents.vad.VADEventType.INFERENCE_DONE,
        agents.vad.VADEventType.INFERENCE_DONE,
        agents.vad.VADEventType.START_OF_SPEECH,
        agents.vad.VADEventType.INFERENCE_DONE,
        agents.vad.VADEventType.INFERENCE_DONE,
        agents.vad.VADEventType.END_OF_SPEECH,
    ]
    inference_events = [
        event for event in events if event.type == agents.vad.VADEventType.INFERENCE_DONE
    ]
    assert [event.probability for event in inference_events] == [0.1, 0.9, 0.8, 0.1]
    assert [event.samples_index for event in inference_events] == [160, 320, 480, 640]
    assert inference_events[1].raw_accumulated_speech == pytest.approx(0.01)
    assert inference_events[-1].raw_accumulated_silence == pytest.approx(0.01)

    start = events[2]
    end = events[-1]
    assert start.speaking is True
    assert end.speaking is False
    assert sum(frame.samples_per_channel for frame in end.frames) == 640
    assert native.terminate_calls == 1


@pytest.mark.asyncio
async def test_aligns_events_and_candidate_audio_with_sdk_prediction_delay() -> None:
    vad = create_vad(
        vad_parameters=VADParameters(minimum_speech_duration=0.02),
        prefix_padding_duration=0.0,
    )
    stream = vad.stream()
    native = FakeVadAsync.instances[0]
    native.context.prediction_delay_samples = 320
    native.predictions.extend(
        [
            (0.1, False),
            (0.1, False),
            (0.1, False),
            (0.1, False),
            (0.1, False),
            (0.9, False),
            (0.9, True),
            (0.1, False),
        ]
    )
    samples = np.concatenate([np.full(160, index, dtype=np.int16) for index in range(1, 9)])

    stream.push_frame(make_frame(samples))
    events = await collect_events(stream)

    start = next(event for event in events if event.type == agents.vad.VADEventType.START_OF_SPEECH)
    end = next(event for event in events if event.type == agents.vad.VADEventType.END_OF_SPEECH)
    assert start.timestamp == pytest.approx(0.07)
    assert start.speech_duration == pytest.approx(0.04)
    assert start.raw_accumulated_speech == pytest.approx(0.04)
    assert start.timestamp - start.speech_duration == pytest.approx(0.03)
    assert [int(np.frombuffer(frame.data, dtype=np.int16)[0]) for frame in start.frames] == [
        4,
        5,
        6,
        7,
    ]
    assert end.timestamp == pytest.approx(0.08)
    assert end.silence_duration == pytest.approx(0.03)
    assert end.speech_duration == pytest.approx(0.02)
    assert end.raw_accumulated_silence == pytest.approx(0.03)


@pytest.mark.asyncio
async def test_downmixes_stereo_and_reblocks_for_the_sdk() -> None:
    vad = create_vad(model=FakeModel(block_size=4))
    stream = vad.stream()
    native = FakeVadAsync.instances[0]
    native.predictions.append((0.0, False))
    stereo = np.array([1000, 3000, 2000, 4000, 3000, 5000, 4000, 6000], dtype=np.int16)

    stream.push_frame(make_frame(stereo, channels=2))
    events = await collect_events(stream)

    assert len(native.blocks) == 1
    assert np.array_equal(
        native.blocks[0],
        np.array([2000, 3000, 4000, 5000], dtype=np.float32) / 32768,
    )
    assert len(events) == 1
    assert events[0].frames[0].num_channels == 1


@pytest.mark.asyncio
async def test_uses_input_sample_rate_without_plugin_resampling() -> None:
    vad = create_vad(model=FakeModel(sample_rate=16000, block_size=160))
    stream = vad.stream()
    native = FakeVadAsync.instances[0]
    native.predictions.append((0.0, False))
    input_samples = np.arange(480, dtype=np.int16)

    stream.push_frame(make_frame(input_samples, sample_rate=48000))
    events = await collect_events(stream)

    assert len(native.initialized_configs) == 1
    config = native.initialized_configs[0]
    assert config.sample_rate == 48000
    assert config.block_size == 480
    assert config.variable_block_size is False
    assert len(native.blocks) == 1
    assert np.array_equal(native.blocks[0], input_samples.astype(np.float32) / 32768)
    assert events[0].frames[0].sample_rate == 48000
    assert np.array_equal(
        np.frombuffer(events[0].frames[0].data, dtype=np.int16),
        input_samples,
    )


@pytest.mark.asyncio
async def test_flush_resets_state_and_discards_an_incomplete_block() -> None:
    vad = create_vad(model=FakeModel(block_size=4))
    stream = vad.stream()
    native = FakeVadAsync.instances[0]
    native.predictions.append((0.0, False))

    stream.push_frame(make_frame(np.array([1, 2], dtype=np.int16)))
    stream.flush()
    stream.push_frame(make_frame(np.array([3, 4, 5, 6], dtype=np.int16)))
    await collect_events(stream)

    assert len(native.blocks) == 1
    assert np.array_equal(native.blocks[0], np.array([3, 4, 5, 6]) / 32768)
    assert native.context.reset_count == 2  # explicit flush plus end_input's boundary


@pytest.mark.asyncio
async def test_parameter_updates_reach_active_and_future_streams() -> None:
    vad = create_vad()
    first_stream = vad.stream()
    first_native = FakeVadAsync.instances[0]

    vad.set_parameters(VADParameters(sensitivity=0.8, speech_hold_duration=0.6))
    second_stream = vad.stream()
    second_native = FakeVadAsync.instances[1]

    for native in (first_native, second_native):
        assert native.context.get_parameter(aic_sdk.VadParameter.Sensitivity) == 0.8
        assert native.context.get_parameter(aic_sdk.VadParameter.SpeechHoldDuration) == 0.6
    assert vad.min_silence_duration == 0.6

    await collect_events(first_stream)
    await collect_events(second_stream)


@pytest.mark.asyncio
async def test_immediate_close_terminates_native_session_once() -> None:
    vad = create_vad()
    stream = vad.stream()
    native = FakeVadAsync.instances[0]

    await stream.aclose()
    await stream.aclose()

    assert native.terminate_calls == 1


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"prefix_padding_duration": -0.1}, "prefix_padding_duration"),
        ({"max_buffered_speech": 0.0}, "max_buffered_speech"),
    ],
)
def test_validates_buffer_options(kwargs: dict[str, float], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        create_vad(**kwargs)
