from __future__ import annotations

import os
import time
from dataclasses import dataclass
from os import PathLike

import aic_sdk
import numpy as np

from livekit import rtc

from ._model import EnhancerCore, ModelInput, load_model
from .log import logger

_SLOW_WARNING_INTERVAL = 10.0


def _license_key(value: str | None) -> str:
    key = value or os.getenv("AIC_SDK_LICENSE")
    if not key:
        raise ValueError(
            "An ai-coustics SDK license is required. Pass license_key or set AIC_SDK_LICENSE."
        )
    return key


def _pcm16_to_float32(data: memoryview) -> np.ndarray:
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


def _float32_to_pcm16(data: np.ndarray) -> bytes:
    clipped = np.clip(data, -1.0, 32767.0 / 32768.0)
    return bytes(np.rint(clipped * 32768.0).astype(np.int16).tobytes())


@dataclass
class ModelParameters:
    """Runtime-adjustable enhancement parameters; ``None`` retains the current value."""

    enhancement_level: float | None = None
    bypass: bool | None = None


class AudioEnhancement(rtc.FrameProcessor[rtc.AudioFrame]):
    """LiveKit audio frame processor backed by :class:`aic_sdk.Processor`.

    Model resolution and license validation are eager so configuration errors fail before audio
    starts. Processor format initialization remains lazy because LiveKit supplies the stream's
    sample rate, channel count, and frame size with the first frame.
    """

    _core_factory = EnhancerCore

    def __init__(
        self,
        *,
        model: ModelInput,
        license_key: str | None = None,
        model_parameters: ModelParameters | None = None,
        enhancement_level: float | None = None,
        bypass: bool | None = None,
        download_dir: str | PathLike[str] | None = None,
        otel_config: aic_sdk.OtelConfig | None = None,
    ) -> None:
        self._model = load_model(model, download_dir=download_dir)
        self._license_key = _license_key(license_key)
        self._otel_config = otel_config
        self._core: EnhancerCore | None = self._create_core()
        self._parameters: list[tuple[aic_sdk.ProcessorParameter, float]] = []
        self._model_parameters = model_parameters or ModelParameters()
        self._format: tuple[int, int, int] | None = None
        self._enabled = True
        self._needs_reset = False
        self._last_error_message: str | None = None
        self._last_slow_warning = 0.0

        if enhancement_level is not None:
            self._model_parameters.enhancement_level = enhancement_level
        if bypass is not None:
            self._model_parameters.bypass = bypass
        self.update_model_parameters(self._model_parameters)

    def _create_core(self) -> EnhancerCore:
        core = self._core_factory(
            model=self._model,
            license_key=self._license_key,
            otel_config=self._otel_config,
        )
        core.validate_license()
        return core

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        if value and not self._enabled:
            self._needs_reset = True
        self._enabled = value

    @property
    def processor_context(self) -> aic_sdk.ProcessorContext:
        """The SDK context for advanced parameter and delay access."""

        if self._core is None:
            raise RuntimeError("The ai-coustics processor is closed")
        return self._core.context

    @property
    def output_delay(self) -> int:
        """Current SDK output delay, in samples at the configured sample rate."""

        if self._core is None:
            raise RuntimeError("The ai-coustics processor is closed")
        return self._core.output_delay

    def set_parameter(self, parameter: aic_sdk.ProcessorParameter, value: float) -> None:
        """Set a raw SDK Processor parameter and persist it across reconfiguration."""

        for index, (current, _current_value) in enumerate(self._parameters):
            if current == parameter:
                self._parameters[index] = (parameter, value)
                break
        else:
            self._parameters.append((parameter, value))
        if self._core is not None:
            self._core.set_parameter(parameter, value)

    def update_model_parameters(self, parameters: ModelParameters) -> None:
        """Apply a partial model-parameter update immediately and on future formats."""

        if parameters.enhancement_level is not None:
            level = parameters.enhancement_level
            if not 0.0 <= level <= 1.0:
                raise ValueError(f"enhancement_level must be in [0.0, 1.0], got {level}")
            self._model_parameters.enhancement_level = level
            self.set_parameter(aic_sdk.ProcessorParameter.EnhancementLevel, level)
        if parameters.bypass is not None:
            if not isinstance(parameters.bypass, bool):
                raise TypeError("bypass must be a bool")
            self._model_parameters.bypass = parameters.bypass
            self.set_parameter(
                aic_sdk.ProcessorParameter.Bypass,
                1.0 if parameters.bypass else 0.0,
            )

    def _apply_parameters(self) -> None:
        assert self._core is not None
        for parameter, value in self._parameters:
            self._core.set_parameter(parameter, value)

    def _process(self, frame: rtc.AudioFrame) -> rtc.AudioFrame:
        if not self.enabled or self._core is None:
            return frame

        started = time.perf_counter()
        try:
            stream_format = (
                frame.sample_rate,
                frame.num_channels,
                frame.samples_per_channel,
            )
            if self._format != stream_format:
                self._core.initialize(*stream_format)
                self._format = stream_format
                self._needs_reset = False
                self._apply_parameters()
                logger.info(
                    "ai-coustics initialized: %d Hz, %d ch, %d samples/frame, "
                    "output delay %d samples",
                    *stream_format,
                    self._core.output_delay,
                )
            if self._needs_reset:
                self._core.reset()
                self._needs_reset = False

            samples = _pcm16_to_float32(frame.data)
            expected_samples = frame.samples_per_channel * frame.num_channels
            if samples.size != expected_samples:
                raise ValueError(
                    f"AudioFrame contains {samples.size} samples, expected {expected_samples}"
                )

            planar = samples.reshape(frame.samples_per_channel, frame.num_channels).T.copy()
            processed = self._core.process(planar)
            interleaved = processed.T.reshape(-1)
        except Exception as error:
            self._log_error(f"{type(error).__name__}: {error}")
            return frame

        self._last_error_message = None
        elapsed = time.perf_counter() - started
        frame_duration = frame.samples_per_channel / frame.sample_rate
        if elapsed > frame_duration and started - self._last_slow_warning > _SLOW_WARNING_INTERVAL:
            self._last_slow_warning = started
            logger.warning(
                "ai-coustics processing is slower than realtime (%.1f ms for a %.1f ms frame); "
                "consider a smaller model",
                elapsed * 1000,
                frame_duration * 1000,
            )

        return rtc.AudioFrame(
            data=_float32_to_pcm16(interleaved),
            sample_rate=frame.sample_rate,
            num_channels=frame.num_channels,
            samples_per_channel=frame.samples_per_channel,
            userdata=frame.userdata,
        )

    def _log_error(self, message: str) -> None:
        if message == self._last_error_message:
            return
        self._last_error_message = message
        logger.error("ai-coustics processing failed; passing audio through: %s", message)

    def _close(self) -> None:
        self._enabled = False
        self._core = None
        self._format = None


def audio_enhancement(
    *,
    model: ModelInput,
    license_key: str | None = None,
    model_parameters: ModelParameters | None = None,
    enhancement_level: float | None = None,
    bypass: bool | None = None,
    download_dir: str | PathLike[str] | None = None,
    otel_config: aic_sdk.OtelConfig | None = None,
) -> AudioEnhancement:
    """Create an ai-coustics noise cancellation frame processor."""

    return AudioEnhancement(
        model=model,
        license_key=license_key,
        model_parameters=model_parameters,
        enhancement_level=enhancement_level,
        bypass=bypass,
        download_dir=download_dir,
        otel_config=otel_config,
    )
