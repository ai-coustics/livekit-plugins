# Development

This repository contains separate Python and Node.js packages backed by the corresponding public
ai-coustics SDK. Develop and test each package from its own directory.

## Architecture

`Processor` accepts an already-loaded SDK `Model`, never a model ID or file path. Both packages
expose the SDK's `Model.from_file` / `Model.fromFile` and `Model.download` APIs so applications can
choose when and where models are downloaded and loaded.

Model loading and native Processor construction happen when the filter is constructed. A
synchronous SDK construction error is raised with its original error attached. Backend
authentication continues asynchronously during the SDK's grace period, so the plugin does not
process a throwaway frame to probe the license.

Processor format initialization is lazy because LiveKit supplies the complete stream geometry
with the first frame. Each LiveKit frame is processed in one fixed-size SDK call, avoiding the
additional latency of the SDK's variable-block-size mode. aic-sdk 3 for Python and 0.22 for Node
process mono audio only, so multichannel LiveKit frames are downmixed before processing and the
enhanced signal is duplicated across the original channel count. This preserves the LiveKit frame
geometry and metadata.

Processing errors are logged and the original LiveKit frame is returned. This fail-open behavior
keeps room audio flowing if the SDK rejects a frame or encounters a runtime error. Processor logs
use LiveKit's logging path and include the model, stream identity when available, audio format,
failure stage, and timing context. Repeated failures and slower-than-realtime warnings are
rate-limited; recovery and close events summarize the affected frames, processing time, real-time
factor, and maximum accumulated processing backlog. The Node implementation falls back to the
console for operational messages when LiveKit has not initialized its logger.

Each `VAD` creates one native SDK VAD per LiveKit `VADStream`: `aic_sdk.VadAsync` in Python and
`@ai-coustics/aic-sdk`'s synchronous `Vad` in Node. Streams downmix input and reblock it at its
original sample rate; the SDK performs any model-rate conversion internally. They emit LiveKit
inference and speech transition events from SDK predictions, reset all native and buffered state
on `flush()`, and terminate their SDK session when closed. Event durations and speech lookback
account for the SDK's prediction delay so decisions remain aligned with the input audio timeline.
A rolling frame buffer retains only the required lookback, while a bounded contiguous PCM buffer
makes each speech transition event expose its candidate audio as a single immutable `AudioFrame`.

Python's async SDK API lets native VAD work yield naturally. The Node SDK VAD API is synchronous,
so each native inference runs on the JavaScript thread used by the LiveKit VAD stream. Structured
backlog warnings identify sustained slower-than-realtime processing.

The wrapper overrides the model-specific SDK duration defaults with LiveKit-compatible values:
50 ms minimum speech and a 250 ms speech hold. The latter satisfies the minimum silence required
by LiveKit's streaming turn detector. Explicit `VADParameters` values still take precedence.

## Future work

### LiveKit `download-files` integration

The plugins do not currently participate in LiveKit Agents' `download-files` commands. Model
provisioning must remain an explicit application or container-build step for now.

Python already discovers and imports `livekit.plugins.ai_coustics`, and the package registers a
LiveKit `Plugin`, but its inherited `download_files()` implementation is intentionally a no-op.
The standalone command does not load the user's agent configuration or pass arguments to the
plugin, so it cannot determine which arbitrary enhancement and VAD model IDs the application
intends to use. Downloading a fixed model enum would conflict with this plugin's model-ID and
file-path API.

Node has the same model-selection problem plus a discovery limitation. The standalone LiveKit CLI
only scans `node_modules/@livekit/agents-plugin-*`, so it does not import
`@ai-coustics/livekit-plugin`; registering a `Plugin.downloadFiles()` hook in our package would not
make the modern command discover it.

A future implementation needs both an explicit, build-time source of model IDs and a stable way
to resolve the downloaded versioned files without contacting the model manifest again at runtime.
Node additionally needs an upstream LiveKit discovery mechanism for third-party package scopes,
such as package metadata or an explicit package list. Until those pieces exist, use
`Model.download` during provisioning and construct runtime models from the returned files with
`Model.from_file` / `Model.fromFile`.

### Raw-audio fan-out for combined Processor and VAD use

The ai-coustics SDK recommends feeding the Processor and VAD the same original microphone blocks
in parallel. Enhancement changes the signal and adds an independent audio delay, so passing the
Processor output into the VAD stacks that delay in front of the VAD's prediction delay.

LiveKit Agents currently provides one shared audio input to STT and VAD. When `Processor` is
configured as RoomIO's `noise_cancellation`, RoomIO applies it before the audio reaches the
`AgentSession`; consequently, the session's VAD receives enhanced, delayed audio:

```text
microphone -> Processor -> AgentSession -> STT and VAD
```

The intended topology is:

```text
                  +-> VAD -> speech decisions
microphone -------+
                  +-> Processor -> enhanced audio -> STT
```

The plugin cannot construct this topology itself because its `VADStream` only sees frames after
RoomIO processing, while the `FrameProcessor` has no way to supply a separate raw stream to the
session VAD. A complete solution therefore needs upstream LiveKit Agents support for a raw-audio
tap, a separate VAD audio input, or a branching audio-processing graph. Until that exists,
Processor-only and VAD-only configurations have the intended SDK topology; using both through the
standard RoomIO path is functional, but the VAD operates on Processor output and its event timing
cannot compensate for the Processor's independent audio delay.

### Streaming Analyzer integration

The aic-sdk streaming analysis API is split into a `Collector` and an `Analyzer`. The collector
accepts mono float32 audio synchronously and is safe to feed from the audio path, while
`analyze_buffered()` / `analyzeBuffered()` runs an expensive model inference and must execute away
from that path. The result contains risk, speaker reverb, speaker loudness, interfering speech,
media speech, noise, and packet-loss scores. `FileAnalyzer` is intended for complete in-memory
signals and is not appropriate for a live agent stream.

An Analyzer is a side-channel consumer rather than an audio transform. Implementing it as a
pass-through `FrameProcessor` would let it collect early audio, but it would occupy RoomIO's single
`noise_cancellation` slot and could not run beside the enhancement `Processor`. An `AudioInput`
wrapper can coexist with enhancement today, but only observes the already-processed AgentSession
input and has awkward setup and ownership when RoomIO creates the default input. Either approach
is useful for a prototype, but neither is a suitable public integration.

The preferred upstream solution is a generic audio observer or tap interface in LiveKit Agents.
RoomIO or AgentSession should fan frames out to registered observers without allowing observer
backpressure or failures to affect the main audio pipeline. Its lifecycle should cover stream
metadata, audio-format initialization, hard-boundary reset or flush, track replacement and detach,
and asynchronous close. Placement should be explicit:

- A `raw` tap before noise cancellation and automatic gain control measures the caller's original
  environment and can share the unmodified signal with the VAD.
- A `processed` tap observes exactly what downstream STT, VAD, turn detection, or speech-to-speech
  models receive and is the appropriate default for predicting downstream failure.

Supporting a truly raw tap may also require an RTC `AudioStream` hook or a branching processing
graph because the current RTC frame processor runs before Agents receives the frame. This work can
therefore share the upstream solution proposed for Processor/VAD raw-audio fan-out.

The plugin-side API should create one SDK collector/analyzer pair per LiveKit observer stream and
expose immutable analysis events. Events should include the seven scores, model and stream
metadata, result time and accumulated audio position, inference duration, and a sequence number.
Collection requires only PCM16-to-float32 conversion and mono downmixing; the SDK handles sample
rate adaptation after the collector is initialized with the input rate. Analysis should be
scheduled from accumulated audio duration, allow only one inference at a time, and replace stale
pending work instead of building an unbounded queue. Track and format discontinuities must reset
the SDK state, and close must terminate the analyzer telemetry session.

Analysis results should use a dedicated `audio_analysis` event instead of being forced into
LiveKit's deprecated `metrics_collected` event. Inference duration, errors, and backlog remain
operational diagnostics and may later map to first-class analyzer metrics. If future analysis
models use different context windows, aic-sdk should expose the model's analysis-window duration
so the plugin does not have to hard-code the current five-second window.

Python can run `analyze_buffered()` through `asyncio.to_thread()` because the binding releases the
GIL during inference. Node aic-sdk 0.22 exposes only synchronous `analyzeBuffered()` and
`terminateSession()`, so calling them from a timer would still block the agent's JavaScript event
loop. A production Node integration first needs native asynchronous APIs such as
`analyzeBufferedAsync()` and `terminateSessionAsync()` that execute on a worker pool.

### First-class Processor metrics

The plugins currently expose Processor health through structured LiveKit logs. This covers events
that are immediately actionable—initialization and format changes, failures and recovery,
slower-than-realtime processing, and a lifetime summary—but it does not produce LiveKit metrics.

LiveKit's `FrameProcessor` interface has lifecycle and processing hooks but no metrics event, and
the Agents metrics model has no `FrameProcessorMetrics` equivalent. Adding private plugin metric
objects would therefore bypass the normal `AgentSession` collection, `log_metrics()`, usage
collection, and OpenTelemetry export paths.

A future upstream implementation should let RoomIO or `AgentSession` receive and emit frame
processor metrics. Useful fields include processed and failed frame counts, input-audio duration,
total and maximum processing duration, average and maximum real-time factor, maximum accumulated
processing backlog, initialization count, and the model's fixed audio delay. The fixed audio
delay describes signal alignment and must remain distinct from processing backlog, which is
runtime scheduling and compute debt. Once LiveKit provides that surface, these plugins can map the
same counters used by their structured logs into the standard metrics pipeline.

### Richer upstream VAD metrics

The plugin reports each native call's elapsed time through `VADEvent.inference_duration`, which
LiveKit aggregates into `VADMetrics.inference_duration_total` and `inference_count`. The plugin also
logs structured warnings when cumulative processing time falls behind the incoming audio timeline.

LiveKit's metrics model cannot currently expose the worst inference or processing backlog observed
inside an aggregation period. A future upstream improvement could add processed audio duration (or
real-time factor), maximum inference duration, and maximum processing backlog to `VADMetrics`.
LiveKit's `log_metrics()` and OpenTelemetry exporter could then render and export those fields. The
processing backlog is runtime scheduling/compute debt and must remain distinct from a model's fixed
VAD prediction delay.

## Setup

Python development uses `uv`:

```bash
cd python
uv sync --dev
```

Node.js development uses npm:

```bash
cd node
npm ci
```

Set `AIC_SDK_LICENSE` before running tests that construct a real SDK Processor or VAD:

```bash
export AIC_SDK_LICENSE=...
```

The integration and end-to-end tests download
`quail-vf-2.2-s-16khz` and `vad-2.1-xxs-16khz` by default. Override their IDs or cache directory
with `AIC_INTEGRATION_MODEL_ID`, `AIC_INTEGRATION_VAD_MODEL_ID`, and
`AIC_INTEGRATION_MODEL_DIR`.

## Tests and checks

The test suite has three layers:

1. Unit tests mock the native SDK boundary and require no license or network access.
2. Integration tests use downloaded models and the real SDK Processor and VAD directly.
3. End-to-end tests send microphone audio through a real LiveKit room and an `AgentSession`
   configured with the real Processor and VAD integrations.

Run the Python suite and checks with:

```bash
cd python
uv run pytest tests/test_processor.py -q
uv run pytest tests/test_vad.py -q
uv run pytest tests/test_integration.py -q
uv run pytest tests/test_e2e_room.py -q
uv run ruff check .
uv run ruff format --check .
uv run mypy
```

Run the Node.js suite and checks with:

```bash
cd node
npm test
npm run test:integration
npm run test:e2e
npm run check
npm run build
```

The integration and end-to-end commands require `AIC_SDK_LICENSE`. The end-to-end commands also
require a LiveKit server.

## Local end-to-end environment

The end-to-end tests connect two RTC participants to a unique room:

```text
synthetic microphone publisher
  -> LiveKit server
  -> agent RoomIO
  -> rtc.AudioStream
  -> ai-coustics Processor and VAD
  -> AgentSession
```

They verify that RoomIO invokes the real SDK-backed Processor, the `AgentSession` consumes the
SDK-backed VAD, processing remains successful after the SDK authentication grace period, frame
geometry is preserved, and RoomIO closes the Processor during session teardown.

Start LiveKit in a separate terminal. A native server is the simplest option on macOS; Linux can
use either the native server or the container:

```bash
livekit-server --dev

# Linux container alternative. Keep the version aligned with CI.
docker run --rm --network host livekit/livekit-server:v1.13.1 --dev
```

LiveKit dev mode uses the following values, which are also the test defaults:

```text
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` to target a different test server.
Do not run the end-to-end tests against a production LiveKit project.

## Continuous integration

Unit tests run across the supported Python and Node.js version matrices. The protected integration
jobs run one representative version of each runtime, require the repository's `AIC_SDK_LICENSE`
secret, cache downloaded models, and execute both the native integration and room end-to-end
tests.

CI starts the pinned upstream LiveKit server image with host networking and dev credentials. The
server is readiness-checked before the tests, its logs are printed even after a failure, and the
container is always removed. Integration jobs do not run for pull requests from forks so the SDK
license is not exposed.

## Releases

Python and Node.js packages are released together and must always have the same version. To prepare
a release:

1. Update `project.version` in `python/pyproject.toml` and run `uv lock` from `python/`.
2. Run `npm version <version> --no-git-tag-version` from `node/` to update `package.json` and
   `package-lock.json`.
3. Commit the version changes, merge them to `main`, and wait for CI to pass.
4. Create and push an unprefixed semantic version tag:

   ```bash
   git tag 0.1.0
   git push origin 0.1.0
   ```

The release workflow verifies that the tag points to a commit on `main` and matches both package
versions. It then builds both distributions, publishes `ai-coustics-livekit-plugin` to PyPI and
`@ai-coustics/livekit-plugin` to npm, and creates a GitHub release containing all distribution
artifacts. The GitHub release is created only after both registry publications succeed.

Repository and registry configuration required by the publish jobs:

- A GitHub `publish` environment, optionally with required reviewers.
- A `PYPI_API_TOKEN` secret available to that environment.
- An npm trusted publisher for `@ai-coustics/livekit-plugin`, restricted to this repository,
  `.github/workflows/release.yml`, and the `publish` environment.
