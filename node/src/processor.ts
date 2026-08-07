import { log } from "@livekit/agents";
import {
  AudioFrame,
  FrameProcessor,
  type FrameProcessorStreamInfo,
} from "@livekit/rtc-node";

import {
  type Model,
  Processor as AicProcessor,
  type ProcessorContext,
  ProcessorParameter as AicProcessorParameter,
  setSdkId,
} from "./sdk.js";

const SLOW_WARNING_INTERVAL_MS = 10_000;
const SLOW_BACKLOG_THRESHOLD_MS = 200;
const ERROR_REPORT_INTERVAL_MS = 10_000;

type ProcessingStage = "initialize" | "validate_frame" | "process" | "convert_output";
type LogLevel = "debug" | "info" | "warn" | "error";

export interface ProcessorParameters {
  enhancementLevel?: number;
  bypass?: boolean;
}

export interface ProcessorOptions {
  /** Loaded ai-coustics SDK Model. */
  model: Model;
  licenseKey?: string;
  processorParameters?: ProcessorParameters;
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

export function pcm16ToFloat32(data: Int16Array): Float32Array {
  return Float32Array.from(data, (sample) => sample / 32768);
}

export function float32ToPcm16(data: Float32Array): Int16Array {
  return Int16Array.from(data, (sample) => {
    const clipped = Math.max(-1, Math.min(32767 / 32768, sample));
    return Math.round(clipped * 32768);
  });
}

/** LiveKit AudioFrame processor backed by the public ai-coustics SDK. */
export class Processor extends FrameProcessor<AudioFrame> {
  private processor: InstanceType<typeof AicProcessor> | null;
  private context: ProcessorContext | null;
  private readonly modelId: string;
  private streamFormat: [number, number, number] | null = null;
  private streamInfo: FrameProcessorStreamInfo | null = null;
  private filteringEnabled = true;

  private frameCount = 0;
  private processedFrameCount = 0;
  private failedFrameCount = 0;
  private inputAudioDurationMs = 0;
  private processingDurationTotalMs = 0;
  private processingDurationMaxMs = 0;
  private sdkProcessingDurationTotalMs = 0;
  private sdkProcessingDurationMaxMs = 0;
  private maximumRealtimeFactor = 0;
  private processingBacklogMs = 0;
  private processingBacklogMaxMs = 0;
  private initializationCount = 0;
  private audioDelaySamples: number | null = null;
  private audioDelayMs: number | null = null;
  private lastSlowWarning: number | null = null;
  private slowWarningActive = false;

  private consecutiveFailures = 0;
  private failureStarted: number | null = null;
  private failureEpisodeReported = false;
  private activeErrorSignature: string | null = null;
  private lastReportedErrorSignature: string | null = null;
  private lastErrorReport: number | null = null;

  constructor(options: ProcessorOptions) {
    super();
    const licenseKey = resolveLicenseKey(options.licenseKey);

    // The SDK keeps the first integration identifier it receives. Set this before Processor
    // construction so usage is attributed to the LiveKit Node plugin.
    setSdkId(9);

    try {
      this.modelId = options.model.getId();
      this.processor = new AicProcessor(options.model, licenseKey);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create ai-coustics Processor: ${detail}`, {
        cause: error,
      });
    }
    try {
      this.context = this.processor.getContext();
      if (options.processorParameters) {
        this.setParameters(options.processorParameters);
      }
    } catch (error) {
      try {
        this.processor.terminateSession();
      } catch {
        // best-effort release of the freshly-allocated native session
      }
      throw error;
    }
  }

  isEnabled(): boolean {
    return this.filteringEnabled;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.filteringEnabled) return;
    if (enabled && !this.filteringEnabled && this.context) {
      this.context.reset();
    }
    this.filteringEnabled = enabled;
    this.writeLog(
      "debug",
      `ai-coustics Processor ${enabled ? "enabled" : "disabled"}`,
    );
  }

  setParameters(parameters: ProcessorParameters): void {
    if (!this.context) return;
    if (parameters.enhancementLevel !== undefined) {
      const level = parameters.enhancementLevel;
      if (level < 0 || level > 1) {
        throw new Error(`enhancementLevel must be in [0.0, 1.0], got ${level}`);
      }
      this.context.setParameter(AicProcessorParameter.EnhancementLevel, level);
      this.writeLog("debug", "ai-coustics Processor parameter updated", {
        parameter: "enhancementLevel",
        parameterValue: level,
      });
    }
    if (parameters.bypass !== undefined) {
      if (typeof parameters.bypass !== "boolean") {
        throw new TypeError("bypass must be a boolean");
      }
      this.context.setParameter(
        AicProcessorParameter.Bypass,
        parameters.bypass ? 1 : 0,
      );
      this.writeLog("debug", "ai-coustics Processor parameter updated", {
        parameter: "bypass",
        parameterValue: parameters.bypass,
      });
    }
  }

  override onStreamInfoUpdated(info: FrameProcessorStreamInfo): void {
    const changed =
      this.streamInfo !== null &&
      (this.streamInfo.roomName !== info.roomName ||
        this.streamInfo.participantIdentity !== info.participantIdentity ||
        this.streamInfo.publicationSid !== info.publicationSid);
    if (changed) this.context?.reset();
    this.streamInfo = { ...info };
    this.writeLog(
      "debug",
      `ai-coustics Processor stream ${changed ? "changed; native context reset" : "attached"}`,
    );
  }

  override onStreamInfoCleared(): void {
    if (!this.streamInfo) return;
    const fields = this.diagnosticFields();
    this.context?.reset();
    this.streamInfo = null;
    this.writeLog("debug", "ai-coustics Processor stream detached", fields, true);
  }

  process(frame: AudioFrame): AudioFrame {
    if (!this.isEnabled() || !this.processor || !this.context) {
      return frame;
    }

    const started = performance.now();
    const frameDurationMs =
      (frame.samplesPerChannel / frame.sampleRate) * 1000;
    let processingStage: ProcessingStage = "initialize";
    let sdkProcessingDurationMs = 0;
    try {
      const streamFormat: [number, number, number] = [
        frame.sampleRate,
        frame.channels,
        frame.samplesPerChannel,
      ];
      if (
        !this.streamFormat ||
        this.streamFormat[0] !== streamFormat[0] ||
        this.streamFormat[1] !== streamFormat[1] ||
        this.streamFormat[2] !== streamFormat[2]
      ) {
        const initializationStarted = performance.now();
        this.processor.initialize(streamFormat[0], streamFormat[2], false);
        this.streamFormat = streamFormat;
        this.initializationCount += 1;
        const initializationDurationMs = performance.now() - initializationStarted;
        const audioDelaySamples = this.context.getAudioDelay();
        this.audioDelaySamples = audioDelaySamples;
        this.audioDelayMs = (audioDelaySamples / frame.sampleRate) * 1000;
        this.writeLog(
          "info",
          `ai-coustics Processor ${this.initializationCount === 1 ? "initialized" : "reconfigured"}`,
          {
            initializationDurationMs,
            initializationCount: this.initializationCount,
            audioDelaySamples,
            audioDelayMs: this.audioDelayMs,
            frameDurationMs,
            downmixing: frame.channels > 1,
          },
        );
      }
      processingStage = "validate_frame";
      const expectedSamples = frame.samplesPerChannel * frame.channels;
      if (frame.data.length !== expectedSamples) {
        throw new Error(
          `AudioFrame contains ${frame.data.length} samples, expected ${expectedSamples}`,
        );
      }

      const samples = pcm16ToFloat32(frame.data);
      const mono = new Float32Array(frame.samplesPerChannel);
      if (frame.channels === 1) {
        mono.set(samples);
      } else {
        for (let sample = 0; sample < frame.samplesPerChannel; sample += 1) {
          let sum = 0;
          for (let channel = 0; channel < frame.channels; channel += 1) {
            sum += samples[sample * frame.channels + channel]!;
          }
          mono[sample] = sum / frame.channels;
        }
      }

      processingStage = "process";
      const sdkStarted = performance.now();
      try {
        this.processor.process(mono);
      } finally {
        sdkProcessingDurationMs = performance.now() - sdkStarted;
      }
      processingStage = "convert_output";
      const processedMono = float32ToPcm16(mono);
      let data: Int16Array;
      if (frame.channels === 1) {
        data = processedMono;
      } else {
        data = new Int16Array(expectedSamples);
        for (let sample = 0; sample < frame.samplesPerChannel; sample += 1) {
          for (let channel = 0; channel < frame.channels; channel += 1) {
            data[sample * frame.channels + channel] = processedMono[sample]!;
          }
        }
      }
      const output = new AudioFrame(
        data,
        frame.sampleRate,
        frame.channels,
        frame.samplesPerChannel,
        frame.userdata,
      );
      const completed = performance.now();
      this.recordTiming(
        completed - started,
        sdkProcessingDurationMs,
        frameDurationMs,
        completed,
      );
      this.recordSuccess(completed);
      return output;
    } catch (error) {
      const completed = performance.now();
      this.recordTiming(
        completed - started,
        sdkProcessingDurationMs,
        frameDurationMs,
        completed,
      );
      this.recordFailure(
        processingStage,
        error,
        completed,
        completed - started,
        sdkProcessingDurationMs,
        frameDurationMs,
      );
      return frame;
    }
  }

  close(): void {
    if (!this.processor) return;
    this.filteringEnabled = false;
    const processor = this.processor;

    try {
      processor.terminateSession();
    } catch (error) {
      this.writeLog(
        "error",
        "Failed to terminate ai-coustics Processor session",
        {},
        false,
        error,
      );
    }

    const summary = this.diagnosticFields({
      frameCount: this.frameCount,
      processedFrameCount: this.processedFrameCount,
      failedFrameCount: this.failedFrameCount,
      inputAudioDurationMs: this.inputAudioDurationMs,
      processingDurationTotalMs: this.processingDurationTotalMs,
      processingDurationMaxMs: this.processingDurationMaxMs,
      sdkProcessingDurationTotalMs: this.sdkProcessingDurationTotalMs,
      sdkProcessingDurationMaxMs: this.sdkProcessingDurationMaxMs,
      averageRealtimeFactor:
        this.inputAudioDurationMs > 0
          ? this.processingDurationTotalMs / this.inputAudioDurationMs
          : 0,
      maximumRealtimeFactor: this.maximumRealtimeFactor,
      processingBacklogMaxMs: this.processingBacklogMaxMs,
      initializationCount: this.initializationCount,
      audioDelaySamples: this.audioDelaySamples,
      audioDelayMs: this.audioDelayMs,
      consecutiveFailures: this.consecutiveFailures,
      activeFailureStage: this.activeErrorSignature?.split("\u0000")[0],
      activeErrorType: this.activeErrorSignature?.split("\u0000")[1],
      activeErrorMessage: this.activeErrorSignature?.split("\u0000")[2],
    });
    this.writeLog(
      this.frameCount > 0 ? "info" : "debug",
      this.frameCount > 0
        ? "ai-coustics Processor closed"
        : "ai-coustics Processor closed without processing audio",
      summary,
      true,
    );
    this.context = null;
    this.processor = null;
    this.streamFormat = null;
    this.streamInfo = null;
  }

  private recordTiming(
    processingDurationMs: number,
    sdkProcessingDurationMs: number,
    frameDurationMs: number,
    completed: number,
  ): void {
    this.frameCount += 1;
    this.inputAudioDurationMs += frameDurationMs;
    this.processingDurationTotalMs += processingDurationMs;
    this.processingDurationMaxMs = Math.max(
      this.processingDurationMaxMs,
      processingDurationMs,
    );
    this.sdkProcessingDurationTotalMs += sdkProcessingDurationMs;
    this.sdkProcessingDurationMaxMs = Math.max(
      this.sdkProcessingDurationMaxMs,
      sdkProcessingDurationMs,
    );
    const realtimeFactor = processingDurationMs / frameDurationMs;
    this.maximumRealtimeFactor = Math.max(
      this.maximumRealtimeFactor,
      realtimeFactor,
    );
    this.processingBacklogMs = Math.max(
      0,
      this.processingBacklogMs + processingDurationMs - frameDurationMs,
    );
    this.processingBacklogMaxMs = Math.max(
      this.processingBacklogMaxMs,
      this.processingBacklogMs,
    );

    if (this.processingBacklogMs === 0) {
      this.slowWarningActive = false;
    } else if (
      this.processingBacklogMs >= SLOW_BACKLOG_THRESHOLD_MS &&
      (!this.slowWarningActive ||
        this.lastSlowWarning === null ||
        completed - this.lastSlowWarning >= SLOW_WARNING_INTERVAL_MS)
    ) {
      this.slowWarningActive = true;
      this.lastSlowWarning = completed;
      this.writeLog("warn", "ai-coustics Processor is falling behind realtime", {
        processingDurationMs,
        sdkProcessingDurationMs,
        frameDurationMs,
        realtimeFactor,
        processingBacklogMs: this.processingBacklogMs,
        processingBacklogMaxMs: this.processingBacklogMaxMs,
      });
    }
  }

  private recordFailure(
    stage: ProcessingStage,
    error: unknown,
    completed: number,
    processingDurationMs: number,
    sdkProcessingDurationMs: number,
    frameDurationMs: number,
  ): void {
    const errorType = error instanceof Error ? error.name : typeof error;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const signature = `${stage}\u0000${errorType}\u0000${errorMessage}`;
    this.failedFrameCount += 1;
    if (this.consecutiveFailures === 0) {
      this.failureStarted = completed - processingDurationMs;
      this.failureEpisodeReported = false;
    }
    this.consecutiveFailures += 1;
    this.activeErrorSignature = signature;

    const shouldReport =
      signature !== this.lastReportedErrorSignature ||
      this.lastErrorReport === null ||
      completed - this.lastErrorReport >= ERROR_REPORT_INTERVAL_MS;
    if (!shouldReport) return;

    this.failureEpisodeReported = true;
    this.lastReportedErrorSignature = signature;
    this.lastErrorReport = completed;
    this.writeLog(
      "error",
      "ai-coustics Processor failed; passing audio through",
      {
        processingStage: stage,
        errorType,
        errorMessage,
        consecutiveFailures: this.consecutiveFailures,
        failedFrameCount: this.failedFrameCount,
        processingDurationMs,
        sdkProcessingDurationMs,
        frameDurationMs,
        realtimeFactor: processingDurationMs / frameDurationMs,
        failureDurationMs:
          completed - (this.failureStarted === null ? completed : this.failureStarted),
      },
      false,
      error,
    );
  }

  private recordSuccess(completed: number): void {
    this.processedFrameCount += 1;
    if (this.consecutiveFailures === 0) return;

    if (this.failureEpisodeReported) {
      const [lastFailureStage, lastErrorType, lastErrorMessage] =
        this.activeErrorSignature?.split("\u0000") ?? [];
      this.writeLog("info", "ai-coustics Processor recovered", {
        recoveredFailureCount: this.consecutiveFailures,
        failureDurationMs:
          completed - (this.failureStarted === null ? completed : this.failureStarted),
        failedFrameCount: this.failedFrameCount,
        lastFailureStage,
        lastErrorType,
        lastErrorMessage,
      });
    }
    this.consecutiveFailures = 0;
    this.failureStarted = null;
    this.failureEpisodeReported = false;
    this.activeErrorSignature = null;
  }

  private diagnosticFields(
    fields: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const diagnostics: Record<string, unknown> = {
      modelProvider: "ai-coustics",
      modelName: this.modelId,
    };
    if (this.streamInfo) Object.assign(diagnostics, this.streamInfo);
    if (this.streamFormat) {
      Object.assign(diagnostics, {
        sampleRate: this.streamFormat[0],
        numChannels: this.streamFormat[1],
        samplesPerFrame: this.streamFormat[2],
      });
    }
    return Object.assign(diagnostics, fields);
  }

  private writeLog(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown> = {},
    fieldsAreComplete = false,
    error?: unknown,
  ): void {
    const diagnostics = fieldsAreComplete
      ? fields
      : this.diagnosticFields(fields);
    const payload = error === undefined ? diagnostics : { ...diagnostics, error };
    try {
      log()[level](payload, message);
      return;
    } catch (loggingError) {
      const loggerIsUninitialized =
        loggingError instanceof TypeError &&
        loggingError.message.includes("logger not initialized");
      if (!loggerIsUninitialized) {
        console.error("Failed to write ai-coustics diagnostic through LiveKit", {
          error: loggingError,
        });
      }
    }

    // Processor instances can be constructed before LiveKit configures its global logger. Keep
    // operational diagnostics visible in that case, but do not turn normally-hidden debug events
    // into unsolicited console output.
    if (level === "error") console.error(message, payload);
    else if (level === "warn") console.warn(message, payload);
    else if (level === "info") console.info(message, payload);
  }
}
