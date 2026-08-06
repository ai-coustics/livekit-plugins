# ai-coustics plugins for LiveKit Agents

This repository contains ai-coustics-maintained noise cancellation plugins for both LiveKit
Agents runtimes:

- `python/`: `aic_sdk.Processor` adapted to Python's `rtc.FrameProcessor[rtc.AudioFrame]`
- `node/`: `@ai-coustics/aic-sdk` adapted to Node's `FrameProcessor<AudioFrame>`

Only the SDK `Processor` is integrated for now. LiveKit VAD adapters are intentionally out of
scope for this first version.

## Design

The plugins use the public ai-coustics SDK directly. Pass either an artifact model ID or a local
`.aicmodel` path. Model IDs are downloaded into `~/.cache/aic-sdk/models`; explicit file paths are
the fully offline option because resolving an ID may refresh the artifact manifest.

Model loading and native Processor construction happen when the filter is constructed. Any
synchronous SDK construction error is raised with its original error attached. Backend
authentication continues asynchronously during the SDK's grace period, so the plugin does not
probe it by processing a throwaway frame. The Processor is configured when the first LiveKit frame
reveals the complete stream geometry. Every LiveKit frame is processed in one fixed-size SDK call.
This uses the SDK's own frame adapter, preserves frame shape and metadata, and measured lower
latency than enabling the SDK's variable-frame mode.

For deployment builds, the exported `download_model` / `downloadModel` helpers can prefetch an
artifact ID into a chosen directory. Pass the returned path to the processor at runtime to avoid
artifact-manifest access when a worker starts.

## Python

Install the package from `python/`, set `AIC_SDK_LICENSE`, and construct the processor before
starting the agent:

```python
from livekit.plugins import ai_coustics

noise_cancellation = ai_coustics.audio_enhancement(
    model="quail-vf-2.2-l-16khz",  # artifact ID, downloaded and cached
    model_parameters=ai_coustics.ModelParameters(enhancement_level=1.0),
)

# For offline deployment, pass an explicit file path instead:
# noise_cancellation = ai_coustics.audio_enhancement(model="./models/quail.aicmodel")
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
import { audioEnhancement } from "@ai-coustics/livekit-agents";

const noiseCancellation = audioEnhancement({
  model: "quail-vf-2.2-l-16khz", // artifact ID, downloaded and cached
  modelParameters: { enhancementLevel: 1.0 },
});

// For offline deployment, use: model: "./models/quail.aicmodel"
```

Pass `noiseCancellation` anywhere LiveKit accepts a `FrameProcessor<AudioFrame>`.
`licenseKey` can be passed explicitly instead of using `AIC_SDK_LICENSE`.

Both implementations expose runtime `ModelParameters`, plus the underlying Processor context
(`processor_context` in Python, `processorContext` in Node) for advanced parameter control and
output-delay inspection. Prefer `update_model_parameters` / `updateModelParameters` or the
plugins' raw parameter setters when a value must survive stream format changes. Use bypass for
latency-compensated passthrough; disabling the processor returns immediate, undelayed input.

## Development

```bash
cd python
uv sync --dev
uv run pytest tests/test_processor.py
uv run pytest tests/test_integration.py  # requires AIC_SDK_LICENSE
uv run ruff check .
uv run mypy

cd ../node
npm install
npm test
npm run test:integration                 # requires AIC_SDK_LICENSE
npm run check
npm run build
```
