from __future__ import annotations

import os
from collections.abc import Iterable
from os import PathLike
from typing import TypeAlias

import aic_sdk
import numpy as np

from livekit import rtc

from .log import logger

ModelInput: TypeAlias = aic_sdk.Model | str | PathLike[str]


def _license_key(value: str | None) -> str:
    key = value or os.getenv("AIC_SDK_LICENSE")
    if not key:
        raise ValueError(
            "An ai-coustics SDK license is required. Pass license_key or set AIC_SDK_LICENSE."
        )
    return key


def _model(value: ModelInput) -> aic_sdk.Model:
    if isinstance(value, (str, PathLike)):
        return aic_sdk.Model.from_file(value)
    return value


def _pcm16_to_float32(data: memoryview) -> np.ndarray:
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


def _float32_to_pcm16(data: np.ndarray) -> bytes:
    # 1.0 cannot be represented by signed 16-bit PCM. Clamp it to 32767/32768.
    clipped = np.clip(data, -1.0, 32767.0 / 32768.0)
    return bytes(np.rint(clipped * 32768.0).astype(np.int16).tobytes())


class AudioEnhancement(rtc.FrameProcessor[rtc.AudioFrame]):
    """LiveKit audio frame processor backed by :class:`aic_sdk.Processor`.

    Model loading and license validation happen in the constructor. SDK initialization is
    deferred until the first frame because LiveKit supplies the stream's sample rate and channel
    count there.
    """

    def __init__(
        self,
        *,
        model: ModelInput,
        license_key: str | None = None,
        enhancement_level: float | None = None,
        bypass: float | None = None,
        otel_config: aic_sdk.OtelConfig | None = None,
    ) -> None:
        self._model = _model(model)
        self._license_key = _license_key(license_key)
        self._otel_config = otel_config
        self._processor = aic_sdk.Processor(
            self._model,
            self._license_key,
            otel_config=otel_config,
        )
        self._context = self._processor.get_processor_context()
        # PyO3 enums implement equality but are intentionally not hashable.
        self._parameters: list[tuple[aic_sdk.ProcessorParameter, float]] = []
        self._config: tuple[int, int] | None = None
        self._optimal_num_frames = 0
        self._enabled = True
        self._last_error_message: str | None = None

        if enhancement_level is not None:
            self.set_parameter(
                aic_sdk.ProcessorParameter.EnhancementLevel,
                enhancement_level,
            )
        if bypass is not None:
            self.set_parameter(aic_sdk.ProcessorParameter.Bypass, bypass)

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = value

    @property
    def processor_context(self) -> aic_sdk.ProcessorContext:
        """The SDK context for advanced parameter and delay access."""

        return self._context

    @property
    def output_delay(self) -> int:
        """Current SDK output delay, in samples at the configured sample rate."""

        return self._context.get_output_delay()

    def set_parameter(self, parameter: aic_sdk.ProcessorParameter, value: float) -> None:
        """Set a Processor parameter now and after future stream reconfiguration."""

        for index, (current, _current_value) in enumerate(self._parameters):
            if current == parameter:
                self._parameters[index] = (parameter, value)
                break
        else:
            self._parameters.append((parameter, value))
        if self._config is not None:
            self._context.set_parameter(parameter, value)

    def update_parameters(
        self,
        parameters: Iterable[tuple[aic_sdk.ProcessorParameter, float]],
    ) -> None:
        """Set multiple Processor parameters."""

        for parameter, value in parameters:
            self.set_parameter(parameter, value)

    def _initialize(self, sample_rate: int, num_channels: int) -> None:
        config = aic_sdk.ProcessorConfig.optimal(
            self._model,
            sample_rate=sample_rate,
            num_channels=num_channels,
            allow_variable_frames=True,
        )
        self._processor.initialize(config)
        self._config = (sample_rate, num_channels)
        self._optimal_num_frames = config.num_frames
        for parameter, value in self._parameters:
            self._context.set_parameter(parameter, value)

    def _process(self, frame: rtc.AudioFrame) -> rtc.AudioFrame:
        if not self.enabled:
            return frame

        try:
            stream_config = (frame.sample_rate, frame.num_channels)
            if self._config != stream_config:
                self._initialize(*stream_config)

            samples = _pcm16_to_float32(frame.data)
            expected_samples = frame.samples_per_channel * frame.num_channels
            if samples.size != expected_samples:
                raise ValueError(
                    f"AudioFrame contains {samples.size} samples, expected {expected_samples}"
                )

            # LiveKit audio is interleaved. The Python SDK expects channels x frames.
            planar = samples.reshape(frame.samples_per_channel, frame.num_channels).T.copy()
            processed = np.empty_like(planar)
            block_size = self._optimal_num_frames
            for start in range(0, frame.samples_per_channel, block_size):
                end = min(start + block_size, frame.samples_per_channel)
                processed[:, start:end] = self._processor.process(planar[:, start:end])

            interleaved = processed.T.reshape(-1)
            self._last_error_message = None
            return rtc.AudioFrame(
                data=_float32_to_pcm16(interleaved),
                sample_rate=frame.sample_rate,
                num_channels=frame.num_channels,
                samples_per_channel=frame.samples_per_channel,
                userdata=frame.userdata,
            )
        except Exception as error:
            self._log_error(f"ai-coustics processing failed: {error}")
            return frame

    def _log_error(self, message: str) -> None:
        if message == self._last_error_message:
            return
        self._last_error_message = message
        logger.exception(message)

    def _close(self) -> None:
        if self._config is not None:
            try:
                self._context.reset()
            except Exception as error:
                self._log_error(f"Failed to reset the ai-coustics processor: {error}")


def audio_enhancement(
    *,
    model: ModelInput,
    license_key: str | None = None,
    enhancement_level: float | None = None,
    bypass: float | None = None,
    otel_config: aic_sdk.OtelConfig | None = None,
) -> AudioEnhancement:
    """Create an ai-coustics noise cancellation frame processor."""

    return AudioEnhancement(
        model=model,
        license_key=license_key,
        enhancement_level=enhancement_level,
        bypass=bypass,
        otel_config=otel_config,
    )
