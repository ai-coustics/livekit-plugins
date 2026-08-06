from __future__ import annotations

import os
import time
from dataclasses import dataclass

import aic_sdk
import numpy as np

from livekit import rtc

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
class ProcessorParameters:
    """Runtime-adjustable enhancement parameters; ``None`` retains the current value."""

    enhancement_level: float | None = None
    bypass: bool | None = None


class Processor(rtc.FrameProcessor[rtc.AudioFrame]):
    """LiveKit audio frame processor backed by :class:`aic_sdk.Processor`.

    Model resolution and Processor construction are eager, while SDK backend authentication uses
    its grace period. Format initialization remains lazy because LiveKit supplies the stream's
    sample rate, channel count, and frame size with the first frame.
    """

    def __init__(
        self,
        *,
        model: aic_sdk.Model,
        license_key: str | None = None,
        processor_parameters: ProcessorParameters | None = None,
    ) -> None:
        resolved_license_key = _license_key(license_key)
        try:
            processor = aic_sdk.Processor(
                model,
                resolved_license_key,
            )
        except Exception as error:
            raise RuntimeError(f"Failed to create ai-coustics Processor: {error}") from error

        self._processor: aic_sdk.Processor | None = processor
        self._context: aic_sdk.ProcessorContext | None = self._processor.get_context()
        self._format: tuple[int, int, int] | None = None
        self._enabled = True
        self._last_error_message: str | None = None
        self._last_slow_warning = 0.0

        if processor_parameters is not None:
            self.set_parameters(processor_parameters)

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        if value and not self._enabled and self._context is not None:
            self._context.reset()
        self._enabled = value

    def set_parameters(self, parameters: ProcessorParameters) -> None:
        """Apply a partial Processor-parameter update."""

        if self._context is None:
            return

        if parameters.enhancement_level is not None:
            level = parameters.enhancement_level
            if not 0.0 <= level <= 1.0:
                raise ValueError(f"enhancement_level must be in [0.0, 1.0], got {level}")
            self._context.set_parameter(aic_sdk.ProcessorParameter.EnhancementLevel, level)

        if parameters.bypass is not None:
            if not isinstance(parameters.bypass, bool):
                raise TypeError("bypass must be a bool")
            self._context.set_parameter(
                aic_sdk.ProcessorParameter.Bypass,
                1.0 if parameters.bypass else 0.0,
            )

    def _process(self, frame: rtc.AudioFrame) -> rtc.AudioFrame:
        # A disabled or closed processor is a transparent LiveKit frame processor.
        if not self.enabled or self._processor is None or self._context is None:
            return frame

        started = time.perf_counter()
        try:
            # LiveKit supplies the stream geometry with each frame, so SDK initialization must be
            # lazy. Reinitializing on a geometry change also clears state from the previous stream.
            stream_format = (
                frame.sample_rate,
                frame.num_channels,
                frame.samples_per_channel,
            )

            if self._format != stream_format:
                self._processor.initialize(
                    aic_sdk.ProcessorConfig(
                        sample_rate=frame.sample_rate,
                        block_size=frame.samples_per_channel,
                        variable_block_size=False,
                    )
                )
                self._format = stream_format
                logger.info(
                    "ai-coustics initialized: %d Hz, %d ch, %d samples/frame, "
                    "audio delay %d samples",
                    *stream_format,
                    self._context.get_audio_delay(),
                )

            # LiveKit stores signed 16-bit PCM samples interleaved by channel. The SDK operates on
            # normalized float32 samples, so validate the frame before reshaping it.
            samples = _pcm16_to_float32(frame.data)
            expected_samples = frame.samples_per_channel * frame.num_channels
            if samples.size != expected_samples:
                raise ValueError(
                    f"AudioFrame contains {samples.size} samples, expected {expected_samples}"
                )

            # aic-sdk 3 accepts only a contiguous, one-dimensional mono block. For multichannel
            # input, average all channels just as the pre-3.0 SDK did internally. Copying the mono
            # view makes it contiguous as well.
            channels = samples.reshape(frame.samples_per_channel, frame.num_channels)
            mono = (
                channels[:, 0].copy()
                if frame.num_channels == 1
                else channels.mean(axis=1, dtype=np.float32)
            )
            processed = self._processor.process(mono)

            # FrameProcessor output must retain the input geometry. Expand the enhanced mono block
            # back to interleaved PCM by writing the same processed signal to every input channel.
            interleaved = (
                processed if frame.num_channels == 1 else np.repeat(processed, frame.num_channels)
            )
        except Exception as error:
            # Keep room audio flowing if SDK initialization or processing fails.
            self._log_error(f"{type(error).__name__}: {error}")
            return frame

        self._last_error_message = None

        # Processing is synchronous on LiveKit's audio path. Warn, at a throttled rate, when a
        # block takes longer to process than the amount of audio it contains.
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
        self._context = None
        self._processor = None
        self._format = None
