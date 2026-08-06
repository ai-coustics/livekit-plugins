# ai-coustics LiveKit plugin for Python

This package adapts `aic_sdk.Processor` to LiveKit's
`rtc.FrameProcessor[rtc.AudioFrame]` interface.

```python
from aic_sdk import Model
from livekit.plugins import ai_coustics

model_path = Model.download("quail-vf-2.1-l-16khz", "./models")
model = Model.from_file(model_path)

noise_cancellation = ai_coustics.audio_enhancement(
    model=model,
    enhancement_level=1.0,
)
```

Set `AIC_SDK_LICENSE` or pass `license_key=` explicitly. Download and load the model while the
agent is starting, not from an audio callback. Pass `noise_cancellation` wherever LiveKit accepts
an `rtc.FrameProcessor[rtc.AudioFrame]`.

The distribution is named `ai-coustics-livekit`, while its import uses LiveKit's plugin namespace.
It replaces `livekit-plugins-ai-coustics`; installing both packages in one environment is not
supported because they provide the same `livekit.plugins.ai_coustics` import path.

This release integrates noise cancellation through the SDK Processor. A LiveKit VAD adapter will
be added separately.
