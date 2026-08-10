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
```

Unlike the official VAD, this package's VAD runs a dedicated SDK VAD model and does not depend on
Processor metadata. Provision a separate VAD model if you use it. LiveKit Cloud authentication is
not carried over; obtain an ai-coustics SDK license before migrating.

## Model provisioning

Download models during deployment or container setup:

```python
from livekit.plugins import ai_coustics

enhancement_path = ai_coustics.Model.download("quail-vf-2.2-l-16khz", "./models")
vad_path = ai_coustics.Model.download("vad-2.1-xxs-16khz", "./models")
analysis_path = ai_coustics.Model.download("tyto-l-16khz", "./models")
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

session = AgentSession(
    vad=vad,
    # ... stt, llm, tts
)

await session.start(
    # ... agent, room
    room_options=room_io.RoomOptions(
        audio_input=room_io.AudioInputOptions(noise_cancellation=processor),
    ),
)
```

Use either component independently by omitting the other from the configuration.

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

Use `FrameProcessorChain` to run enhancement and analysis in the same RoomIO audio path:

```python
frame_processor = ai_coustics.FrameProcessorChain(processor, analyzer.collector)

await session.start(
    # ... agent, room
    room_options=room_io.RoomOptions(
        audio_input=room_io.AudioInputOptions(
            noise_cancellation=frame_processor,
        ),
    ),
)
```

`FrameProcessorChain` runs its processors in order. In the example, the collector analyzes enhanced
audio; reverse the arguments to analyze the original audio while still returning enhanced audio.

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

When Processor and VAD are enabled together, RoomIO sends enhanced audio to the VAD. See the
repository's [architecture notes](https://github.com/ai-coustics/livekit-plugins/blob/main/DEVELOPMENT.md#raw-audio-fan-out-for-combined-processor-and-vad-use)
if your application requires both components to receive the original microphone signal.
