# ai-coustics LiveKit plugin for Python

This package adapts `aic_sdk.Processor` to LiveKit's
`rtc.FrameProcessor[rtc.AudioFrame]` interface and `aic_sdk.VadAsync` to LiveKit Agents' streaming
VAD interface.

```python
from livekit.plugins import ai_coustics

model_path = ai_coustics.Model.download("quail-vf-2.2-l-16khz", "./models")
model = ai_coustics.Model.from_file(model_path)

noise_cancellation = ai_coustics.Processor(
    model=model,
    processor_parameters=ai_coustics.ProcessorParameters(enhancement_level=1.0),
)

vad_model_path = ai_coustics.Model.download("vad-2.1-xxs-16khz", "./models")
vad_model = ai_coustics.Model.from_file(vad_model_path)
vad = ai_coustics.VAD(
    model=vad_model,
    vad_parameters=ai_coustics.VADParameters(
        sensitivity=0.5,
        speech_hold_duration=0.25,
        minimum_speech_duration=0.05,
    ),
)

# For a model provisioned during deployment, skip the download:
# model = ai_coustics.Model.from_file("./models/quail.aicmodel")
```

Set `AIC_SDK_LICENSE` or pass `license_key=` explicitly. `Processor` requires an SDK `Model` loaded
separately with `Model.from_file`; `Model.download` returns a file path when an application wants
the SDK to fetch an artifact first. Synchronous SDK construction errors fail immediately, while
backend authentication uses the SDK's grace period. Pass `noise_cancellation` wherever LiveKit
accepts an `rtc.FrameProcessor[rtc.AudioFrame]`.

This package is not currently compatible with `python -m livekit.agents download-files`. Download
the required models explicitly during application or container setup and load their files with
`Model.from_file` at runtime.

Pass `vad` to `AgentSession(vad=vad, ...)`. VAD requires a dedicated VAD model; enhancement models
cannot be reused for it. Each LiveKit VAD stream owns an independent SDK VAD session. Incoming
audio is downmixed to mono and reblocked at its original sample rate. The SDK handles any model-rate
conversion internally, while event audio remains at the LiveKit input rate. Processing runs
asynchronously outside the agent event loop.

The wrapper defaults to 50 ms of minimum speech and a 250 ms speech hold, matching LiveKit's VAD
expectations and streaming turn-detector requirement. Override either value with `VADParameters`
when a different endpointing profile is needed.

The underlying aic-sdk 3 Processor accepts mono audio. Multichannel LiveKit frames are downmixed
to mono for processing, then the enhanced signal is duplicated across the original channel count.

The distribution is named `ai-coustics-livekit`, while its import uses LiveKit's plugin namespace.
It replaces `livekit-plugins-ai-coustics`; installing both packages in one environment is not
supported because they provide the same `livekit.plugins.ai_coustics` import path.

The Node.js package also provides Processor and standalone VAD integrations with the corresponding
camelCase API.
