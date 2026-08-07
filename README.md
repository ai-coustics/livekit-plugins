# ai-coustics plugins for LiveKit Agents

ai-coustics-maintained audio enhancement and voice activity detection for the Python and Node.js
LiveKit Agents runtimes. The plugins use the public ai-coustics SDK directly:

- `Processor` adapts an enhancement model to LiveKit's audio `FrameProcessor` interface.
- `VAD` adapts a dedicated VAD model to LiveKit Agents' streaming VAD interface.

> **Replacement for the official LiveKit plugins:** These packages replace, and are not compatible
> with, LiveKit's official `livekit-plugins-ai-coustics` and
> `@livekit/plugins-ai-coustics` packages. They are not extensions that can be installed or
> configured alongside the official implementations. Remove the official package for your runtime
> before adopting this plugin, then update imports and construction code to the APIs shown below.
> Python requires this especially because both distributions provide the same
> `livekit.plugins.ai_coustics` import path. The Node package has a distinct import path, but its
> classes and configuration API must not be mixed with the official package.

Applications choose, provision, and load SDK models themselves. This keeps model selection and
storage under application control and avoids tying the plugin API to a fixed model enum.

## Before running an agent

Install the package for your runtime:

```bash
pip uninstall livekit-plugins-ai-coustics
pip install ai-coustics-livekit-plugin

# or
npm uninstall @livekit/plugins-ai-coustics
npm install @ai-coustics/livekit-plugin
```

Set your ai-coustics SDK license and the usual LiveKit worker credentials:

```bash
export AIC_SDK_LICENSE=...
export LIVEKIT_URL=wss://your-project.livekit.cloud
export LIVEKIT_API_KEY=...
export LIVEKIT_API_SECRET=...
```

Provision an enhancement model and, if using this plugin's VAD, a separate VAD model. Model
downloads are blocking and consult the remote model manifest, so run them during deployment or
container construction rather than once per agent job:

```python
from livekit.plugins import ai_coustics

print(ai_coustics.Model.download("quail-vf-2.2-l-16khz", "./models"))
print(ai_coustics.Model.download("vad-2.1-xxs-16khz", "./models"))
```

```ts
import { Model } from "@ai-coustics/livekit-plugin";

console.log(Model.download("quail-vf-2.2-l-16khz", "./models"));
console.log(Model.download("vad-2.1-xxs-16khz", "./models"));
```

Save the returned paths as `AIC_ENHANCEMENT_MODEL_PATH` and `AIC_VAD_MODEL_PATH`, or otherwise make
the files available to the worker. Enhancement and VAD models are different model types and cannot
be substituted for one another.

## Python agent integration

Load models once per worker process, then create a `Processor` and `VAD` for each agent job. Pass
the Processor to RoomIO's `noise_cancellation` option and the VAD to `AgentSession`:

```python
import os

from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    cli,
    inference,
    room_io,
)
from livekit.plugins import ai_coustics


# Loading model weights is relatively expensive, so reuse the immutable models across jobs in
# this worker process. Each job still gets independent Processor and VAD state below.
enhancement_model = ai_coustics.Model.from_file(os.environ["AIC_ENHANCEMENT_MODEL_PATH"])
vad_model = ai_coustics.Model.from_file(os.environ["AIC_VAD_MODEL_PATH"])

server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    processor = ai_coustics.Processor(
        model=enhancement_model,
        processor_parameters=ai_coustics.ProcessorParameters(enhancement_level=1.0),
    )
    vad = ai_coustics.VAD(model=vad_model)

    session = AgentSession(
        vad=vad,
        stt=inference.STT("deepgram/nova-3", language="multi"),
        llm=inference.LLM("openai/gpt-4.1-mini"),
        tts=inference.TTS("cartesia/sonic-3"),
    )

    await session.start(
        agent=Agent(instructions="You are a helpful voice assistant. Keep replies concise."),
        room=ctx.room,
        room_options=room_io.RoomOptions(
            audio_input=room_io.AudioInputOptions(
                noise_cancellation=processor,
            ),
        ),
    )


if __name__ == "__main__":
    cli.run_app(server)
```

The inference STT, LLM, and TTS instances are illustrative; keep the providers already used by
your agent. The ai-coustics-specific integration points are `AgentSession(vad=vad)` and
`AudioInputOptions(noise_cancellation=processor)`.

The distribution is named `ai-coustics-livekit-plugin`, while its import follows LiveKit's plugin
namespace: `livekit.plugins.ai_coustics`. Installing it together with the official distribution
would make ownership of that import path ambiguous and is unsupported.

## Node.js agent integration

The Node integration follows the same ownership model. Load model weights at module scope and
construct stateful Processor and VAD instances inside the job entrypoint:

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

import { Model, Processor, VAD } from "@ai-coustics/livekit-plugin";

const enhancementModel = Model.fromFile(
  process.env.AIC_ENHANCEMENT_MODEL_PATH!,
);
const vadModel = Model.fromFile(process.env.AIC_VAD_MODEL_PATH!);

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const processor = new Processor({
      model: enhancementModel,
      processorParameters: { enhancementLevel: 1.0 },
    });
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

`license_key=` in Python or `licenseKey` in Node can be used instead of `AIC_SDK_LICENSE`.

## Processor and VAD audio flow

To use enhancement only, configure the Processor and retain or omit your existing VAD. To use only
the ai-coustics VAD, pass it to `AgentSession` and omit the ai-coustics Processor from the room
input options.

Processor-only and VAD-only integrations each have the expected topology. When both are configured
as in the complete examples above, current LiveKit RoomIO applies the Processor before audio
reaches `AgentSession`, so this plugin's VAD receives enhanced audio:

```text
microphone -> Processor -> AgentSession -> STT and VAD
```

This is functional, but the ai-coustics SDK's preferred topology feeds the same original audio to
Processor and VAD in parallel, avoiding the Processor's independent audio delay on VAD decisions:

```text
                  +-> VAD -> speech decisions
microphone -------+
                  +-> Processor -> enhanced audio -> STT
```

That fan-out is not currently expressible through LiveKit's standard RoomIO API and requires an
upstream audio-tap or branching mechanism. See [DEVELOPMENT.md](DEVELOPMENT.md) for the proposed
upstream work. Applications that require the preferred topology should currently choose either
the ai-coustics Processor or ai-coustics VAD for the standard RoomIO path, or provide their own
audio routing.

## Runtime control and lifecycle

Both implementations support partial parameter updates:

```python
processor.set_parameters(ai_coustics.ProcessorParameters(enhancement_level=0.8))
vad.set_parameters(ai_coustics.VADParameters(sensitivity=0.6))
```

```ts
processor.setParameters({ enhancementLevel: 0.8 });
vad.setParameters({ sensitivity: 0.6 });
```

Parameters are applied independently. If the SDK rejects one, the plugin logs a warning, retains
that parameter's current value, and continues applying the others.

Processor bypass remains delay-compensated. Disabling a Processor instead returns the original
audio immediately, without the model delay:

```python
processor.set_parameters(ai_coustics.ProcessorParameters(bypass=True))
processor.enabled = False
```

```ts
processor.setParameters({ bypass: true });
processor.setEnabled(false);
```

RoomIO owns a directly configured Processor and closes it with the input stream. VAD streams are
owned by `AgentSession`. Do not share one Processor instance between concurrent rooms; create an
instance per job as shown above.

The VAD defaults to 50 ms minimum speech and a 250 ms speech hold, matching LiveKit's streaming
turn-detector expectations. Both adapters preserve the incoming LiveKit sample rate and let the
SDK perform model-rate conversion internally.

## Model download compatibility

These plugins do not currently participate in LiveKit Agents' `download-files` commands. Download
models explicitly during application or container setup with `Model.download`, then load the
resulting files at runtime with `Model.from_file` or `Model.fromFile`.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for repository setup, architecture notes, test commands, the
local LiveKit end-to-end environment, and planned upstream integrations.
