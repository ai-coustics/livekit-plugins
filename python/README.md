# ai-coustics LiveKit plugin for Python

This package adapts `aic_sdk.Processor` to LiveKit's
`rtc.FrameProcessor[rtc.AudioFrame]` interface and `aic_sdk.VadAsync` to LiveKit Agents' streaming
VAD interface.

> **Replacement notice:** `ai-coustics-livekit-plugin` replaces, and is not compatible with,
> LiveKit's official `livekit-plugins-ai-coustics` package. Do not install both. Both distributions
> provide the `livekit.plugins.ai_coustics` import path, so coexistence can select the wrong
> implementation or combine incompatible APIs. Uninstall the official package before installing
> this one.

## Installation and model provisioning

```bash
pip uninstall livekit-plugins-ai-coustics
pip install ai-coustics-livekit-plugin
export AIC_SDK_LICENSE=...
```

Download models during application or container setup, not once per agent job:

```python
from livekit.plugins import ai_coustics

print(ai_coustics.Model.download("quail-vf-2.2-l-16khz", "./models"))
print(ai_coustics.Model.download("vad-2.1-xxs-16khz", "./models"))
```

The first model is for enhancement and the second is for VAD. They are different model types and
cannot be substituted for one another. Save the returned paths as `AIC_ENHANCEMENT_MODEL_PATH` and
`AIC_VAD_MODEL_PATH`, or otherwise make the files available to the worker.

## Agent integration

Load model weights once per worker process and create stateful Processor and VAD instances for each
job. The Processor belongs in RoomIO's `noise_cancellation` option; the VAD belongs directly on
`AgentSession`:

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


enhancement_model = ai_coustics.Model.from_file(os.environ["AIC_ENHANCEMENT_MODEL_PATH"])
vad_model = ai_coustics.Model.from_file(os.environ["AIC_VAD_MODEL_PATH"])

server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    processor = ai_coustics.Processor(model=enhancement_model)
    processor.get_context().set_parameter(
        ai_coustics.ProcessorParameter.EnhancementLevel,
        1.0,
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

Set `AIC_SDK_LICENSE` or pass `license_key=` explicitly. SDK objects are constructed immediately,
while backend authentication continues during the SDK grace period. RoomIO owns a directly
configured Processor and closes it with its input stream. Do not share one Processor instance
between concurrent rooms.

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

```python
processor_context = processor.get_context()
processor_context.set_parameter(ai_coustics.ProcessorParameter.EnhancementLevel, 0.8)
vad.set_parameters(ai_coustics.VADParameters(sensitivity=0.6))

level = processor_context.get_parameter(ai_coustics.ProcessorParameter.EnhancementLevel)
```

Contexts returned by `get_context()` add structured logs for resets, parameter updates, and
bearer-token updates; read-only getters stay silent. If the SDK rejects a Processor parameter
value, the plugin logs a warning and retains its current value. VAD parameter fields are applied
independently, so one rejected field does not block the others.

Processor bypass is delay-compensated. Setting `processor.enabled = False` instead returns
immediate, undelayed input.

The VAD defaults to 50 ms minimum speech and a 250 ms speech hold, matching LiveKit's expectations.
Incoming audio is downmixed to mono and reblocked at its original sample rate. The SDK handles any
model-rate conversion internally, and VAD inference runs asynchronously outside the agent event
loop. Multichannel Processor input is downmixed before processing and duplicated across the
original channel count afterward, preserving LiveKit frame geometry.

This package is not compatible with `python -m livekit.agents download-files`. Provision models
explicitly and load them with `Model.from_file` at runtime.

The distribution is named `ai-coustics-livekit-plugin`, while its import uses LiveKit's plugin
namespace. Migration from the official plugin requires replacing its model-enum and
`audio_enhancement()` usage with an explicitly loaded SDK `Model` and the `Processor` constructor
shown above.
