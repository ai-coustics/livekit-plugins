from __future__ import annotations

from livekit import rtc
from livekit.plugins.ai_coustics import FrameProcessorChain


def make_frame(value: int) -> rtc.AudioFrame:
    return rtc.AudioFrame(
        data=value.to_bytes(2, byteorder="little", signed=True),
        sample_rate=16000,
        num_channels=1,
        samples_per_channel=1,
    )


class RecordingProcessor(rtc.FrameProcessor[rtc.AudioFrame]):
    def __init__(
        self,
        name: str,
        calls: list[tuple[str, object]],
        *,
        output: rtc.AudioFrame | None = None,
        close_error: Exception | None = None,
    ) -> None:
        self.name = name
        self.calls = calls
        self.output = output
        self.close_error = close_error
        self._enabled = True

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = value

    def _on_stream_info_updated(
        self,
        *,
        room_name: str,
        participant_identity: str,
        publication_sid: str,
    ) -> None:
        self.calls.append(
            (
                self.name,
                ("stream", room_name, participant_identity, publication_sid),
            )
        )

    def _on_stream_info_cleared(self) -> None:
        self.calls.append((self.name, "stream_cleared"))

    def _process(self, frame: rtc.AudioFrame) -> rtc.AudioFrame:
        self.calls.append((self.name, frame))
        return self.output or frame

    def _close(self) -> None:
        self.calls.append((self.name, "close"))
        if self.close_error is not None:
            raise self.close_error


def test_processes_enabled_children_in_order() -> None:
    calls: list[tuple[str, object]] = []
    input_frame = make_frame(1)
    intermediate_frame = make_frame(2)
    output_frame = make_frame(3)
    first = RecordingProcessor("first", calls, output=intermediate_frame)
    second = RecordingProcessor("second", calls, output=output_frame)
    chain = FrameProcessorChain(first, second)

    assert chain._process(input_frame) is output_frame
    assert calls == [("first", input_frame), ("second", intermediate_frame)]

    calls.clear()
    second.enabled = False
    assert chain._process(input_frame) is intermediate_frame
    assert calls == [("first", input_frame)]

    calls.clear()
    chain.enabled = False
    assert chain._process(input_frame) is input_frame
    assert calls == []


def test_forwards_stream_lifecycle_to_both_children_in_order() -> None:
    calls: list[tuple[str, object]] = []
    chain = FrameProcessorChain(
        RecordingProcessor("first", calls),
        RecordingProcessor("second", calls),
    )

    chain._on_stream_info_updated(
        room_name="room",
        participant_identity="participant",
        publication_sid="TR_test",
    )
    chain._on_stream_info_cleared()
    chain._on_credentials_updated(token="token", url="wss://example.test")
    chain._on_credentials_cleared()

    assert calls == [
        ("first", ("stream", "room", "participant", "TR_test")),
        ("second", ("stream", "room", "participant", "TR_test")),
        ("first", "stream_cleared"),
        ("second", "stream_cleared"),
    ]


def test_close_is_idempotent_and_closes_both_after_an_error() -> None:
    calls: list[tuple[str, object]] = []
    chain = FrameProcessorChain(
        RecordingProcessor("first", calls, close_error=RuntimeError("failed")),
        RecordingProcessor("second", calls),
    )

    try:
        chain._close()
    except RuntimeError as error:
        assert str(error) == "failed"
    else:
        raise AssertionError("expected close to raise")

    chain._close()
    assert calls == [("first", "close"), ("second", "close")]
    assert not chain.enabled
