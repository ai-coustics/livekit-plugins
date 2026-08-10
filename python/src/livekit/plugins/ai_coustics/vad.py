from __future__ import annotations

import time
import weakref
from collections import deque
from dataclasses import dataclass

import aic_sdk
import numpy as np

from livekit import agents, rtc

from .log import log_async_exceptions, log_fields, logger
from .processor import _license_key, _pcm16_to_float32

_SLOW_WARNING_INTERVAL = 10.0
_SLOW_INFERENCE_BACKLOG_THRESHOLD = 0.2
_DEFAULT_SPEECH_HOLD_DURATION = 0.25
_DEFAULT_MINIMUM_SPEECH_DURATION = 0.05


@dataclass
class VADParameters:
    """Runtime-adjustable SDK VAD parameters; ``None`` retains the current value."""

    sensitivity: float | None = None
    speech_hold_duration: float | None = None
    minimum_speech_duration: float | None = None


class VAD(agents.vad.VAD):
    """LiveKit Agents VAD backed by a dedicated :class:`aic_sdk.VadAsync` model."""

    def __init__(
        self,
        *,
        model: aic_sdk.Model,
        license_key: str | None = None,
        vad_parameters: VADParameters | None = None,
        prefix_padding_duration: float = 0.5,
        max_buffered_speech: float = 60.0,
    ) -> None:
        if prefix_padding_duration < 0.0:
            raise ValueError("prefix_padding_duration must be greater than or equal to zero")
        if max_buffered_speech <= 0.0:
            raise ValueError("max_buffered_speech must be greater than zero")

        self._sdk_model = model
        self._license_key = _license_key(license_key)
        self._model_id = model.get_id()
        model_sample_rate = model.get_optimal_sample_rate()
        model_block_size = model.get_optimal_block_size(model_sample_rate)
        self._prefix_padding_duration = prefix_padding_duration
        self._max_buffered_speech = max_buffered_speech
        # LiveKit's streaming turn detector requires at least 250 ms of VAD silence, and its
        # built-in VADs require 50 ms of speech before activation. Use those integration-friendly
        # defaults instead of the model-specific SDK defaults. VADParameters fields remain
        # optional so later set_parameters() calls are still partial updates.
        self._parameters = VADParameters(
            speech_hold_duration=_DEFAULT_SPEECH_HOLD_DURATION,
            minimum_speech_duration=_DEFAULT_MINIMUM_SPEECH_DURATION,
        )
        self._streams: weakref.WeakSet[VADStream] = weakref.WeakSet()

        super().__init__(
            capabilities=agents.vad.VADCapabilities(
                update_interval=model_block_size / model_sample_rate
            )
        )

        # Construct the first stream's SDK object eagerly so invalid licenses and model types fail
        # when the wrapper is created, matching the Processor wrapper's behavior.
        initial_vad, initial_context = self._create_native_vad()
        self._initial_vad: aic_sdk.VadAsync | None = initial_vad
        self._initial_context: aic_sdk.VadContext | None = initial_context
        self._default_speech_hold_duration = initial_context.get_parameter(
            aic_sdk.VadParameter.SpeechHoldDuration
        )
        if vad_parameters is not None:
            self.set_parameters(vad_parameters)

    @property
    def model(self) -> str:
        return self._model_id

    @property
    def provider(self) -> str:
        return "ai-coustics"

    @property
    def min_silence_duration(self) -> float | None:
        """Expose SDK speech hold time for LiveKit turn-detector compatibility checks."""

        if self._parameters.speech_hold_duration is not None:
            return self._parameters.speech_hold_duration
        return self._default_speech_hold_duration

    def stream(self) -> VADStream:
        if self._initial_vad is not None and self._initial_context is not None:
            native_vad = self._initial_vad
            context = self._initial_context
            self._initial_vad = None
            self._initial_context = None
        else:
            native_vad, context = self._create_native_vad()

        stream = VADStream(
            self,
            native_vad=native_vad,
            context=context,
            model=self._sdk_model,
            prefix_padding_duration=self._prefix_padding_duration,
            max_buffered_speech=self._max_buffered_speech,
        )
        self._streams.add(stream)
        return stream

    def set_parameters(self, parameters: VADParameters) -> None:
        """Apply a partial VAD-parameter update, warning on rejected values."""

        contexts = [stream._context for stream in self._streams if stream._context is not None]
        if self._initial_context is not None:
            contexts.append(self._initial_context)
        if not contexts:
            native_vad, context = self._create_native_vad()
            self._initial_vad = native_vad
            self._initial_context = context
            contexts.append(context)

        if parameters.sensitivity is not None:
            if self._apply_parameter(
                contexts,
                aic_sdk.VadParameter.Sensitivity,
                "sensitivity",
                parameters.sensitivity,
            ):
                self._parameters.sensitivity = parameters.sensitivity

        if parameters.speech_hold_duration is not None:
            if self._apply_parameter(
                contexts,
                aic_sdk.VadParameter.SpeechHoldDuration,
                "speech_hold_duration",
                parameters.speech_hold_duration,
            ):
                self._parameters.speech_hold_duration = parameters.speech_hold_duration

        if parameters.minimum_speech_duration is not None:
            if self._apply_parameter(
                contexts,
                aic_sdk.VadParameter.MinimumSpeechDuration,
                "minimum_speech_duration",
                parameters.minimum_speech_duration,
            ):
                self._parameters.minimum_speech_duration = parameters.minimum_speech_duration

    def _apply_parameter(
        self,
        contexts: list[aic_sdk.VadContext],
        parameter: aic_sdk.VadParameter,
        name: str,
        value: float,
    ) -> bool:
        try:
            for context in contexts:
                context.set_parameter(parameter, value)
        except Exception as error:
            logger.warning(
                "VAD: parameter rejected; keeping the current value",
                extra=log_fields(
                    "vad",
                    model_name=self._model_id,
                    model_provider="ai-coustics",
                    parameter=name,
                    parameter_value=value,
                    error_type=type(error).__name__,
                    error_message=str(error),
                ),
            )
            return False
        return True

    def _create_native_vad(self) -> tuple[aic_sdk.VadAsync, aic_sdk.VadContext]:
        # The SDK retains its first integration ID. Set this before construction so usage is
        # attributed to the LiveKit Python plugin instead of the generic Python binding.
        aic_sdk.set_sdk_id(8)  # type: ignore[attr-defined]

        try:
            native_vad = aic_sdk.VadAsync(
                self._sdk_model,
                self._license_key,
            )
        except Exception as error:
            raise RuntimeError(f"Failed to create ai-coustics VAD: {error}") from error

        context = native_vad.get_context()
        if self._parameters.sensitivity is not None:
            self._apply_parameter(
                [context],
                aic_sdk.VadParameter.Sensitivity,
                "sensitivity",
                self._parameters.sensitivity,
            )
        if self._parameters.speech_hold_duration is not None:
            self._apply_parameter(
                [context],
                aic_sdk.VadParameter.SpeechHoldDuration,
                "speech_hold_duration",
                self._parameters.speech_hold_duration,
            )
        if self._parameters.minimum_speech_duration is not None:
            self._apply_parameter(
                [context],
                aic_sdk.VadParameter.MinimumSpeechDuration,
                "minimum_speech_duration",
                self._parameters.minimum_speech_duration,
            )
        return native_vad, context


class VADStream(agents.vad.VADStream):
    def __init__(
        self,
        vad: VAD,
        *,
        native_vad: aic_sdk.VadAsync,
        context: aic_sdk.VadContext,
        model: aic_sdk.Model,
        prefix_padding_duration: float,
        max_buffered_speech: float,
    ) -> None:
        self._native_vad: aic_sdk.VadAsync | None = native_vad
        self._context: aic_sdk.VadContext | None = context
        self._model = model
        self._prefix_padding_duration = prefix_padding_duration
        self._max_buffered_speech = max_buffered_speech
        self._last_slow_warning = 0.0
        super().__init__(vad)

    async def aclose(self) -> None:
        try:
            await super().aclose()
        finally:
            # A task cancelled before its coroutine starts cannot execute _main_task's finally
            # block, so keep an idempotent close fallback here as well.
            await self._terminate_session()

    async def _terminate_session(self) -> None:
        native_vad = self._native_vad
        self._context = None
        self._native_vad = None
        if native_vad is None:
            return

        try:
            await native_vad.terminate_session_async()
        except Exception as error:
            logger.error(
                "VAD: session termination failed",
                extra=log_fields(
                    "vad",
                    model_name=self._model.get_id(),
                    error_type=type(error).__name__,
                    error_message=str(error),
                ),
                exc_info=(type(error), error, error.__traceback__),
            )

    @log_async_exceptions("vad", "VAD: stream failed")
    async def _main_task(self) -> None:
        native_vad = self._native_vad
        context = self._context
        assert native_vad is not None and context is not None

        input_sample_rate = 0
        inference_block_size = 0
        prediction_delay_samples = 0
        configured_format: tuple[int, int] | None = None
        inference_buffer = bytearray()

        prefix_frames: deque[rtc.AudioFrame] = deque()
        prefix_samples = 0
        speech_pcm = bytearray()
        speech_samples = 0
        speech_buffer_full = False
        processing_backlog = 0.0
        slow_warning_active = False

        speaking = False
        speech_duration = 0.0
        silence_duration = 0.0
        raw_speech_duration = 0.0
        raw_silence_duration = 0.0
        current_sample = 0
        timestamp = 0.0

        def reset_state() -> None:
            nonlocal input_sample_rate, inference_block_size
            nonlocal prefix_samples, speech_samples, speech_buffer_full
            nonlocal processing_backlog, slow_warning_active
            nonlocal speaking, speech_duration, silence_duration
            nonlocal raw_speech_duration, raw_silence_duration
            nonlocal current_sample, timestamp

            context.reset()
            input_sample_rate = 0
            inference_block_size = 0
            inference_buffer.clear()
            prefix_frames.clear()
            prefix_samples = 0
            speech_pcm.clear()
            speech_samples = 0
            speech_buffer_full = False
            processing_backlog = 0.0
            slow_warning_active = False
            speaking = False
            speech_duration = 0.0
            silence_duration = 0.0
            raw_speech_duration = 0.0
            raw_silence_duration = 0.0
            current_sample = 0
            timestamp = 0.0

        def to_mono(frame: rtc.AudioFrame) -> rtc.AudioFrame:
            if frame.num_channels == 1:
                return frame

            samples = np.frombuffer(frame.data, dtype=np.int16)
            expected_samples = frame.samples_per_channel * frame.num_channels
            if samples.size != expected_samples:
                raise ValueError(
                    f"AudioFrame contains {samples.size} samples, expected {expected_samples}"
                )
            channels = samples.reshape(frame.samples_per_channel, frame.num_channels)
            mono = np.rint(channels.mean(axis=1, dtype=np.float32)).astype(np.int16)
            return rtc.AudioFrame(
                data=mono.tobytes(),
                sample_rate=frame.sample_rate,
                num_channels=1,
                samples_per_channel=frame.samples_per_channel,
                userdata=frame.userdata,
            )

        def update_prefix_buffer(frame: rtc.AudioFrame) -> None:
            nonlocal prefix_samples

            prefix_frames.append(frame)
            prefix_samples += frame.samples_per_channel
            minimum_speech_duration = context.get_parameter(
                aic_sdk.VadParameter.MinimumSpeechDuration
            )
            activation_samples = max(
                frame.samples_per_channel,
                int(minimum_speech_duration * frame.sample_rate),
            )
            target_samples = (
                int(self._prefix_padding_duration * frame.sample_rate)
                + prediction_delay_samples
                + activation_samples
            )
            while len(prefix_frames) > 1 and (
                prefix_samples - prefix_frames[0].samples_per_channel >= target_samples
            ):
                prefix_samples -= prefix_frames.popleft().samples_per_channel

        def append_speech_audio(frame: rtc.AudioFrame) -> None:
            nonlocal speech_samples, speech_buffer_full

            max_samples = (
                int((self._prefix_padding_duration + self._max_buffered_speech) * frame.sample_rate)
                + prediction_delay_samples
            )
            remaining_samples = max(0, max_samples - speech_samples)
            copied_samples = min(frame.samples_per_channel, remaining_samples)
            if copied_samples:
                pcm = frame.data.cast("b")
                speech_pcm.extend(pcm[: copied_samples * np.dtype(np.int16).itemsize])
                speech_samples += copied_samples

            if copied_samples < frame.samples_per_channel and not speech_buffer_full:
                speech_buffer_full = True
                logger.warning(
                    "VAD: maximum buffered speech reached; ignoring further audio",
                    extra=log_fields(
                        "vad",
                        model_name=self._model.get_id(),
                        max_buffered_speech=self._max_buffered_speech,
                    ),
                )

        def speech_event_frames() -> list[rtc.AudioFrame]:
            if not speech_samples:
                return []

            # Snapshot the mutable bytearray so the START event remains unchanged while more PCM
            # is appended for the eventual END event.
            return [
                rtc.AudioFrame(
                    data=bytes(speech_pcm),
                    sample_rate=input_sample_rate,
                    num_channels=1,
                    samples_per_channel=speech_samples,
                )
            ]

        try:
            async for input_frame in self._input_ch:
                if isinstance(input_frame, self._FlushSentinel):
                    reset_state()
                    continue

                if not isinstance(input_frame, rtc.AudioFrame):
                    continue

                if not input_sample_rate:
                    input_sample_rate = input_frame.sample_rate
                    inference_block_size = self._model.get_optimal_block_size(input_sample_rate)
                    stream_format = (input_sample_rate, inference_block_size)
                    if configured_format != stream_format:
                        try:
                            await native_vad.initialize_async(
                                aic_sdk.ProcessorConfig(
                                    sample_rate=input_sample_rate,
                                    block_size=inference_block_size,
                                    variable_block_size=False,
                                )
                            )
                        except Exception as error:
                            raise RuntimeError(
                                "ai-coustics VAD initialization failed "
                                f"(model={self._model.get_id()}, "
                                f"sample_rate={input_sample_rate}, "
                                f"block_size={inference_block_size}): {error}"
                            ) from error
                        configured_format = stream_format
                        # SDK predictions describe earlier input. The delay is reported in samples
                        # of the configured (LiveKit input) rate, not the model's internal rate.
                        prediction_delay_samples = context.get_prediction_delay()
                elif input_frame.sample_rate != input_sample_rate:
                    logger.error(
                        "VAD: received frame with a different sample rate",
                        extra=log_fields(
                            "vad",
                            model_name=self._model.get_id(),
                            sample_rate=input_sample_rate,
                            received_sample_rate=input_frame.sample_rate,
                        ),
                    )
                    continue

                mono_frame = to_mono(input_frame)
                inference_buffer.extend(mono_frame.data.cast("b"))

                block_bytes = inference_block_size * np.dtype(np.int16).itemsize
                while len(inference_buffer) >= block_bytes:
                    pcm = bytes(inference_buffer[:block_bytes])
                    del inference_buffer[:block_bytes]
                    block = _pcm16_to_float32(memoryview(pcm))

                    started = time.perf_counter()
                    try:
                        await native_vad.process_async(block)
                    except Exception as error:
                        raise RuntimeError(
                            "ai-coustics VAD inference failed "
                            f"(model={self._model.get_id()}, "
                            f"sample_rate={input_sample_rate}, "
                            f"block_size={inference_block_size}): {error}"
                        ) from error
                    inference_completed = time.perf_counter()
                    inference_duration = inference_completed - started

                    probability = context.raw_vad_probability()
                    detected = context.is_speech_detected()
                    block_duration = inference_block_size / input_sample_rate
                    processing_backlog = max(
                        0.0,
                        processing_backlog + inference_duration - block_duration,
                    )
                    prediction_delay_duration = prediction_delay_samples / input_sample_rate
                    current_sample += inference_block_size
                    timestamp += block_duration

                    sensitivity = context.get_parameter(aic_sdk.VadParameter.Sensitivity)
                    if probability >= sensitivity:
                        raw_speech_duration += block_duration
                        raw_silence_duration = 0.0
                    else:
                        raw_silence_duration += block_duration
                        raw_speech_duration = 0.0

                    # LiveKit derives wall-clock speech boundaries from these durations. Include
                    # the SDK prediction lag so those boundaries point at the corresponding input
                    # audio rather than the later time at which the decision became available.
                    aligned_raw_speech_duration = (
                        raw_speech_duration + prediction_delay_duration
                        if raw_speech_duration > 0.0
                        else 0.0
                    )
                    aligned_raw_silence_duration = (
                        raw_silence_duration + prediction_delay_duration
                        if raw_silence_duration > 0.0
                        else 0.0
                    )

                    if speaking:
                        speech_duration += block_duration
                    else:
                        silence_duration += block_duration

                    inference_audio = rtc.AudioFrame(
                        data=pcm,
                        sample_rate=input_sample_rate,
                        num_channels=1,
                        samples_per_channel=inference_block_size,
                    )
                    # The SDK handles model-rate conversion internally. Keep inference and event
                    # audio at the incoming sample rate so downstream consumers receive the
                    # original mono PCM rather than a plugin-resampled copy.
                    update_prefix_buffer(inference_audio)
                    if speaking:
                        append_speech_audio(inference_audio)

                    self._event_ch.send_nowait(
                        agents.vad.VADEvent(
                            type=agents.vad.VADEventType.INFERENCE_DONE,
                            samples_index=current_sample,
                            timestamp=timestamp,
                            speech_duration=speech_duration,
                            silence_duration=silence_duration,
                            frames=[inference_audio],
                            probability=probability,
                            inference_duration=inference_duration,
                            speaking=speaking,
                            raw_accumulated_silence=aligned_raw_silence_duration,
                            raw_accumulated_speech=aligned_raw_speech_duration,
                        )
                    )

                    if detected and not speaking:
                        speaking = True
                        silence_duration = 0.0
                        speech_duration = max(block_duration, aligned_raw_speech_duration)
                        speech_pcm.clear()
                        speech_samples = 0
                        speech_buffer_full = False
                        for prefix_frame in prefix_frames:
                            append_speech_audio(prefix_frame)
                        self._event_ch.send_nowait(
                            agents.vad.VADEvent(
                                type=agents.vad.VADEventType.START_OF_SPEECH,
                                samples_index=current_sample,
                                timestamp=timestamp,
                                speech_duration=speech_duration,
                                silence_duration=0.0,
                                frames=speech_event_frames(),
                                probability=probability,
                                inference_duration=inference_duration,
                                speaking=True,
                                raw_accumulated_speech=aligned_raw_speech_duration,
                            )
                        )
                    elif not detected and speaking:
                        speaking = False
                        silence_duration = aligned_raw_silence_duration
                        completed_speech_duration = max(0.0, speech_duration - silence_duration)
                        self._event_ch.send_nowait(
                            agents.vad.VADEvent(
                                type=agents.vad.VADEventType.END_OF_SPEECH,
                                samples_index=current_sample,
                                timestamp=timestamp,
                                speech_duration=completed_speech_duration,
                                silence_duration=silence_duration,
                                frames=speech_event_frames(),
                                probability=probability,
                                inference_duration=inference_duration,
                                speaking=False,
                                raw_accumulated_silence=aligned_raw_silence_duration,
                            )
                        )
                        speech_duration = 0.0
                        speech_pcm.clear()
                        speech_samples = 0
                        speech_buffer_full = False

                    if processing_backlog == 0.0:
                        slow_warning_active = False
                    elif processing_backlog >= _SLOW_INFERENCE_BACKLOG_THRESHOLD and (
                        not slow_warning_active
                        or inference_completed - self._last_slow_warning >= _SLOW_WARNING_INTERVAL
                    ):
                        slow_warning_active = True
                        self._last_slow_warning = inference_completed
                        logger.warning(
                            "VAD: inference falling behind realtime",
                            extra=log_fields(
                                "vad",
                                inference_duration=inference_duration,
                                block_duration=block_duration,
                                realtime_factor=inference_duration / block_duration,
                                processing_backlog=processing_backlog,
                                sample_rate=input_sample_rate,
                                block_size=inference_block_size,
                                model_name=self._model.get_id(),
                                model_provider="ai-coustics",
                            ),
                        )
        finally:
            await self._terminate_session()
