# ai-coustics LiveKit plugin for Node.js

This package adapts `@ai-coustics/aic-sdk`'s `Processor` to LiveKit's
`FrameProcessor<AudioFrame>` interface.

```ts
import { Model, Processor } from "@ai-coustics/livekit-agents";

const modelPath = Model.download("quail-vf-2.2-l-16khz", "./models");
const model = Model.fromFile(modelPath);

const noiseCancellation = new Processor({
  model,
  processorParameters: { enhancementLevel: 1.0 },
});

// For a model provisioned during deployment, skip the download:
// const model = Model.fromFile("./models/quail.aicmodel");
```

Set `AIC_SDK_LICENSE` or pass `licenseKey` explicitly. `Processor` requires an SDK `Model` loaded
separately with `Model.fromFile`; `Model.download` returns a file path when an application wants
the SDK to fetch an artifact first. Synchronous SDK construction errors fail immediately, while
backend authentication uses the SDK's grace period. Pass `noiseCancellation` wherever LiveKit
accepts a `FrameProcessor<AudioFrame>`.

This release integrates noise cancellation through the SDK Processor. A LiveKit VAD adapter will
be added separately.
