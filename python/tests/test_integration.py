from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest

from livekit import agents, rtc
from livekit.plugins import ai_coustics

pytestmark = pytest.mark.integration

LICENSE = os.getenv("AIC_SDK_LICENSE")
MODEL_ID = os.getenv("AIC_INTEGRATION_MODEL_ID", "quail-vf-2.2-s-16khz")
VAD_MODEL_ID = os.getenv("AIC_INTEGRATION_VAD_MODEL_ID", "vad-2.1-xxs-16khz")
MODEL_DIR = Path(os.getenv("AIC_INTEGRATION_MODEL_DIR", "~/.cache/aic-sdk/models")).expanduser()
SAMPLE_RATE = 16000
SAMPLES_PER_FRAME = 800  # LiveKit Agents' current 50 ms default input frame.


def _frame(
    index: int,
    *,
    channels: int = 1,
    data: np.ndarray | None = None,
) -> rtc.AudioFrame:
    if data is None:
        rng = np.random.default_rng(index + 7)
        offset = index * SAMPLES_PER_FRAME
        t = (np.arange(SAMPLES_PER_FRAME) + offset) / SAMPLE_RATE
        voice = 0.3 * np.sin(2 * np.pi * 220 * t)
        noise = 0.1 * rng.standard_normal(SAMPLES_PER_FRAME)
        mono = np.clip((voice + noise) * 32768, -32768, 32767).astype(np.int16)
    else:
        mono = data
    data = np.repeat(mono, channels) if channels > 1 else mono
    return rtc.AudioFrame(
        data=data.tobytes(),
        sample_rate=SAMPLE_RATE,
        num_channels=channels,
        samples_per_channel=SAMPLES_PER_FRAME,
    )


@pytest.fixture(scope="module")
def model() -> ai_coustics.Model:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    model_path = ai_coustics.Model.download(MODEL_ID, MODEL_DIR)
    return ai_coustics.Model.from_file(model_path)


@pytest.fixture(scope="module")
def vad_model() -> ai_coustics.Model:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    model_path = ai_coustics.Model.download(VAD_MODEL_ID, MODEL_DIR)
    return ai_coustics.Model.from_file(model_path)


@pytest.mark.skipif(not LICENSE, reason="AIC_SDK_LICENSE is required")
def test_real_processor_with_downloaded_model_and_fifty_ms_frames(
    model: ai_coustics.Model,
) -> None:
    enhancer = ai_coustics.Processor(model=model)
    outputs = [enhancer._process(_frame(index)) for index in range(40)]

    assert all(output.samples_per_channel == SAMPLES_PER_FRAME for output in outputs)
    assert all(output.sample_rate == SAMPLE_RATE for output in outputs)
    inputs = np.concatenate(
        [np.frombuffer(_frame(index).data, dtype=np.int16) for index in range(20, 40)]
    )
    enhanced = np.concatenate(
        [np.frombuffer(output.data, dtype=np.int16) for output in outputs[20:]]
    )
    assert not np.array_equal(enhanced, inputs)


@pytest.mark.skipif(not LICENSE, reason="AIC_SDK_LICENSE is required")
def test_real_processor_stereo_and_runtime_parameters(model: ai_coustics.Model) -> None:
    enhancer = ai_coustics.Processor(
        model=model,
        processor_parameters=ai_coustics.ProcessorParameters(bypass=True),
    )
    output = enhancer._process(_frame(0, channels=2))
    enhancer.set_parameters(ai_coustics.ProcessorParameters(bypass=False))

    assert output.num_channels == 2
    assert output.samples_per_channel == SAMPLES_PER_FRAME
    channels = np.frombuffer(output.data, dtype=np.int16).reshape(SAMPLES_PER_FRAME, 2)
    assert np.array_equal(channels[:, 0], channels[:, 1])


@pytest.mark.skipif(not LICENSE, reason="AIC_SDK_LICENSE is required")
@pytest.mark.asyncio
async def test_real_vad_stream_emits_livekit_inference_events(
    vad_model: ai_coustics.Model,
) -> None:
    detector = ai_coustics.VAD(
        model=vad_model,
        vad_parameters=ai_coustics.VADParameters(sensitivity=0.5),
    )
    stream = detector.stream()
    silence = np.zeros(SAMPLES_PER_FRAME, dtype=np.int16)
    for _ in range(10):
        stream.push_frame(_frame(0, data=silence))
    stream.end_input()

    events = [event async for event in stream]
    inference_events = [
        event for event in events if event.type == agents.vad.VADEventType.INFERENCE_DONE
    ]

    assert inference_events
    assert all(0.0 <= event.probability <= 1.0 for event in inference_events)
    assert all(event.frames[0].num_channels == 1 for event in inference_events)
