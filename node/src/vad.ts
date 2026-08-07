import {
  VAD as LiveKitVAD,
  VADStream as LiveKitVADStream,
  VADEventType,
  log,
} from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";

import { pcm16ToFloat32 } from "./processor.js";
import {
  type Model,
  Vad as AicVad,
  type VadContext,
  type VadInstance,
  VadParameter as AicVadParameter,
  setSdkId,
} from "./sdk.js";

const DEFAULT_SPEECH_HOLD_DURATION_SECONDS = 0.25;
const DEFAULT_MINIMUM_SPEECH_DURATION_SECONDS = 0.05;
const DEFAULT_PREFIX_PADDING_DURATION_MS = 500;
const DEFAULT_MAX_BUFFERED_SPEECH_MS = 60_000;
const SLOW_INFERENCE_BACKLOG_THRESHOLD_MS = 200;
const SLOW_WARNING_INTERVAL_MS = 10_000;

export interface VADParameters {
  /** SDK speech probability threshold. */
  sensitivity?: number;
  /** SDK speech hold duration in seconds. */
  speechHoldDuration?: number;
  /** SDK minimum speech duration in seconds. */
  minimumSpeechDuration?: number;
}

export interface VADOptions {
  /** Loaded dedicated ai-coustics VAD model. */
  model: Model;
  licenseKey?: string;
  vadParameters?: VADParameters;
  /** LiveKit speech prefix padding in milliseconds. */
  prefixPaddingDuration?: number;
  /** Maximum buffered speech duration in milliseconds. */
  maxBufferedSpeech?: number;
}

function resolveLicenseKey(value?: string): string {
  const key = value || process.env.AIC_SDK_LICENSE;
  if (!key) {
    throw new Error(
      "An ai-coustics SDK license is required. Pass licenseKey or set AIC_SDK_LICENSE.",
    );
  }
  return key;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** LiveKit Agents VAD backed by a dedicated ai-coustics SDK VAD model. */
export class VAD extends LiveKitVAD {
  label = "ai-coustics.VAD";

  private readonly sdkModel: Model;
  private readonly licenseKey: string;
  private readonly modelId: string;
  private readonly prefixPaddingDuration: number;
  private readonly maxBufferedSpeech: number;
  private readonly parameters: VADParameters = {
    speechHoldDuration: DEFAULT_SPEECH_HOLD_DURATION_SECONDS,
    minimumSpeechDuration: DEFAULT_MINIMUM_SPEECH_DURATION_SECONDS,
  };
  private readonly streams = new Set<WeakRef<AicVADStream>>();
  private initialVad: VadInstance | null;
  private initialContext: VadContext | null;

  constructor(options: VADOptions) {
    const prefixPaddingDuration =
      options.prefixPaddingDuration ?? DEFAULT_PREFIX_PADDING_DURATION_MS;
    const maxBufferedSpeech =
      options.maxBufferedSpeech ?? DEFAULT_MAX_BUFFERED_SPEECH_MS;
    if (prefixPaddingDuration < 0) {
      throw new Error("prefixPaddingDuration must be greater than or equal to zero");
    }
    if (maxBufferedSpeech <= 0) {
      throw new Error("maxBufferedSpeech must be greater than zero");
    }

    const modelSampleRate = options.model.getOptimalSampleRate();
    const modelBlockSize = options.model.getOptimalBlockSize(modelSampleRate);
    super({ updateInterval: (modelBlockSize / modelSampleRate) * 1000 });

    this.sdkModel = options.model;
    this.licenseKey = resolveLicenseKey(options.licenseKey);
    this.modelId = options.model.getId();
    this.prefixPaddingDuration = prefixPaddingDuration;
    this.maxBufferedSpeech = maxBufferedSpeech;

    const initial = this.createNativeVad();
    this.initialVad = initial.vad;
    this.initialContext = initial.context;
    if (options.vadParameters) {
      this.setParameters(options.vadParameters);
    }
  }

  get model(): string {
    return this.modelId;
  }

  get provider(): string {
    return "ai-coustics";
  }

  override get minSilenceDuration(): number {
    return (
      (this.parameters.speechHoldDuration ?? DEFAULT_SPEECH_HOLD_DURATION_SECONDS) * 1000
    );
  }

  override stream(): LiveKitVADStream {
    let nativeVad: VadInstance;
    let context: VadContext;
    if (this.initialVad && this.initialContext) {
      nativeVad = this.initialVad;
      context = this.initialContext;
      this.initialVad = null;
      this.initialContext = null;
    } else {
      ({ vad: nativeVad, context } = this.createNativeVad());
    }

    const stream = new AicVADStream(this, {
      nativeVad,
      context,
      model: this.sdkModel,
      prefixPaddingDuration: this.prefixPaddingDuration,
      maxBufferedSpeech: this.maxBufferedSpeech,
    });
    this.streams.add(new WeakRef(stream));
    return stream;
  }

  setParameters(parameters: VADParameters): void {
    const contexts: VadContext[] = [];
    if (this.initialContext) contexts.push(this.initialContext);
    for (const reference of this.streams) {
      const stream = reference.deref();
      if (!stream) {
        this.streams.delete(reference);
        continue;
      }
      const context = stream.sdkContext;
      if (context) contexts.push(context);
    }
    if (contexts.length === 0) {
      const initial = this.createNativeVad();
      this.initialVad = initial.vad;
      this.initialContext = initial.context;
      contexts.push(initial.context);
    }

    if (parameters.sensitivity !== undefined) {
      if (
        this.applyParameter(
          contexts,
          AicVadParameter.Sensitivity,
          "sensitivity",
          parameters.sensitivity,
        )
      ) {
        this.parameters.sensitivity = parameters.sensitivity;
      }
    }
    if (parameters.speechHoldDuration !== undefined) {
      if (
        this.applyParameter(
          contexts,
          AicVadParameter.SpeechHoldDuration,
          "speechHoldDuration",
          parameters.speechHoldDuration,
        )
      ) {
        this.parameters.speechHoldDuration = parameters.speechHoldDuration;
      }
    }
    if (parameters.minimumSpeechDuration !== undefined) {
      if (
        this.applyParameter(
          contexts,
          AicVadParameter.MinimumSpeechDuration,
          "minimumSpeechDuration",
          parameters.minimumSpeechDuration,
        )
      ) {
        this.parameters.minimumSpeechDuration = parameters.minimumSpeechDuration;
      }
    }
  }

  private applyParameter(
    contexts: VadContext[],
    parameter: AicVadParameter,
    name: string,
    value: number,
  ): boolean {
    try {
      for (const context of contexts) context.setParameter(parameter, value);
    } catch (error) {
      const fields = {
        modelProvider: "ai-coustics",
        modelName: this.modelId,
        parameter: name,
        parameterValue: value,
        errorType: error instanceof Error ? error.name : typeof error,
        errorMessage: errorDetail(error),
      };
      const message = "ai-coustics VAD parameter rejected; keeping the current value";
      try {
        log().warn(fields, message);
      } catch {
        console.warn(message, fields);
      }
      return false;
    }
    return true;
  }

  override async close(): Promise<void> {
    if (this.initialVad) {
      try {
        this.initialVad.terminateSession();
      } catch (error) {
        console.error(
          `Failed to terminate ai-coustics VAD session: ${errorDetail(error)}`,
        );
      }
      this.initialVad = null;
      this.initialContext = null;
    }

    for (const reference of this.streams) {
      reference.deref()?.close();
    }
    this.streams.clear();
  }

  private createNativeVad(): { vad: VadInstance; context: VadContext } {
    // The SDK keeps the first integration identifier it receives. Set this before construction
    // so usage is attributed to the LiveKit Node plugin.
    setSdkId(9);
    let vad: VadInstance;
    try {
      vad = new AicVad(this.sdkModel, this.licenseKey);
    } catch (error) {
      throw new Error(`Failed to create ai-coustics VAD: ${errorDetail(error)}`, {
        cause: error,
      });
    }

    const context = vad.getContext();
    if (this.parameters.sensitivity !== undefined) {
      this.applyParameter(
        [context],
        AicVadParameter.Sensitivity,
        "sensitivity",
        this.parameters.sensitivity,
      );
    }
    if (this.parameters.speechHoldDuration !== undefined) {
      this.applyParameter(
        [context],
        AicVadParameter.SpeechHoldDuration,
        "speechHoldDuration",
        this.parameters.speechHoldDuration,
      );
    }
    if (this.parameters.minimumSpeechDuration !== undefined) {
      this.applyParameter(
        [context],
        AicVadParameter.MinimumSpeechDuration,
        "minimumSpeechDuration",
        this.parameters.minimumSpeechDuration,
      );
    }
    return { vad, context };
  }
}

interface StreamOptions {
  nativeVad: VadInstance;
  context: VadContext;
  model: Model;
  prefixPaddingDuration: number;
  maxBufferedSpeech: number;
}

class AicVADStream extends LiveKitVADStream {
  private nativeVad: VadInstance | null;
  private context: VadContext | null;
  private readonly model: Model;
  private readonly prefixPaddingDuration: number;
  private readonly maxBufferedSpeech: number;
  private lastSlowWarning = 0;
  private outputFinished = false;
  private pumpError: unknown;

  constructor(vad: VAD, options: StreamOptions) {
    super(vad);
    this.nativeVad = options.nativeVad;
    this.context = options.context;
    this.model = options.model;
    this.prefixPaddingDuration = options.prefixPaddingDuration;
    this.maxBufferedSpeech = options.maxBufferedSpeech;

    void this.pump()
      .then(() => this.finishOutput())
      .catch(async (error: unknown) => {
        this.pumpError = error;
        this.logger.error(
          { err: errorDetail(error) },
          "ai-coustics VAD stream failed",
        );
        await this.finishOutput();
      })
      .finally(() => this.terminateNative());
  }

  get sdkContext(): VadContext | null {
    return this.context;
  }

  override endInput(): void {
    if (this.inputClosed) throw new Error("Input is closed");
    if (this.closed) throw new Error("Stream is closed");
    this.inputClosed = true;
    void this.inputWriter.close();
  }

  override close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.detachInputStream();
    void this.inputReader.cancel();
    this.terminateNative();
    void this.finishOutput();
  }

  override async next(): Promise<IteratorResult<import("@livekit/agents").VADEvent>> {
    const result = await super.next();
    if (result.done && this.pumpError !== undefined) {
      const error = this.pumpError;
      this.pumpError = undefined;
      throw error;
    }
    return result;
  }

  private async finishOutput(): Promise<void> {
    if (this.outputFinished) return;
    this.outputFinished = true;
    try {
      await this.outputWriter.close();
    } catch {
      // The output can already be closed or cancelled during AgentSession teardown.
    }
  }

  private terminateNative(): void {
    const nativeVad = this.nativeVad;
    this.nativeVad = null;
    this.context = null;
    if (!nativeVad) return;
    try {
      nativeVad.terminateSession();
    } catch (error) {
      this.logger.error(
        { err: errorDetail(error) },
        "Failed to terminate ai-coustics VAD session",
      );
    }
  }

  private async pump(): Promise<void> {
    const nativeVad = this.nativeVad;
    const context = this.context;
    if (!nativeVad || !context) return;

    let inputSampleRate = 0;
    let inferenceBlockSize = 0;
    let predictionDelaySamples = 0;
    let configuredFormat: [number, number] | null = null;
    let inferenceBuffer = new Int16Array(0);

    const prefixFrames: AudioFrame[] = [];
    let prefixSamples = 0;
    let speechBuffer: Int16Array | null = null;
    let speechSamples = 0;
    let speechBufferFull = false;
    let processingBacklogMs = 0;
    let slowWarningActive = false;

    let speaking = false;
    let speechDurationMs = 0;
    let silenceDurationMs = 0;
    let rawSpeechDurationMs = 0;
    let rawSilenceDurationMs = 0;
    let currentSample = 0;
    let timestampMs = 0;

    const resetState = () => {
      context.reset();
      inputSampleRate = 0;
      inferenceBlockSize = 0;
      inferenceBuffer = new Int16Array(0);
      prefixFrames.length = 0;
      prefixSamples = 0;
      speechBuffer = null;
      speechSamples = 0;
      speechBufferFull = false;
      processingBacklogMs = 0;
      slowWarningActive = false;
      speaking = false;
      speechDurationMs = 0;
      silenceDurationMs = 0;
      rawSpeechDurationMs = 0;
      rawSilenceDurationMs = 0;
      currentSample = 0;
      timestampMs = 0;
    };

    const toMono = (frame: AudioFrame): Int16Array => {
      const expectedSamples = frame.samplesPerChannel * frame.channels;
      if (frame.data.length !== expectedSamples) {
        throw new Error(
          `AudioFrame contains ${frame.data.length} samples, expected ${expectedSamples}`,
        );
      }
      if (frame.channels === 1) return frame.data;

      const mono = new Int16Array(frame.samplesPerChannel);
      for (let sample = 0; sample < frame.samplesPerChannel; sample += 1) {
        let sum = 0;
        for (let channel = 0; channel < frame.channels; channel += 1) {
          sum += frame.data[sample * frame.channels + channel]!;
        }
        mono[sample] = Math.round(sum / frame.channels);
      }
      return mono;
    };

    const appendInferenceAudio = (audio: Int16Array) => {
      if (inferenceBuffer.length === 0) {
        inferenceBuffer = audio.slice();
        return;
      }
      const combined = new Int16Array(inferenceBuffer.length + audio.length);
      combined.set(inferenceBuffer);
      combined.set(audio, inferenceBuffer.length);
      inferenceBuffer = combined;
    };

    const updatePrefixBuffer = (frame: AudioFrame) => {
      prefixFrames.push(frame);
      prefixSamples += frame.samplesPerChannel;
      const minimumSpeechDuration = context.getParameter(
        AicVadParameter.MinimumSpeechDuration,
      );
      const activationSamples = Math.max(
        frame.samplesPerChannel,
        Math.trunc(minimumSpeechDuration * frame.sampleRate),
      );
      const targetSamples =
        Math.trunc((this.prefixPaddingDuration * frame.sampleRate) / 1000) +
        predictionDelaySamples +
        activationSamples;
      while (
        prefixFrames.length > 1 &&
        prefixSamples - prefixFrames[0]!.samplesPerChannel >= targetSamples
      ) {
        prefixSamples -= prefixFrames.shift()!.samplesPerChannel;
      }
    };

    const appendSpeechAudio = (frame: AudioFrame) => {
      if (!speechBuffer) return;
      const remainingSamples = Math.max(0, speechBuffer.length - speechSamples);
      const copiedSamples = Math.min(frame.samplesPerChannel, remainingSamples);
      if (copiedSamples > 0) {
        speechBuffer.set(frame.data.subarray(0, copiedSamples), speechSamples);
        speechSamples += copiedSamples;
      }
      if (copiedSamples < frame.samplesPerChannel && !speechBufferFull) {
        speechBufferFull = true;
        this.logger.warn(
          "maxBufferedSpeech reached; ignoring further audio for the current speech",
        );
      }
    };

    const speechEventFrames = (): AudioFrame[] => {
      if (!speechBuffer || speechSamples === 0) return [];
      const snapshot = speechBuffer.slice(0, speechSamples);
      return [new AudioFrame(snapshot, inputSampleRate, 1, speechSamples)];
    };

    while (!this.closed) {
      const { done, value } = await this.inputReader.read();
      if (done) break;
      if (typeof value === "symbol") {
        resetState();
        continue;
      }

      if (inputSampleRate === 0) {
        inputSampleRate = value.sampleRate;
        inferenceBlockSize = this.model.getOptimalBlockSize(inputSampleRate);
        const streamFormat: [number, number] = [inputSampleRate, inferenceBlockSize];
        if (
          !configuredFormat ||
          configuredFormat[0] !== streamFormat[0] ||
          configuredFormat[1] !== streamFormat[1]
        ) {
          try {
            nativeVad.initialize(inputSampleRate, inferenceBlockSize, false);
          } catch (error) {
            throw new Error(
              `ai-coustics VAD initialization failed (model=${this.model.getId()}, ` +
                `sampleRate=${inputSampleRate}, blockSize=${inferenceBlockSize}): ` +
                errorDetail(error),
              { cause: error },
            );
          }
          configuredFormat = streamFormat;
          predictionDelaySamples = context.getPredictionDelay();
        }
        const maxSamples =
          Math.trunc(
            ((this.prefixPaddingDuration + this.maxBufferedSpeech) * inputSampleRate) /
              1000,
          ) + predictionDelaySamples;
        speechBuffer = new Int16Array(maxSamples);
      } else if (value.sampleRate !== inputSampleRate) {
        this.logger.error("a frame with a different sample rate was already pushed");
        continue;
      }

      appendInferenceAudio(toMono(value));

      while (!this.closed && inferenceBuffer.length >= inferenceBlockSize) {
        const pcm = inferenceBuffer.slice(0, inferenceBlockSize);
        inferenceBuffer = inferenceBuffer.slice(inferenceBlockSize);
        const block = pcm16ToFloat32(pcm);

        const started = performance.now();
        try {
          // Keep the block at the incoming LiveKit rate. The SDK was initialized with that rate
          // and performs the VAD model's resampling internally.
          nativeVad.process(block);
        } catch (error) {
          throw new Error(
            `ai-coustics VAD inference failed (model=${this.model.getId()}, ` +
              `sampleRate=${inputSampleRate}, blockSize=${inferenceBlockSize}): ` +
              errorDetail(error),
            { cause: error },
          );
        }
        const inferenceCompleted = performance.now();
        const inferenceDurationMs = inferenceCompleted - started;
        const probability = context.rawVadProbability();
        const detected = context.isSpeechDetected();
        const blockDurationMs = (inferenceBlockSize / inputSampleRate) * 1000;
        processingBacklogMs = Math.max(
          0,
          processingBacklogMs + inferenceDurationMs - blockDurationMs,
        );
        const predictionDelayMs = (predictionDelaySamples / inputSampleRate) * 1000;
        currentSample += inferenceBlockSize;
        timestampMs += blockDurationMs;

        const sensitivity = context.getParameter(AicVadParameter.Sensitivity);
        if (probability >= sensitivity) {
          rawSpeechDurationMs += blockDurationMs;
          rawSilenceDurationMs = 0;
        } else {
          rawSilenceDurationMs += blockDurationMs;
          rawSpeechDurationMs = 0;
        }
        const alignedRawSpeechDurationMs =
          rawSpeechDurationMs > 0 ? rawSpeechDurationMs + predictionDelayMs : 0;
        const alignedRawSilenceDurationMs =
          rawSilenceDurationMs > 0 ? rawSilenceDurationMs + predictionDelayMs : 0;

        if (speaking) speechDurationMs += blockDurationMs;
        else silenceDurationMs += blockDurationMs;

        const inferenceAudio = new AudioFrame(
          pcm,
          inputSampleRate,
          1,
          inferenceBlockSize,
        );
        updatePrefixBuffer(inferenceAudio);
        if (speaking) appendSpeechAudio(inferenceAudio);

        this.sendVADEvent({
          type: VADEventType.INFERENCE_DONE,
          samplesIndex: currentSample,
          timestamp: timestampMs,
          speechDuration: speechDurationMs,
          silenceDuration: silenceDurationMs,
          frames: [inferenceAudio],
          probability,
          inferenceDuration: inferenceDurationMs,
          speaking,
          rawAccumulatedSilence: alignedRawSilenceDurationMs,
          rawAccumulatedSpeech: alignedRawSpeechDurationMs,
        });

        if (detected && !speaking) {
          speaking = true;
          silenceDurationMs = 0;
          speechDurationMs = Math.max(blockDurationMs, alignedRawSpeechDurationMs);
          speechSamples = 0;
          speechBufferFull = false;
          for (const prefixFrame of prefixFrames) appendSpeechAudio(prefixFrame);
          this.sendVADEvent({
            type: VADEventType.START_OF_SPEECH,
            samplesIndex: currentSample,
            timestamp: timestampMs,
            speechDuration: speechDurationMs,
            silenceDuration: 0,
            frames: speechEventFrames(),
            probability,
            inferenceDuration: inferenceDurationMs,
            speaking: true,
            rawAccumulatedSilence: 0,
            rawAccumulatedSpeech: alignedRawSpeechDurationMs,
          });
        } else if (!detected && speaking) {
          speaking = false;
          silenceDurationMs = alignedRawSilenceDurationMs;
          const completedSpeechDurationMs = Math.max(
            0,
            speechDurationMs - silenceDurationMs,
          );
          this.sendVADEvent({
            type: VADEventType.END_OF_SPEECH,
            samplesIndex: currentSample,
            timestamp: timestampMs,
            speechDuration: completedSpeechDurationMs,
            silenceDuration: silenceDurationMs,
            frames: speechEventFrames(),
            probability,
            inferenceDuration: inferenceDurationMs,
            speaking: false,
            rawAccumulatedSilence: alignedRawSilenceDurationMs,
            rawAccumulatedSpeech: 0,
          });
          speechDurationMs = 0;
          speechSamples = 0;
          speechBufferFull = false;
        }

        if (processingBacklogMs === 0) {
          slowWarningActive = false;
        } else if (
          processingBacklogMs >= SLOW_INFERENCE_BACKLOG_THRESHOLD_MS &&
          (!slowWarningActive ||
            inferenceCompleted - this.lastSlowWarning >= SLOW_WARNING_INTERVAL_MS)
        ) {
          slowWarningActive = true;
          this.lastSlowWarning = inferenceCompleted;
          this.logger.warn(
            {
              inferenceDurationMs,
              blockDurationMs,
              realtimeFactor: inferenceDurationMs / blockDurationMs,
              processingBacklogMs,
              sampleRate: inputSampleRate,
              blockSize: inferenceBlockSize,
              modelName: this.model.getId(),
              modelProvider: "ai-coustics",
            },
            "ai-coustics VAD inference is falling behind realtime",
          );
        }
      }
    }
  }
}
