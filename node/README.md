# ai-coustics LiveKit plugin for Node.js

This package adapts `@ai-coustics/aic-sdk`'s `Processor` and standalone `Vad` to LiveKit Agents.

```ts
import { Model, Processor, VAD } from "@ai-coustics/livekit-agents";

const modelPath = Model.download("quail-vf-2.2-l-16khz", "./models");
const model = Model.fromFile(modelPath);

const noiseCancellation = new Processor({
  model,
  processorParameters: { enhancementLevel: 1.0 },
});

const vadModelPath = Model.download("vad-2.1-xxs-16khz", "./models");
const vadModel = Model.fromFile(vadModelPath);
const vad = new VAD({
  model: vadModel,
  vadParameters: { sensitivity: 0.5 },
});

// For a model provisioned during deployment, skip the download:
// const model = Model.fromFile("./models/quail.aicmodel");
```

Set `AIC_SDK_LICENSE` or pass `licenseKey` explicitly. `Processor` requires an SDK `Model` loaded
separately with `Model.fromFile`; `Model.download` returns a file path when an application wants
the SDK to fetch an artifact first. Synchronous SDK construction errors fail immediately, while
backend authentication uses the SDK's grace period. Pass `noiseCancellation` wherever LiveKit
accepts a `FrameProcessor<AudioFrame>`.

This package is not currently compatible with `npx livekit-agents download-files`. Download the
required models explicitly during application or container setup and load their files with
`Model.fromFile` at runtime.

Pass `vad` as the `vad` option to a LiveKit `AgentSession`. Each LiveKit VAD stream owns a native
SDK VAD session. The adapter downmixes multichannel input and reblocks it at the incoming sample
rate without resampling; the SDK performs model-rate conversion internally. It emits inference,
start-of-speech, and end-of-speech events, including one bounded contiguous mono audio frame for
each speech candidate.

`VADParameters.sensitivity`, `speechHoldDuration`, and `minimumSpeechDuration` use the SDK's
native units; both durations are seconds. `prefixPaddingDuration`, `maxBufferedSpeech`, LiveKit
event durations, and `minSilenceDuration` use milliseconds, following the Node LiveKit Agents API.
The default 50 ms minimum speech and 250 ms speech hold satisfy LiveKit's streaming turn-detector
expectations. `setParameters()` applies partial updates to active and future streams.

The SDK 0.22 Processor accepts mono audio. Multichannel LiveKit frames are downmixed before
processing, then the enhanced mono signal is duplicated across the original channel count so the
output retains the input frame geometry.
