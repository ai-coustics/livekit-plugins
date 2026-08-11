# ai-coustics LiveKit plugin for Python

Audio enhancement, voice activity detection, and audio-quality analysis for LiveKit Agents, backed by the public
`aic-sdk` package.

> This package replaces `livekit-plugins-ai-coustics`. Do not install both packages because they
> provide the same `livekit.plugins.ai_coustics` import path.

## Installation

```bash
pip uninstall livekit-plugins-ai-coustics
pip install ai-coustics-livekit-plugin
export AIC_SDK_LICENSE=...
```

## Migrating from the official LiveKit plugin

The Python import remains `livekit.plugins.ai_coustics`, but the public APIs are different:

| Official LiveKit plugin | This package |
| --- | --- |
| `audio_enhancement(...)` | `Processor(model=...)` |
| `EnhancerModel.*` | An SDK `Model` loaded from a provisioned model file |
| `ModelParameters` or `update_model_parameters(...)` | `processor.get_context().set_parameter(...)` |
| `VAD()` and `VadSettings` | `VAD(model=..., vad_parameters=VADParameters(...))` |
| `Auth.livekit_cloud()` or `Auth.ai_coustics_api(...)` | `AIC_SDK_LICENSE` or `license_key=` |

Before:

```python
processor = ai_coustics.audio_enhancement(
    model=ai_coustics.EnhancerModel.QUAIL_L,
)
vad = ai_coustics.VAD()
```

After loading the SDK models as described below:

```python
processor = ai_coustics.Processor(model=enhancement_model)
vad = ai_coustics.VAD(model=vad_model)
frame_processor = ai_coustics.FrameProcessorChain(vad.processor, processor)
```

This package still uses a dedicated SDK VAD model. Like the official plugin, inference runs in the
RoomIO frame-processor path and the VAD streams consume frame metadata. Provision a separate VAD
model and install `vad.processor` as described below. LiveKit Cloud authentication is not carried
over; obtain an ai-coustics SDK license before migrating.

## Model provisioning

Download models during deployment or container setup:

```python
from livekit.plugins import ai_coustics

enhancement_path = ai_coustics.Model.download("quail-vf-2.2-l-16khz", "./models")
vad_path = ai_coustics.Model.download("vad-2.1-xxs-16khz", "./models")
analysis_path = ai_coustics.Model.download("tyto-1.1-l-16khz", "./models")
```

Enhancement and VAD models are different model types. Make the returned paths available to your
worker, then load each model once per worker process:

```python
enhancement_model = ai_coustics.Model.from_file(enhancement_path)
vad_model = ai_coustics.Model.from_file(vad_path)
analysis_model = ai_coustics.Model.from_file(analysis_path)
```

## Usage

Create a `Processor` and `VAD` for each agent session:

```python
from livekit.agents import AgentSession, room_io
from livekit.plugins import ai_coustics

processor = ai_coustics.Processor(model=enhancement_model)
vad = ai_coustics.VAD(model=vad_model)
frame_processor = ai_coustics.FrameProcessorChain(vad.processor, processor)

session = AgentSession(
    vad=vad,
    # ... stt, llm, tts
)

await session.start(
    # ... agent, room
    room_options=room_io.RoomOptions(
        audio_input=room_io.AudioInputOptions(noise_cancellation=frame_processor),
    ),
)
```

`vad.processor` must be installed in the `noise_cancellation` path whenever the VAD is used. Put
it first in the chain so it runs on original microphone audio before enhancement. All VAD streams
read the resulting immutable metadata, so the SDK model runs only once per audio block.

For VAD without enhancement, use `noise_cancellation=vad.processor`. For enhancement without VAD,
use `noise_cancellation=processor`.

### Audio-quality analysis

Create an `Analyzer`, install its collector in RoomIO's audio path, and subscribe to its results:

```python
analyzer = ai_coustics.Analyzer(
    model=analysis_model,
    analysis_interval=5.0,  # seconds; 5 is the default
)


@analyzer.on("analysis_result")
def on_analysis(event: ai_coustics.AnalysisEvent) -> None:
    print(event.result.risk_score)


await session.start(
    # ... agent, room
    room_options=room_io.RoomOptions(
        audio_input=room_io.AudioInputOptions(
            noise_cancellation=analyzer.collector,
        ),
    ),
)
```

The `Analyzer` receives audio through `analyzer.collector`; constructing the analyzer without
installing its collector does not feed it any room audio.

Results are not logged by the plugin; log or handle them in the callback.

### Combining frame processors

Use `FrameProcessorChain` to run VAD inference before enhancement in the same RoomIO audio path:

```python
frame_processor = ai_coustics.FrameProcessorChain(vad.processor, processor)

await session.start(
    # ... agent, room
    room_options=room_io.RoomOptions(
        audio_input=room_io.AudioInputOptions(
            noise_cancellation=frame_processor,
        ),
    ),
)
```

`FrameProcessorChain` runs its processors in order. Keep `vad.processor` first: it annotates the
original frame, then `processor` enhances the audio while preserving that metadata. Chains can be
nested when the analyzer collector is also needed.

This still uses LiveKit's `noise_cancellation` slot as a temporary integration. RoomIO owns the
chain and closes the processor, collector, and analyzer together.

## Configuration

Set the enhancement level through the Processor context, and configure all SDK VAD parameters on
the VAD factory:

```python
processor.get_context().set_parameter(
    ai_coustics.ProcessorParameter.EnhancementLevel,
    0.8,
)

vad.set_parameters(
    ai_coustics.VADParameters(
        sensitivity=0.5,
        speech_hold_duration=0.25,
        minimum_speech_duration=0.05,
    )
)
```

VAD durations are specified in seconds. See the
[Python SDK reference](https://docs.ai-coustics.com/reference/sdk/language-bindings/python) and
[VAD guide](https://docs.ai-coustics.com/models/voice-activity-detection/vad) for parameter ranges,
model support, and further details.

Set `AIC_SDK_LICENSE` or pass `license_key=` to the constructor. Create a new Processor for each
concurrent room; RoomIO closes it with the input stream.

Models must be provisioned explicitly. This package does not support
`python -m livekit.agents download-files`.
