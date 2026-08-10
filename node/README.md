# ai-coustics LiveKit plugin for Node.js

Audio enhancement, voice activity detection, and audio-quality analysis for LiveKit Agents, backed by the public
`@ai-coustics/aic-sdk` package.

> This package replaces `@livekit/plugins-ai-coustics`. Uninstall the official package before
> migrating, and do not mix objects from the two implementations.

## Installation

```bash
npm uninstall @livekit/plugins-ai-coustics
npm install @ai-coustics/livekit-plugin
export AIC_SDK_LICENSE=...
```

## Migrating from the official LiveKit plugin

Replace the package import and update the following APIs:

| Official LiveKit plugin | This package |
| --- | --- |
| `audioEnhancement(...)` | `new Processor({ model })` |
| `EnhancerModel.*` | An SDK `Model` loaded from a provisioned model file |
| `modelParameters` or `updateModelParameters(...)` | `processor.getContext().setParameter(...)` |
| `vad()` and `vadSettings` | `new VAD({ model, vadParameters })` |
| `Auth.livekitCloud()` or `Auth.aiCousticsApi(...)` | `AIC_SDK_LICENSE` or `licenseKey` |

Before:

```ts
import * as aic from "@livekit/plugins-ai-coustics";

const processor = aic.audioEnhancement({ model: aic.EnhancerModel.QuailL });
const vad = aic.vad();
```

After loading the SDK models as described below:

```ts
import { Processor, VAD } from "@ai-coustics/livekit-plugin";

const processor = new Processor({ model: enhancementModel });
const vad = new VAD({ model: vadModel });
```

Unlike the official VAD, this package's VAD runs a dedicated SDK VAD model and does not depend on
Processor metadata. Provision a separate VAD model if you use it. LiveKit Cloud authentication is
not carried over; obtain an ai-coustics SDK license before migrating.

## Model provisioning

Download models during deployment or container setup:

```ts
import { Model } from "@ai-coustics/livekit-plugin";

const enhancementPath = Model.download("quail-vf-2.2-l-16khz", "./models");
const vadPath = Model.download("vad-2.1-xxs-16khz", "./models");
const analysisPath = Model.download("tyto-l-16khz", "./models");
```

Enhancement and VAD models are different model types. Make the returned paths available to your
worker, then load each model once per worker process:

```ts
const enhancementModel = Model.fromFile(enhancementPath);
const vadModel = Model.fromFile(vadPath);
const analysisModel = Model.fromFile(analysisPath);
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

### Audio-quality analysis

Create an `Analyzer` and pass its collector as the room's frame processor:

```ts
import { Analyzer } from "@ai-coustics/livekit-plugin";

const analyzer = new Analyzer({
  model: analysisModel,
  analysisInterval: 5, // seconds; 5 is the default
});

analyzer.on("analysisResult", (event) => {
  // Log it, send it to an alerting pipeline, or retain a session summary.
  console.log(event.sequence, event.result.riskScore, event.inferenceDuration);
});

await session.start({
  // ... agent, room
  inputOptions: { noiseCancellation: analyzer.collector },
});
```

`Collector` passes every frame through unchanged while buffering a mono copy for the SDK. The
`Analyzer` calls `analyzeBuffered()` at the configured interval. Every successful call emits an
`analysisResult` event. Successful results are not logged by the plugin; applications can opt in
from the callback. The frozen event and score snapshot contain the model and stream identity,
completion timestamp, inference duration, and a monotonically increasing sequence number. Event
callbacks run synchronously; queue any network and database work so it does not delay the analyzer
timer. RoomIO closes the collector and its analyzer together; call `analyzer.close()` yourself if
the collector is not owned by RoomIO.

The analyzer also records three low-cardinality OpenTelemetry instruments by default:

- `ai_coustics.analyzer.analysis`, a counter with `status=ok|error`
- `ai_coustics.analyzer.inference_duration`, a histogram in seconds with the same status
- `ai_coustics.analyzer.score`, a histogram for every SDK score with a bounded `score.name`
  attribute

They use the process-wide `@opentelemetry/api` `MeterProvider`. LiveKit Agents for Node does not
currently install a metrics SDK or exporter, so applications must register a provider such as
`@opentelemetry/sdk-metrics` before creating the analyzer. Without one, the OpenTelemetry API is a
safe no-op and events and logs still work. Set `enableMetrics: false` to disable instrumentation.
Do not turn room, participant, or publication IDs into metric attributes; those high-cardinality
values are available on `AnalysisEvent` for traces, alerts, and application-owned records instead.

This is a temporary integration through LiveKit's single `noiseCancellation` slot. Consequently,
the analyzer collector cannot be installed there alongside `Processor`. A future LiveKit audio-tap
API should allow analysis to run as a true side channel. The current Node SDK analyzer API is
synchronous, so each scheduled inference briefly occupies the agent's JavaScript thread.

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
