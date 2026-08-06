# ai-coustics LiveKit plugin for Node.js

This package adapts `@ai-coustics/aic-sdk`'s `Processor` to LiveKit's
`FrameProcessor<AudioFrame>` interface.

```ts
import { audioEnhancement } from "@ai-coustics/livekit-agents";

const noiseCancellation = audioEnhancement({
  model: "quail-vf-2.2-l-16khz",
  modelParameters: { enhancementLevel: 1.0 },
});

// An explicit .aicmodel path avoids network access at startup:
// const noiseCancellation = audioEnhancement({ model: "./models/quail.aicmodel" });
```

Set `AIC_SDK_LICENSE` or pass `licenseKey` explicitly. Artifact model IDs are downloaded and
cached under `~/.cache/aic-sdk/models`. Model loading and license validation happen in the
constructor, so create the filter before starting the session. Pass `noiseCancellation` wherever
LiveKit accepts a `FrameProcessor<AudioFrame>`.
Use `downloadModel(modelId, downloadDir)` during a deployment build and pass its returned path at
runtime when workers must start fully offline.

This release integrates noise cancellation through the SDK Processor. A LiveKit VAD adapter will
be added separately.
