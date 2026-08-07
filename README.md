# ai-coustics plugins for LiveKit Agents

This repository contains ai-coustics-maintained noise cancellation plugins for both LiveKit
Agents runtimes:

- `python/`: `aic_sdk.Processor` and `aic_sdk.VadAsync` adapted to LiveKit Agents
- `node/`: `@ai-coustics/aic-sdk` adapted to Node's `FrameProcessor<AudioFrame>`

The Python package includes Processor and VAD integrations. The Node package currently includes
the Processor integration; its SDK now exposes the standalone VAD API, and the LiveKit adapter
will be added separately.

The plugins use the public ai-coustics SDK directly. Applications load or download SDK models and
pass them to `Processor` or Python `VAD`, retaining control over model provisioning and storage.

## Python

Install the package from `python/`, set `AIC_SDK_LICENSE`, and construct the processor before
starting the agent:

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
vad = ai_coustics.VAD(model=vad_model)

# For a model provisioned during deployment, skip the download:
# model = ai_coustics.Model.from_file("./models/quail.aicmodel")
```

Pass `noise_cancellation` anywhere LiveKit accepts an
`rtc.FrameProcessor[rtc.AudioFrame]`, for example as the `noise_cancellation` value in room input
options. `license_key=` can be passed explicitly instead of using `AIC_SDK_LICENSE`.

Pass `vad` as the `vad=` argument to a LiveKit `AgentSession`. It uses a dedicated VAD model and
does not depend on the noise-cancellation Processor. Its default 50 ms minimum speech and 250 ms
speech hold match LiveKit's streaming turn-detector requirements.

The Python distribution is named `ai-coustics-livekit`, but its import follows LiveKit's plugin
namespace: `livekit.plugins.ai_coustics`. It replaces the official
`livekit-plugins-ai-coustics` package; do not install both in the same environment because they
provide the same import path.

## Node.js

Install the package from `node/`, set `AIC_SDK_LICENSE`, and construct the filter before starting
the agent:

```ts
import { Model, Processor } from "@ai-coustics/livekit-agents";

const modelPath = Model.download("quail-vf-2.2-l-16khz", "./models");
const model = Model.fromFile(modelPath);

const noiseCancellation = new Processor({
  model,
  processorParameters: { enhancementLevel: 1.0 },
});

// For a provisioned model, use: Model.fromFile("./models/quail.aicmodel")
```

Pass `noiseCancellation` anywhere LiveKit accepts a `FrameProcessor<AudioFrame>`.
`licenseKey` can be passed explicitly instead of using `AIC_SDK_LICENSE`.

Both implementations expose runtime `ProcessorParameters`. Apply partial runtime updates with
`set_parameters` / `setParameters`; the SDK retains values across stream reconfiguration. Use
bypass for latency-compensated passthrough; disabling the processor returns immediate, undelayed
input.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for repository setup, architecture notes, test commands, and
the local LiveKit end-to-end environment.
