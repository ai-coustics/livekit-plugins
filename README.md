# ai-coustics plugins for LiveKit Agents

This repository contains ai-coustics-maintained noise cancellation plugins for both LiveKit
Agents runtimes:

- `python/`: `aic_sdk.Processor` adapted to Python's `rtc.FrameProcessor[rtc.AudioFrame]`
- `node/`: `@ai-coustics/aic-sdk` adapted to Node's `FrameProcessor<AudioFrame>`

Only the SDK `Processor` is integrated for now. LiveKit VAD adapters are intentionally out of
scope for this first version.

## Design

The plugins use the public ai-coustics SDK directly. `Processor` accepts an already-loaded SDK
`Model`, never a model ID or file path. Both packages expose the SDK's `Model.from_file` /
`Model.fromFile` and `Model.download` APIs so applications can choose explicitly when and where
models are downloaded and loaded.

Model loading and native Processor construction happen when the filter is constructed. Any
synchronous SDK construction error is raised with its original error attached. Backend
authentication continues asynchronously during the SDK's grace period, so the plugin does not
probe it by processing a throwaway frame. The Processor is configured when the first LiveKit frame
reveals the complete stream geometry. Every LiveKit frame is processed in one fixed-size SDK call.
This uses the SDK's own frame adapter, preserves frame shape and metadata, and measured lower
latency than enabling the SDK's variable-frame mode.

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

# For a model provisioned during deployment, skip the download:
# model = ai_coustics.Model.from_file("./models/quail.aicmodel")
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

Both implementations expose runtime `ProcessorParameters`, plus the underlying Processor context
(`processor_context` in Python, `processorContext` in Node) for advanced parameter control and
output-delay inspection. Prefer `update_processor_parameters` / `updateProcessorParameters` or the
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
