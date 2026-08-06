# ai-coustics LiveKit plugin for Node.js

This package adapts `@ai-coustics/aic-sdk`'s `Processor` to LiveKit's
`FrameProcessor<AudioFrame>` interface.

```ts
import { Model, audioEnhancement } from "@ai-coustics/livekit-agents";

const modelPath = Model.download("quail-vf-2.1-l-16khz", "./models");
const model = Model.fromFile(modelPath);

const noiseCancellation = audioEnhancement({
  model,
  enhancementLevel: 1.0,
});
```

Set `AIC_SDK_LICENSE` or pass `licenseKey` explicitly. Download and load the model while the agent
is starting, not from an audio callback. Pass `noiseCancellation` wherever LiveKit accepts a
`FrameProcessor<AudioFrame>`.

This release integrates noise cancellation through the SDK Processor. A LiveKit VAD adapter will
be added separately.
