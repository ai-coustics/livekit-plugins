# ai-coustics LiveKit plugin for Node.js

Audio enhancement and voice activity detection for LiveKit Agents, backed by the public
`@ai-coustics/aic-sdk` package.

> This package replaces `@livekit/plugins-ai-coustics`. Uninstall the official package before
> migrating, and do not mix objects from the two implementations.

## Installation

```bash
npm uninstall @livekit/plugins-ai-coustics
npm install @ai-coustics/livekit-plugin
export AIC_SDK_LICENSE=...
```

## Model provisioning

Download models during deployment or container setup:

```ts
import { Model } from "@ai-coustics/livekit-plugin";

const enhancementPath = Model.download("quail-vf-2.2-l-16khz", "./models");
const vadPath = Model.download("vad-2.1-xxs-16khz", "./models");
```

Enhancement and VAD models are different model types. Make the returned paths available to your
worker, then load each model once per worker process:

```ts
const enhancementModel = Model.fromFile(enhancementPath);
const vadModel = Model.fromFile(vadPath);
```

## Usage

Create a `Processor` and `VAD` for each agent session:

```ts
import { voice } from "@livekit/agents";
import { Processor, VAD } from "@ai-coustics/livekit-plugin";

const processor = new Processor({ model: enhancementModel });
const vad = new VAD({ model: vadModel });

const session = new voice.AgentSession({
  vad,
  // ... stt, llm, tts
});

await session.start({
  // ... agent, room
  inputOptions: { noiseCancellation: processor },
});
```

Use either component independently by omitting the other from the configuration.

## Configuration

Set the enhancement level through the Processor context, and configure all SDK VAD parameters on
the VAD factory:

```ts
import { ProcessorParameter } from "@ai-coustics/livekit-plugin";

processor.getContext().setParameter(ProcessorParameter.EnhancementLevel, 0.8);
vad.setParameters({
  sensitivity: 0.5,
  speechHoldDuration: 0.25,
  minimumSpeechDuration: 0.05,
});
```

SDK VAD parameter durations (`speechHoldDuration` and `minimumSpeechDuration`) are specified in
seconds. The `VAD` constructor options `prefixPaddingDuration` and `maxBufferedSpeech` are specified
in milliseconds. See the
[Node.js SDK reference](https://docs.ai-coustics.com/reference/sdk/language-bindings/nodejs) and
[VAD guide](https://docs.ai-coustics.com/models/voice-activity-detection/vad) for parameter ranges,
model support, and further details.

Set `AIC_SDK_LICENSE` or pass `licenseKey` to the constructor. Create a new Processor for each
concurrent room; RoomIO closes it with the input stream.

Models must be provisioned explicitly. This package does not support
`npx livekit-agents download-files`.

When Processor and VAD are enabled together, RoomIO sends enhanced audio to the VAD. See the
repository's [architecture notes](https://github.com/ai-coustics/livekit-plugins/blob/main/DEVELOPMENT.md#raw-audio-fan-out-for-combined-processor-and-vad-use)
if your application requires both components to receive the original microphone signal.
