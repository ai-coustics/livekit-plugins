from __future__ import annotations

import os
import time
from dataclasses import dataclass

import aic_sdk
import numpy as np

from livekit import rtc

from .log import logger

_SLOW_WARNING_INTERVAL = 10.0
_SLOW_BACKLOG_THRESHOLD = 0.2
_ERROR_REPORT_INTERVAL = 10.0


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

        # This runtime-only SDK hook must run before Processor construction because the SDK keeps
        # the first integration identifier it receives. ID 8 identifies the LiveKit Python plugin.
        aic_sdk.set_sdk_id(8)  # type: ignore[attr-defined]

        try:
            model_id = model.get_id()
            processor = aic_sdk.Processor(
                model,
                resolved_license_key,
            )
        except Exception as error:
            raise RuntimeError(f"Failed to create ai-coustics Processor: {error}") from error

        self._processor: aic_sdk.Processor | None = processor
        self._model_id = model_id
        self._format: tuple[int, int, int] | None = None
        self._stream_info: dict[str, str] = {}
        self._enabled = True
        self._closed = False

        self._frame_count = 0
        self._processed_frame_count = 0
        self._failed_frame_count = 0
        self._input_audio_duration = 0.0
        self._processing_duration_total = 0.0
        self._processing_duration_max = 0.0
        self._sdk_processing_duration_total = 0.0
        self._sdk_processing_duration_max = 0.0
        self._realtime_factor_max = 0.0
        self._processing_backlog = 0.0
        self._processing_backlog_max = 0.0
        self._initialization_count = 0
        self._audio_delay_samples: int | None = None
        self._audio_delay: float | None = None
        self._last_slow_warning: float | None = None
        self._slow_warning_active = False

        self._consecutive_failures = 0
        self._failure_started: float | None = None
        self._failure_episode_reported = False
        self._active_error_signature: tuple[str, str, str] | None = None
        self._last_reported_error_signature: tuple[str, str, str] | None = None
        self._last_error_report: float | None = None

        try:
            self._context: aic_sdk.ProcessorContext | None = processor.get_context()
            if processor_parameters is not None:
                self.set_parameters(processor_parameters)
        except Exception:
            processor.terminate_session()
            raise

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        if value == self._enabled:
            return
        if value and not self._enabled and self._context is not None:
            self._context.reset()
        self._enabled = value
        logger.debug(
            "ai-coustics Processor %s",
            "enabled" if value else "disabled",
            extra=self._diagnostic_fields(),
        )

    def set_parameters(self, parameters: ProcessorParameters) -> None:
        """Apply a partial Processor-parameter update."""

        if self._context is None:
            return

        if parameters.enhancement_level is not None:
            level = parameters.enhancement_level
            if not 0.0 <= level <= 1.0:
                raise ValueError(f"enhancement_level must be in [0.0, 1.0], got {level}")
            self._context.set_parameter(aic_sdk.ProcessorParameter.EnhancementLevel, level)
            logger.debug(
                "ai-coustics Processor parameter updated",
                extra=self._diagnostic_fields(parameter="enhancement_level", parameter_value=level),
            )

        if parameters.bypass is not None:
            if not isinstance(parameters.bypass, bool):
                raise TypeError("bypass must be a bool")
            self._context.set_parameter(
                aic_sdk.ProcessorParameter.Bypass,
                1.0 if parameters.bypass else 0.0,
            )
            logger.debug(
                "ai-coustics Processor parameter updated",
                extra=self._diagnostic_fields(
                    parameter="bypass", parameter_value=parameters.bypass
                ),
            )

    def _on_stream_info_updated(
        self,
        *,
        room_name: str,
        participant_identity: str,
        publication_sid: str,
    ) -> None:
        stream_info = {
            "room_name": room_name,
            "participant_identity": participant_identity,
            "publication_sid": publication_sid,
        }
        changed = bool(self._stream_info and self._stream_info != stream_info)
        if changed and self._context is not None:
            self._context.reset()
        self._stream_info = stream_info
        logger.debug(
            "ai-coustics Processor stream %s",
            "changed; native context reset" if changed else "attached",
            extra=self._diagnostic_fields(),
        )

    def _on_stream_info_cleared(self) -> None:
        if not self._stream_info:
            return
        fields = self._diagnostic_fields()
        if self._context is not None:
            self._context.reset()
        self._stream_info = {}
        logger.debug("ai-coustics Processor stream detached", extra=fields)

    def _process(self, frame: rtc.AudioFrame) -> rtc.AudioFrame:
        # A disabled or closed processor is a transparent LiveKit frame processor.
        if not self.enabled or self._processor is None or self._context is None:
            return frame

        started = time.perf_counter()
        frame_duration = frame.samples_per_channel / frame.sample_rate
        processing_stage = "initialize"
        sdk_processing_duration = 0.0
        try:
            # LiveKit supplies the stream geometry with each frame, so SDK initialization must be
            # lazy. Reinitializing on a geometry change also clears state from the previous stream.
            stream_format = (
                frame.sample_rate,
                frame.num_channels,
                frame.samples_per_channel,
            )

            if self._format != stream_format:
                initialization_started = time.perf_counter()
                self._processor.initialize(
                    aic_sdk.ProcessorConfig(
                        sample_rate=frame.sample_rate,
                        block_size=frame.samples_per_channel,
                        variable_block_size=False,
                    )
                )
                self._format = stream_format
                self._initialization_count += 1
                initialization_duration = time.perf_counter() - initialization_started
                audio_delay_samples = self._context.get_audio_delay()
                self._audio_delay_samples = audio_delay_samples
                self._audio_delay = audio_delay_samples / frame.sample_rate
                logger.info(
                    "ai-coustics Processor %s",
                    "initialized" if self._initialization_count == 1 else "reconfigured",
                    extra=self._diagnostic_fields(
                        initialization_duration=initialization_duration,
                        initialization_count=self._initialization_count,
                        audio_delay_samples=audio_delay_samples,
                        audio_delay=self._audio_delay,
                        frame_duration=frame_duration,
                        downmixing=frame.num_channels > 1,
                    ),
                )

            # LiveKit stores signed 16-bit PCM samples interleaved by channel. The SDK operates on
            # normalized float32 samples, so validate the frame before reshaping it.
            processing_stage = "validate_frame"
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
            processing_stage = "process"
            sdk_started = time.perf_counter()
            try:
                processed = self._processor.process(mono)
            finally:
                sdk_processing_duration = time.perf_counter() - sdk_started

            # FrameProcessor output must retain the input geometry. Expand the enhanced mono block
            # back to interleaved PCM by writing the same processed signal to every input channel.
            processing_stage = "convert_output"
            interleaved = (
                processed if frame.num_channels == 1 else np.repeat(processed, frame.num_channels)
            )
            output = rtc.AudioFrame(
                data=_float32_to_pcm16(interleaved),
                sample_rate=frame.sample_rate,
                num_channels=frame.num_channels,
                samples_per_channel=frame.samples_per_channel,
                userdata=frame.userdata,
            )
        except Exception as error:
            # Keep room audio flowing if SDK initialization or processing fails.
            completed = time.perf_counter()
            self._record_timing(
                processing_duration=completed - started,
                sdk_processing_duration=sdk_processing_duration,
                frame_duration=frame_duration,
                completed=completed,
            )
            self._record_failure(
                processing_stage,
                error,
                completed,
                processing_duration=completed - started,
                sdk_processing_duration=sdk_processing_duration,
                frame_duration=frame_duration,
            )
            return frame

        completed = time.perf_counter()
        self._record_timing(
            processing_duration=completed - started,
            sdk_processing_duration=sdk_processing_duration,
            frame_duration=frame_duration,
            completed=completed,
        )
        self._record_success(completed)
        return output

    def _record_timing(
        self,
        *,
        processing_duration: float,
        sdk_processing_duration: float,
        frame_duration: float,
        completed: float,
    ) -> None:
        self._frame_count += 1
        self._input_audio_duration += frame_duration
        self._processing_duration_total += processing_duration
        self._processing_duration_max = max(self._processing_duration_max, processing_duration)
        self._sdk_processing_duration_total += sdk_processing_duration
        self._sdk_processing_duration_max = max(
            self._sdk_processing_duration_max, sdk_processing_duration
        )
        realtime_factor = processing_duration / frame_duration
        self._realtime_factor_max = max(self._realtime_factor_max, realtime_factor)
        self._processing_backlog = max(
            0.0,
            self._processing_backlog + processing_duration - frame_duration,
        )
        self._processing_backlog_max = max(self._processing_backlog_max, self._processing_backlog)

        if self._processing_backlog == 0.0:
            self._slow_warning_active = False
        elif self._processing_backlog >= _SLOW_BACKLOG_THRESHOLD and (
            not self._slow_warning_active
            or self._last_slow_warning is None
            or completed - self._last_slow_warning >= _SLOW_WARNING_INTERVAL
        ):
            self._slow_warning_active = True
            self._last_slow_warning = completed
            logger.warning(
                "ai-coustics Processor is falling behind realtime",
                extra=self._diagnostic_fields(
                    processing_duration=processing_duration,
                    sdk_processing_duration=sdk_processing_duration,
                    frame_duration=frame_duration,
                    realtime_factor=realtime_factor,
                    processing_backlog=self._processing_backlog,
                    processing_backlog_max=self._processing_backlog_max,
                ),
            )

    def _record_failure(
        self,
        stage: str,
        error: Exception,
        completed: float,
        *,
        processing_duration: float,
        sdk_processing_duration: float,
        frame_duration: float,
    ) -> None:
        signature = (stage, type(error).__name__, str(error))
        self._failed_frame_count += 1
        if self._consecutive_failures == 0:
            self._failure_started = completed - processing_duration
            self._failure_episode_reported = False
        self._consecutive_failures += 1
        self._active_error_signature = signature

        should_report = (
            signature != self._last_reported_error_signature
            or self._last_error_report is None
            or completed - self._last_error_report >= _ERROR_REPORT_INTERVAL
        )
        if not should_report:
            return

        self._failure_episode_reported = True
        self._last_reported_error_signature = signature
        self._last_error_report = completed
        logger.error(
            "ai-coustics Processor failed; passing audio through",
            extra=self._diagnostic_fields(
                processing_stage=stage,
                error_type=type(error).__name__,
                error_message=str(error),
                consecutive_failures=self._consecutive_failures,
                failed_frame_count=self._failed_frame_count,
                processing_duration=processing_duration,
                sdk_processing_duration=sdk_processing_duration,
                frame_duration=frame_duration,
                realtime_factor=processing_duration / frame_duration,
                failure_duration=completed
                - (self._failure_started if self._failure_started is not None else completed),
            ),
            exc_info=(type(error), error, error.__traceback__),
        )

    def _record_success(self, completed: float) -> None:
        self._processed_frame_count += 1
        if self._consecutive_failures == 0:
            return

        if self._failure_episode_reported:
            active_error = self._active_error_signature
            logger.info(
                "ai-coustics Processor recovered",
                extra=self._diagnostic_fields(
                    recovered_failure_count=self._consecutive_failures,
                    failure_duration=completed
                    - (self._failure_started if self._failure_started is not None else completed),
                    failed_frame_count=self._failed_frame_count,
                    last_failure_stage=active_error[0] if active_error else None,
                    last_error_type=active_error[1] if active_error else None,
                    last_error_message=active_error[2] if active_error else None,
                ),
            )
        self._consecutive_failures = 0
        self._failure_started = None
        self._failure_episode_reported = False
        self._active_error_signature = None

    def _diagnostic_fields(self, **fields: object) -> dict[str, object]:
        diagnostics: dict[str, object] = {
            "model_provider": "ai-coustics",
            "model_name": self._model_id,
            **self._stream_info,
        }
        if self._format is not None:
            diagnostics.update(
                {
                    "sample_rate": self._format[0],
                    "num_channels": self._format[1],
                    "samples_per_frame": self._format[2],
                }
            )
        diagnostics.update(fields)
        return diagnostics

    def _close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._enabled = False
        processor = self._processor

        if processor is not None:
            try:
                processor.terminate_session()
            except Exception as error:
                logger.error(
                    "Failed to terminate ai-coustics Processor session",
                    extra=self._diagnostic_fields(
                        error_type=type(error).__name__, error_message=str(error)
                    ),
                    exc_info=(type(error), error, error.__traceback__),
                )

        summary = self._diagnostic_fields(
            frame_count=self._frame_count,
            processed_frame_count=self._processed_frame_count,
            failed_frame_count=self._failed_frame_count,
            input_audio_duration=self._input_audio_duration,
            processing_duration_total=self._processing_duration_total,
            processing_duration_max=self._processing_duration_max,
            sdk_processing_duration_total=self._sdk_processing_duration_total,
            sdk_processing_duration_max=self._sdk_processing_duration_max,
            average_realtime_factor=(
                self._processing_duration_total / self._input_audio_duration
                if self._input_audio_duration > 0.0
                else 0.0
            ),
            maximum_realtime_factor=self._realtime_factor_max,
            processing_backlog_max=self._processing_backlog_max,
            initialization_count=self._initialization_count,
            audio_delay_samples=self._audio_delay_samples,
            audio_delay=self._audio_delay,
            consecutive_failures=self._consecutive_failures,
            active_failure_stage=(
                self._active_error_signature[0]
                if self._active_error_signature is not None
                else None
            ),
            active_error_type=(
                self._active_error_signature[1]
                if self._active_error_signature is not None
                else None
            ),
            active_error_message=(
                self._active_error_signature[2]
                if self._active_error_signature is not None
                else None
            ),
        )
        if self._frame_count:
            logger.info("ai-coustics Processor closed", extra=summary)
        else:
            logger.debug("ai-coustics Processor closed without processing audio", extra=summary)

        self._context = None
        self._processor = None
        self._format = None
