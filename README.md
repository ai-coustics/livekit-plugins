# ai-coustics plugins for LiveKit Agents

This repository contains the ai-coustics-maintained Python and Node.js integrations for
[LiveKit Agents](https://docs.livekit.io/agents/). They are thin wrappers around the public
ai-coustics SDKs and let LiveKit agents use:

- `Processor` for speech enhancement through LiveKit's audio `FrameProcessor` interface.
- `VAD` for voice activity detection through LiveKit Agents' streaming VAD interface.
- `Analyzer` for periodic SDK audio-quality analysis, with a transparent collector attached through
  LiveKit's `noise_cancellation` path, result events, and OpenTelemetry metrics.

Applications choose and provision the SDK models themselves. This keeps model selection, storage,
and deployment under application control while the plugins handle LiveKit audio formats, stream
lifecycle, observability, and error recovery.

## Packages

| Runtime | Package | Documentation |
| --- | --- | --- |
| Python | `ai-coustics-livekit-plugin` | [Installation and usage](python/README.md) |
| Node.js | `@ai-coustics/livekit-plugin` | [Installation and usage](node/README.md) |

The runtime guides cover migration from the official plugins, model provisioning, AgentSession
integration, Processor enhancement settings, VAD parameters, authentication, and operational
constraints.

> These packages replace LiveKit's official `livekit-plugins-ai-coustics` and
> `@livekit/plugins-ai-coustics` packages; they are not extensions of them. Uninstall the official
> package for your runtime before migrating, and do not mix objects from the two implementations.

## Repository contents

- [`python/`](python/) contains the Python package and its tests.
- [`node/`](node/) contains the Node.js package and its tests.
- [`DEVELOPMENT.md`](DEVELOPMENT.md) documents architecture, local setup, test commands, and
  planned upstream integrations.

For SDK parameter behavior, supported models, and model-specific limits, see the
[ai-coustics SDK documentation](https://docs.ai-coustics.com/).
