from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest

from livekit import rtc
from livekit.plugins import ai_coustics

pytestmark = pytest.mark.integration

LICENSE = os.getenv("AIC_SDK_LICENSE")
MODEL_ID = os.getenv("AIC_INTEGRATION_MODEL_ID", "quail-vf-2.2-s-16khz")
MODEL_DIR = Path(os.getenv("AIC_INTEGRATION_MODEL_DIR", "~/.cache/aic-sdk/models")).expanduser()
SAMPLE_RATE = 16000
SAMPLES_PER_FRAME = 800  # LiveKit Agents' current 50 ms default input frame.


def _frame(index: int, *, channels: int = 1) -> rtc.AudioFrame:
    rng = np.random.default_rng(index + 7)
    offset = index * SAMPLES_PER_FRAME
    t = (np.arange(SAMPLES_PER_FRAME) + offset) / SAMPLE_RATE
    voice = 0.3 * np.sin(2 * np.pi * 220 * t)
    noise = 0.1 * rng.standard_normal(SAMPLES_PER_FRAME)
    mono = np.clip((voice + noise) * 32768, -32768, 32767).astype(np.int16)
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
