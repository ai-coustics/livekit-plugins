# ai-coustics LiveKit plugin for Python

This package adapts `aic_sdk.Processor` to LiveKit's
`rtc.FrameProcessor[rtc.AudioFrame]` interface.

```python
from livekit.plugins import ai_coustics

noise_cancellation = ai_coustics.audio_enhancement(
    model="quail-vf-2.2-l-16khz",
    model_parameters=ai_coustics.ModelParameters(enhancement_level=1.0),
)

# An explicit .aicmodel path avoids network access at startup:
# noise_cancellation = ai_coustics.audio_enhancement(model="./models/quail.aicmodel")
```

Set `AIC_SDK_LICENSE` or pass `license_key=` explicitly. Artifact model IDs are downloaded and
cached under `~/.cache/aic-sdk/models`. Model loading and native Processor construction happen in
the constructor; synchronous SDK construction errors fail immediately, while backend
authentication uses the SDK's grace period. Pass `noise_cancellation` wherever LiveKit accepts an
`rtc.FrameProcessor[rtc.AudioFrame]`.
Use `ai_coustics.download_model(model_id, download_dir)` during a deployment build and pass its
returned path at runtime when workers must start fully offline.

The distribution is named `ai-coustics-livekit`, while its import uses LiveKit's plugin namespace.
It replaces `livekit-plugins-ai-coustics`; installing both packages in one environment is not
supported because they provide the same `livekit.plugins.ai_coustics` import path.

This release integrates noise cancellation through the SDK Processor. A LiveKit VAD adapter will
be added separately.
