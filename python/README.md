# ai-coustics LiveKit plugin for Python

This package adapts `aic_sdk.Processor` to LiveKit's
`rtc.FrameProcessor[rtc.AudioFrame]` interface.

```python
from livekit.plugins import ai_coustics

model_path = ai_coustics.Model.download("quail-vf-2.2-l-16khz", "./models")
model = ai_coustics.Model.from_file(model_path)

noise_cancellation = ai_coustics.Processor(
    model=model,
    processor_parameters=ai_coustics.ProcessorParameters(enhancement_level=1.0),
)

# For a model provisioned during deployment, skip the download:
# model = ai_coustics.Model.from_file("./models/quail.aicmodel")
```

Set `AIC_SDK_LICENSE` or pass `license_key=` explicitly. `Processor` requires an SDK `Model` loaded
separately with `Model.from_file`; `Model.download` returns a file path when an application wants
the SDK to fetch an artifact first. Synchronous SDK construction errors fail immediately, while
backend authentication uses the SDK's grace period. Pass `noise_cancellation` wherever LiveKit
accepts an `rtc.FrameProcessor[rtc.AudioFrame]`.

The distribution is named `ai-coustics-livekit`, while its import uses LiveKit's plugin namespace.
It replaces `livekit-plugins-ai-coustics`; installing both packages in one environment is not
supported because they provide the same `livekit.plugins.ai_coustics` import path.

This release integrates noise cancellation through the SDK Processor. A LiveKit VAD adapter will
be added separately.
