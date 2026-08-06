# ai-coustics plugins for LiveKit Agents

This repository contains ai-coustics-maintained noise cancellation plugins for both LiveKit
Agents runtimes:

- `python/`: `aic_sdk.Processor` adapted to Python's `rtc.FrameProcessor[rtc.AudioFrame]`
- `node/`: `@ai-coustics/aic-sdk` adapted to Node's `FrameProcessor<AudioFrame>`

Only the SDK `Processor` is integrated for now. LiveKit VAD adapters are intentionally out of
scope for this first version.

## Design

The plugins use the public ai-coustics SDK directly. A model and ai-coustics SDK license are
resolved when the filter is constructed; no model download or license lookup occurs in the audio
callback. The native Processor is initialized lazily when the first LiveKit frame reveals the
sample rate and channel count.

LiveKit commonly supplies frames larger than an ai-coustics model's optimal window. Each plugin
therefore initializes the SDK with the model's optimal frame count and variable-frame support,
then processes a LiveKit frame in optimal-sized blocks (plus a possible short tail). The returned
LiveKit frame always has the same shape and metadata as its input.

## Python

Install the package from `python/`, set `AIC_SDK_LICENSE`, and load or download the model before
starting the agent:

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

Pass `noise_cancellation` anywhere LiveKit accepts an
`rtc.FrameProcessor[rtc.AudioFrame]`, for example as the `noise_cancellation` value in room input
options. `license_key=` can be passed explicitly instead of using `AIC_SDK_LICENSE`.

The Python distribution is named `ai-coustics-livekit`, but its import follows LiveKit's plugin
namespace: `livekit.plugins.ai_coustics`. It replaces the official
`livekit-plugins-ai-coustics` package; do not install both in the same environment because they
provide the same import path.

## Node.js

Install the package from `node/`, set `AIC_SDK_LICENSE`, and construct the filter before starting
the agent:

```ts
import { Model, audioEnhancement } from "@ai-coustics/livekit-agents";

const modelPath = Model.download("quail-vf-2.1-l-16khz", "./models");
const model = Model.fromFile(modelPath);

const noiseCancellation = audioEnhancement({
  model,
  enhancementLevel: 1.0,
});
```

Pass `noiseCancellation` anywhere LiveKit accepts a `FrameProcessor<AudioFrame>`.
`licenseKey` can be passed explicitly instead of using `AIC_SDK_LICENSE`.

Both implementations expose the underlying Processor context (`processor_context` in Python,
`processorContext` in Node) for advanced parameter control and output-delay inspection. Prefer
the plugins' `set_parameter` / `setParameter` methods when a value must survive stream format
changes.

## Development

```bash
cd python
uv sync --dev
uv run pytest
uv run ruff check .
uv run mypy

cd ../node
npm install
npm test
npm run check
npm run build
```
