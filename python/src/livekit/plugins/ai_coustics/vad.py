from __future__ import annotations

import time
import weakref
from collections import deque
from dataclasses import dataclass

import aic_sdk
import numpy as np

from livekit import agents, rtc

from .log import logger
from .processor import _license_key, _pcm16_to_float32

_SLOW_WARNING_INTERVAL = 10.0


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
        self._parameters = VADParameters()
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
        """Apply a partial SDK VAD-parameter update to current and future streams."""

        contexts = [stream._context for stream in self._streams if stream._context is not None]
        if self._initial_context is not None:
            contexts.append(self._initial_context)

        if parameters.sensitivity is not None:
            for context in contexts:
                context.set_parameter(aic_sdk.VadParameter.Sensitivity, parameters.sensitivity)
            self._parameters.sensitivity = parameters.sensitivity

        if parameters.speech_hold_duration is not None:
            for context in contexts:
                context.set_parameter(
                    aic_sdk.VadParameter.SpeechHoldDuration,
                    parameters.speech_hold_duration,
                )
            self._parameters.speech_hold_duration = parameters.speech_hold_duration

        if parameters.minimum_speech_duration is not None:
            for context in contexts:
                context.set_parameter(
                    aic_sdk.VadParameter.MinimumSpeechDuration,
                    parameters.minimum_speech_duration,
                )
            self._parameters.minimum_speech_duration = parameters.minimum_speech_duration

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
            context.set_parameter(aic_sdk.VadParameter.Sensitivity, self._parameters.sensitivity)
        if self._parameters.speech_hold_duration is not None:
            context.set_parameter(
                aic_sdk.VadParameter.SpeechHoldDuration,
                self._parameters.speech_hold_duration,
            )
        if self._parameters.minimum_speech_duration is not None:
            context.set_parameter(
                aic_sdk.VadParameter.MinimumSpeechDuration,
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
            logger.error("Failed to terminate ai-coustics VAD session: %s", error)

    @agents.utils.log_exceptions(logger=logger)
    async def _main_task(self) -> None:
        native_vad = self._native_vad
        context = self._context
        assert native_vad is not None and context is not None

        input_sample_rate = 0
        inference_block_size = 0
        configured_format: tuple[int, int] | None = None
        inference_buffer = bytearray()

        prefix_frames: deque[rtc.AudioFrame] = deque()
        prefix_samples = 0
        speech_frames: list[rtc.AudioFrame] = []
        speech_samples = 0
        speech_buffer_full = False

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
            nonlocal speaking, speech_duration, silence_duration
            nonlocal raw_speech_duration, raw_silence_duration
            nonlocal current_sample, timestamp

            context.reset()
            input_sample_rate = 0
            inference_block_size = 0
            inference_buffer.clear()
            prefix_frames.clear()
            prefix_samples = 0
            speech_frames.clear()
            speech_samples = 0
            speech_buffer_full = False
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
            target_samples = int(self._prefix_padding_duration * frame.sample_rate)
            while len(prefix_frames) > 1 and (
                prefix_samples - prefix_frames[0].samples_per_channel >= target_samples
            ):
                prefix_samples -= prefix_frames.popleft().samples_per_channel

        def append_speech_frame(frame: rtc.AudioFrame) -> None:
            nonlocal speech_samples, speech_buffer_full

            max_samples = int(
                (self._prefix_padding_duration + self._max_buffered_speech) * frame.sample_rate
            )
            if speech_samples + frame.samples_per_channel <= max_samples:
                speech_frames.append(frame)
                speech_samples += frame.samples_per_channel
            elif not speech_buffer_full:
                speech_buffer_full = True
                logger.warning(
                    "max_buffered_speech reached; ignoring further audio for the current speech"
                )

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
                        await native_vad.initialize_async(
                            aic_sdk.ProcessorConfig(
                                sample_rate=input_sample_rate,
                                block_size=inference_block_size,
                                variable_block_size=False,
                            )
                        )
                        configured_format = stream_format
                elif input_frame.sample_rate != input_sample_rate:
                    logger.error("a frame with another sample rate was already pushed")
                    continue

                mono_frame = to_mono(input_frame)
                inference_buffer.extend(mono_frame.data.cast("b"))

                block_bytes = inference_block_size * np.dtype(np.int16).itemsize
                while len(inference_buffer) >= block_bytes:
                    pcm = bytes(inference_buffer[:block_bytes])
                    del inference_buffer[:block_bytes]
                    block = _pcm16_to_float32(memoryview(pcm))

                    started = time.perf_counter()
                    await native_vad.process_async(block)
                    inference_duration = time.perf_counter() - started

                    probability = context.raw_vad_probability()
                    detected = context.is_speech_detected()
                    block_duration = inference_block_size / input_sample_rate
                    current_sample += inference_block_size
                    timestamp += block_duration

                    sensitivity = context.get_parameter(aic_sdk.VadParameter.Sensitivity)
                    if probability >= sensitivity:
                        raw_speech_duration += block_duration
                        raw_silence_duration = 0.0
                    else:
                        raw_silence_duration += block_duration
                        raw_speech_duration = 0.0

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
                        append_speech_frame(inference_audio)

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
                            raw_accumulated_silence=raw_silence_duration,
                            raw_accumulated_speech=raw_speech_duration,
                        )
                    )

                    if detected and not speaking:
                        speaking = True
                        silence_duration = 0.0
                        speech_duration = max(block_duration, raw_speech_duration)
                        speech_frames[:] = prefix_frames
                        speech_samples = sum(frame.samples_per_channel for frame in speech_frames)
                        self._event_ch.send_nowait(
                            agents.vad.VADEvent(
                                type=agents.vad.VADEventType.START_OF_SPEECH,
                                samples_index=current_sample,
                                timestamp=timestamp,
                                speech_duration=speech_duration,
                                silence_duration=0.0,
                                frames=list(speech_frames),
                                probability=probability,
                                inference_duration=inference_duration,
                                speaking=True,
                                raw_accumulated_speech=raw_speech_duration,
                            )
                        )
                    elif not detected and speaking:
                        speaking = False
                        silence_duration = raw_silence_duration
                        completed_speech_duration = max(0.0, speech_duration - raw_silence_duration)
                        self._event_ch.send_nowait(
                            agents.vad.VADEvent(
                                type=agents.vad.VADEventType.END_OF_SPEECH,
                                samples_index=current_sample,
                                timestamp=timestamp,
                                speech_duration=completed_speech_duration,
                                silence_duration=silence_duration,
                                frames=list(speech_frames),
                                probability=probability,
                                inference_duration=inference_duration,
                                speaking=False,
                                raw_accumulated_silence=raw_silence_duration,
                            )
                        )
                        speech_duration = 0.0
                        speech_frames.clear()
                        speech_samples = 0
                        speech_buffer_full = False

                    if (
                        inference_duration > block_duration
                        and started - self._last_slow_warning > _SLOW_WARNING_INTERVAL
                    ):
                        self._last_slow_warning = started
                        logger.warning(
                            "ai-coustics VAD inference is slower than realtime "
                            "(%.1f ms for a %.1f ms block)",
                            inference_duration * 1000,
                            block_duration * 1000,
                        )
        finally:
            await self._terminate_session()
