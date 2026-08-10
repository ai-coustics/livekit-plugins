# ai-coustics LiveKit plugin for Node.js

This package adapts `@ai-coustics/aic-sdk`'s `Processor` and standalone `Vad` to LiveKit Agents.

> **Replacement notice:** `@ai-coustics/livekit-plugin` replaces, and is not compatible with,
> LiveKit's official `@livekit/plugins-ai-coustics` package. It is not an extension for the
> official implementation. Although the packages have distinct import paths, do not install,
> configure, or mix their classes together. Uninstall the official package and migrate to the
> constructors shown below.

## Installation and model provisioning

```bash
npm uninstall @livekit/plugins-ai-coustics
npm install @ai-coustics/livekit-plugin
export AIC_SDK_LICENSE=...
```

Download models during application or container setup, not once per agent job:

```ts
import { Model } from "@ai-coustics/livekit-plugin";

console.log(Model.download("quail-vf-2.2-l-16khz", "./models"));
console.log(Model.download("vad-2.1-xxs-16khz", "./models"));
```

The first model is for enhancement and the second is for VAD. They are different model types and
cannot be substituted for one another. Save the returned paths as `AIC_ENHANCEMENT_MODEL_PATH` and
`AIC_VAD_MODEL_PATH`, or otherwise make the files available to the worker.

## Agent integration

Load model weights once per worker process and create stateful Processor and VAD instances for each
job. The Processor belongs in RoomIO's `noiseCancellation` option; the VAD belongs directly on
`AgentSession`:

```ts
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  voice,
} from "@livekit/agents";
import { fileURLToPath } from "node:url";

import {
  Model,
  Processor,
  ProcessorParameter,
  VAD,
} from "@ai-coustics/livekit-plugin";

const enhancementModel = Model.fromFile(
  process.env.AIC_ENHANCEMENT_MODEL_PATH!,
);
const vadModel = Model.fromFile(process.env.AIC_VAD_MODEL_PATH!);

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const processor = new Processor({ model: enhancementModel });
    processor.getContext().setParameter(ProcessorParameter.EnhancementLevel, 1.0);
    const vad = new VAD({ model: vadModel });

    const session = new voice.AgentSession({
      vad,
      stt: new inference.STT({ model: "deepgram/nova-3", language: "multi" }),
      llm: new inference.LLM({ model: "openai/gpt-4.1-mini" }),
      tts: new inference.TTS({ model: "cartesia/sonic-3" }),
    });

    await session.start({
      agent: new voice.Agent({
        instructions: "You are a helpful voice assistant. Keep replies concise.",
      }),
      room: ctx.room,
      inputOptions: {
        noiseCancellation: processor,
      },
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
```

The inference STT, LLM, and TTS instances are illustrative; keep the providers already used by
your agent. The ai-coustics-specific integration points are the `vad` session option and the
`noiseCancellation` input option.

Set `AIC_SDK_LICENSE` or pass `licenseKey` explicitly. SDK objects are constructed immediately,
while backend authentication continues during the SDK grace period. RoomIO owns a directly
configured Processor and closes it with its input stream. Do not share one Processor instance
between concurrent rooms. VAD streams are owned by `AgentSession`.

## Audio flow

To use enhancement only, configure the Processor and retain or omit your existing VAD. To use only
the ai-coustics VAD, pass it to `AgentSession` and omit the Processor from the room input options.

With both components configured as above, current LiveKit RoomIO sends enhanced audio to the VAD:

```text
microphone -> Processor -> AgentSession -> STT and VAD
```

This works, but ai-coustics recommends feeding Processor and VAD the same original microphone
audio in parallel so the Processor's independent delay does not affect VAD decisions. Standard
RoomIO cannot currently express that fan-out. Use only one of the two ai-coustics integrations when
the preferred topology is required, or provide custom audio routing. The repository's
`DEVELOPMENT.md` describes the required upstream LiveKit work.

## Parameters and audio handling

Processor parameters use the SDK's native parameter enum. VAD parameter objects remain partial
updates:

```ts
const processorContext = processor.getContext();
processorContext.setParameter(ProcessorParameter.EnhancementLevel, 0.8);
vad.setParameters({ sensitivity: 0.6 });

const level = processorContext.getParameter(ProcessorParameter.EnhancementLevel);
```

Contexts returned by `getContext()` add structured logs for resets, parameter updates, and
bearer-token updates; read-only getters stay silent. If the SDK rejects a Processor parameter
value, the plugin logs a warning and retains its current value. VAD parameter fields are applied
independently, so one rejected field does not block the others.

Processor bypass is delay-compensated. Calling `processor.setEnabled(false)` instead returns
immediate, undelayed input.

The VAD defaults to 50 ms minimum speech and a 250 ms speech hold, matching LiveKit's expectations.
Incoming audio is downmixed to mono and reblocked at its original sample rate. The SDK handles any
model-rate conversion internally. `prefixPaddingDuration`, `maxBufferedSpeech`, LiveKit event
durations, and `minSilenceDuration` use milliseconds; SDK VAD parameter durations use seconds.
Multichannel Processor input is downmixed before processing and duplicated across the original
channel count afterward, preserving LiveKit frame geometry.

This package is not compatible with `npx livekit-agents download-files`. Provision models
explicitly and load them with `Model.fromFile` at runtime.

Migration from the official plugin requires replacing its model-enum and factory APIs with an
explicitly loaded SDK `Model` and the `Processor` constructor shown above.
