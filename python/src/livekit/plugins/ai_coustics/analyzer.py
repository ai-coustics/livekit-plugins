from __future__ import annotations

import asyncio
import math
from collections.abc import Callable

import aic_sdk
import numpy as np

from livekit import rtc

from .log import logger
from .processor import _license_key, _pcm16_to_float32

_DEFAULT_ANALYSIS_INTERVAL = 5.0


class Collector(rtc.FrameProcessor[rtc.AudioFrame]):
    """Transparent LiveKit frame processor that collects audio for an :class:`Analyzer`."""

    def __init__(
        self,
        native_collector: aic_sdk.Collector,
        *,
        reset_analyzer: Callable[[], None],
        close_analyzer: Callable[[], None],
    ) -> None:
        self._collector: aic_sdk.Collector | None = native_collector
        self._reset_analyzer = reset_analyzer
        self._close_analyzer = close_analyzer
        self._format: tuple[int, int, int] | None = None
        self._enabled = True
        self._closed = False

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        if self._closed or value == self._enabled:
            return
        if value:
            self._reset()
        self._enabled = value

    @property
    def initialized(self) -> bool:
        return self._format is not None and self._collector is not None

    def _on_stream_info_updated(
        self,
        *,
        room_name: str,
        participant_identity: str,
        publication_sid: str,
    ) -> None:
        self._reset()

    def _on_stream_info_cleared(self) -> None:
        self._reset()

    def _reset(self) -> None:
        if self._closed:
            return
        try:
            self._reset_analyzer()
        except Exception as error:
            logger.error("Failed to reset ai-coustics Analyzer: %s", error)

    def _process(self, frame: rtc.AudioFrame) -> rtc.AudioFrame:
        collector = self._collector
        if not self._enabled or collector is None:
            return frame

        try:
            stream_format = (
                frame.sample_rate,
                frame.num_channels,
                frame.samples_per_channel,
            )
            if self._format != stream_format:
                collector.initialize(
                    aic_sdk.ProcessorConfig(
                        sample_rate=frame.sample_rate,
                        block_size=frame.samples_per_channel,
                        variable_block_size=False,
                    )
                )
                self._format = stream_format

            samples = _pcm16_to_float32(frame.data)
            expected_samples = frame.samples_per_channel * frame.num_channels
            if samples.size != expected_samples:
                raise ValueError(
                    f"AudioFrame contains {samples.size} samples, expected {expected_samples}"
                )

            channels = samples.reshape(frame.samples_per_channel, frame.num_channels)
            mono = (
                channels[:, 0].copy()
                if frame.num_channels == 1
                else channels.mean(axis=1, dtype=np.float32)
            )
            collector.buffer(mono)
        except Exception:
            logger.exception("ai-coustics Collector failed; passing audio through")

        return frame

    def _detach(self) -> None:
        self._closed = True
        self._enabled = False
        self._format = None
        self._collector = None

    def _close(self) -> None:
        if self._closed:
            return
        self._detach()
        self._close_analyzer()


class Analyzer:
    """Periodically analyzes audio buffered by a transparent LiveKit Collector."""

    def __init__(
        self,
        *,
        model: aic_sdk.Model,
        license_key: str | None = None,
        analysis_interval: float = _DEFAULT_ANALYSIS_INTERVAL,
    ) -> None:
        if not math.isfinite(analysis_interval) or analysis_interval <= 0.0:
            raise ValueError("analysis_interval must be a finite value greater than zero")

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            raise RuntimeError(
                "ai-coustics Analyzer must be created while an event loop is running"
            ) from None

        resolved_license_key = _license_key(license_key)
        aic_sdk.set_sdk_id(8)  # type: ignore[attr-defined]
        try:
            native_collector, native_analyzer = aic_sdk.analyzer_pair(model, resolved_license_key)
        except Exception as error:
            raise RuntimeError(f"Failed to create ai-coustics Analyzer: {error}") from error

        self._native_analyzer: aic_sdk.Analyzer | None = native_analyzer
        self._analysis_interval = analysis_interval
        self._closed = False
        self._close_event = asyncio.Event()
        self._close_task: asyncio.Task[None] | None = None
        self.collector = Collector(
            native_collector,
            reset_analyzer=native_analyzer.reset,
            close_analyzer=self._request_close,
        )
        self._task = loop.create_task(self._analysis_loop(), name="ai-coustics-analyzer")

    async def _terminate_session(self) -> None:
        native_analyzer = self._native_analyzer
        self._native_analyzer = None
        if native_analyzer is None:
            return
        try:
            await asyncio.to_thread(native_analyzer.terminate_session)
        except Exception:
            logger.exception("Failed to terminate ai-coustics Analyzer session")

    async def _analyze_once(self, native_analyzer: aic_sdk.Analyzer) -> None:
        result = await asyncio.to_thread(native_analyzer.analyze_buffered)

        logger.info(
            "ai-coustics analysis result",
            extra={
                "model_provider": "ai-coustics",
                "risk_score": result.risk_score,
                "speaker_reverb": result.speaker_reverb,
                "speaker_loudness": result.speaker_loudness,
                "interfering_speech": result.interfering_speech,
                "media_speech": result.media_speech,
                "noise": result.noise,
                "packet_loss": result.packet_loss,
            },
        )

    async def _analysis_loop(self) -> None:
        native_analyzer = self._native_analyzer
        assert native_analyzer is not None
        try:
            while not self._close_event.is_set():
                try:
                    await asyncio.wait_for(
                        self._close_event.wait(), timeout=self._analysis_interval
                    )
                    break
                except asyncio.TimeoutError:
                    pass
                if not self.collector.initialized:
                    continue
                try:
                    await self._analyze_once(native_analyzer)
                except Exception:
                    logger.exception("ai-coustics Analyzer failed to analyze buffered audio")
        finally:
            await self._terminate_session()

    async def _finish_close(self) -> None:
        await self._task
        # Keep an idempotent fallback in case the loop exits before entering its try/finally.
        await self._terminate_session()

    def _request_close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.collector._detach()
        self._close_event.set()
        self._close_task = asyncio.create_task(
            self._finish_close(), name="ai-coustics-analyzer-close"
        )

    async def aclose(self) -> None:
        """Stop scheduled analysis and terminate the SDK session."""

        self._request_close()
        assert self._close_task is not None
        await self._close_task
