import type { TypedEventEmitter as TypedEmitter } from "@livekit/typed-emitter";
import { metrics } from "@opentelemetry/api";
import { EventEmitter } from "node:events";
import {
  AudioFrame,
  FrameProcessor,
  type FrameProcessorStreamInfo,
} from "@livekit/rtc-node";

import { writeLog } from "./log.js";
import { pcm16ToFloat32 } from "./processor.js";
import {
  Analyzer as AicAnalyzer,
  type AnalysisResult,
  type Model,
  setSdkId,
} from "./sdk.js";

const DEFAULT_ANALYSIS_INTERVAL_SECONDS = 5;
const OVERLAP_WARNING_INTERVAL_MS = 10_000;
const meter = metrics.getMeter("ai-coustics-livekit-plugin");
const analysisCount = meter.createCounter("ai_coustics.analyzer.analysis", {
  description: "Number of ai-coustics buffered audio analyses",
});
const inferenceDuration = meter.createHistogram(
  "ai_coustics.analyzer.inference_duration",
  {
    unit: "s",
    description: "Duration of ai-coustics buffered audio analysis",
  },
);
const score = meter.createHistogram("ai_coustics.analyzer.score", {
  description: "Audio analysis score produced by ai-coustics",
});
const metricBaseAttributes = { model_provider: "ai-coustics" } as const;
const resultFields = [
  ["risk_score", "riskScore"],
  ["speaker_reverb", "speakerReverb"],
  ["speaker_loudness", "speakerLoudness"],
  ["interfering_speech", "interferingSpeech"],
  ["noise", "noise"],
  ["codec_degradation", "codecDegradation"],
  ["packet_loss", "packetLoss"],
] as const satisfies ReadonlyArray<readonly [string, keyof AnalysisResult]>;

export interface AnalyzerOptions {
  /** Loaded ai-coustics SDK analysis model. */
  model: Model;
  licenseKey?: string;
  /** Seconds between analyses. Defaults to 5. */
  analysisInterval?: number;
  /** Record aggregate OpenTelemetry metrics. Defaults to true. */
  enableMetrics?: boolean;
}

export interface AnalysisEvent {
  readonly result: Readonly<AnalysisResult>;
  /** Unix timestamp in milliseconds recorded after inference completed. */
  readonly timestamp: number;
  /** Elapsed inference time in milliseconds. */
  readonly inferenceDuration: number;
  readonly sequence: number;
  readonly modelId: string;
  readonly roomName?: string;
  readonly participantIdentity?: string;
  readonly publicationSid?: string;
}

export type AnalyzerCallbacks = {
  analysisResult: (event: AnalysisEvent) => void;
};

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

/**
 * Transparent LiveKit frame processor that collects audio for an Analyzer.
 *
 * Holds the same native analyzer as its owning {@link Analyzer} but only ever calls the
 * buffering half of that API, which does not take the analyzer lock.
 */
export class Collector extends FrameProcessor<AudioFrame> {
  private nativeAnalyzer: AicAnalyzer | null;
  private readonly resetAnalyzer: () => void;
  private readonly closeAnalyzer: () => void;
  private streamFormat: [number, number, number] | null = null;
  private streamInfo: FrameProcessorStreamInfo | null = null;
  private hasBufferedAudio = false;
  private collectingEnabled = true;
  private closed = false;

  constructor(
    nativeAnalyzer: AicAnalyzer,
    resetAnalyzer: () => void,
    closeAnalyzer: () => void,
  ) {
    super();
    this.nativeAnalyzer = nativeAnalyzer;
    this.resetAnalyzer = resetAnalyzer;
    this.closeAnalyzer = closeAnalyzer;
  }

  isEnabled(): boolean {
    return this.collectingEnabled;
  }

  setEnabled(enabled: boolean): void {
    if (this.closed || enabled === this.collectingEnabled) return;
    if (enabled) this.reset();
    this.collectingEnabled = enabled;
  }

  /** True while the collector has collected some audio the analyzer can act on. */
  get initialized(): boolean {
    return (
      this.collectingEnabled && this.hasBufferedAudio && this.nativeAnalyzer !== null
    );
  }

  get currentStreamInfo(): FrameProcessorStreamInfo | null {
    return this.streamInfo ? { ...this.streamInfo } : null;
  }

  override onStreamInfoUpdated(info: FrameProcessorStreamInfo): void {
    this.streamInfo = { ...info };
    this.reset();
  }

  override onStreamInfoCleared(): void {
    this.streamInfo = null;
    this.reset();
  }

  process(frame: AudioFrame): AudioFrame {
    const native = this.nativeAnalyzer;
    if (!this.collectingEnabled || !native) return frame;

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
        native.initialize(frame.sampleRate, frame.samplesPerChannel, false);
        this.streamFormat = streamFormat;
      }

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
      native.buffer(mono);
      this.hasBufferedAudio = true;
    } catch (error) {
      writeLog(
        "error",
        "collector",
        "failed; passing audio through",
        this.streamInfo ?? {},
        error,
      );
    }

    return frame;
  }

  private reset(): void {
    if (this.closed) return;
    this.hasBufferedAudio = false;
    try {
      this.resetAnalyzer();
    } catch (error) {
      writeLog(
        "error",
        "analyzer",
        "reset failed",
        { errorMessage: errorDetail(error) },
        error,
      );
    }
  }

  detach(): void {
    this.closed = true;
    this.collectingEnabled = false;
    this.streamFormat = null;
    this.streamInfo = null;
    this.hasBufferedAudio = false;
    this.nativeAnalyzer = null;
  }

  close(): void {
    if (this.closed) return;
    this.detach();
    this.closeAnalyzer();
  }
}

/** Owns an SDK analyzer pair and periodically reports analysis of collected room audio. */
export class Analyzer extends (EventEmitter as new () => TypedEmitter<AnalyzerCallbacks>) {
  readonly collector: Collector;

  private nativeAnalyzer: AicAnalyzer | null;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly modelId: string;
  private readonly enableMetrics: boolean;
  private readonly analysisIntervalMs: number;
  private analysisInFlight: Promise<void> | null = null;
  private teardown: Promise<void> | null = null;
  private skippedAnalyses = 0;
  private lastOverlapWarning: number | null = null;
  private sequence = 0;
  private closed = false;

  constructor(options: AnalyzerOptions) {
    super();
    const analysisInterval =
      options.analysisInterval ?? DEFAULT_ANALYSIS_INTERVAL_SECONDS;
    if (!Number.isFinite(analysisInterval) || analysisInterval <= 0) {
      throw new Error("analysisInterval must be a finite value greater than zero");
    }

    setSdkId(9);
    let nativeAnalyzer: AicAnalyzer;
    try {
      this.modelId = options.model.getId();
      nativeAnalyzer = new AicAnalyzer(
        options.model,
        resolveLicenseKey(options.licenseKey),
      );
    } catch (error) {
      throw new Error(`Failed to create ai-coustics Analyzer: ${errorDetail(error)}`, {
        cause: error,
      });
    }

    this.nativeAnalyzer = nativeAnalyzer;
    this.enableMetrics = options.enableMetrics ?? true;
    this.collector = new Collector(
      nativeAnalyzer,
      // Stream changes are rare and off the audio path, so reset stays synchronous even
      // though it waits for the analyzer lock when an analysis is in flight.
      () => nativeAnalyzer.reset(),
      () => void this.close(),
    );
    this.analysisIntervalMs = analysisInterval * 1000;
    this.timer = setInterval(() => this.scheduleAnalysis(), this.analysisIntervalMs);
    this.timer.unref?.();
  }

  private scheduleAnalysis(): void {
    const analyzer = this.nativeAnalyzer;
    if (this.closed || !analyzer || !this.collector.initialized) return;

    if (this.analysisInFlight) {
      this.skippedAnalyses += 1;
      const now = performance.now();
      if (
        this.lastOverlapWarning === null ||
        now - this.lastOverlapWarning >= OVERLAP_WARNING_INTERVAL_MS
      ) {
        this.lastOverlapWarning = now;
        writeLog("warn", "analyzer", "analysis falling behind its interval", {
          modelName: this.modelId,
          analysisIntervalMs: this.analysisIntervalMs,
          skippedAnalyses: this.skippedAnalyses,
          ...(this.collector.currentStreamInfo ?? {}),
        });
      }
      return;
    }

    const tracked = this.analyze(analyzer).finally(() => {
      if (this.analysisInFlight === tracked) this.analysisInFlight = null;
    });
    this.analysisInFlight = tracked;
  }

  /** Runs one analysis on a libuv worker thread. Never rejects; failures are logged. */
  private async analyze(analyzer: AicAnalyzer): Promise<void> {
    const started = performance.now();
    try {
      const nativeResult = await analyzer.analyzeAsync();
      const elapsed = performance.now() - started;
      const result = Object.freeze({ ...nativeResult });
      this.sequence += 1;
      const streamInfo = this.collector.currentStreamInfo;
      const event = Object.freeze({
        result,
        timestamp: Date.now(),
        inferenceDuration: elapsed,
        sequence: this.sequence,
        modelId: this.modelId,
        ...(streamInfo ?? {}),
      }) satisfies AnalysisEvent;

      this.recordMetrics(elapsed, "ok", result);
      try {
        this.emit("analysisResult", event);
      } catch (error) {
        writeLog(
          "error",
          "analyzer",
          "result event emission failed",
          { modelName: this.modelId, sequence: this.sequence, ...(streamInfo ?? {}) },
          error,
        );
      }
    } catch (error) {
      this.recordMetrics(performance.now() - started, "error");
      writeLog(
        "error",
        "analyzer",
        "buffered audio analysis failed",
        { modelName: this.modelId, ...(this.collector.currentStreamInfo ?? {}) },
        error,
      );
    }
  }

  private recordMetrics(
    inferenceDurationMs: number,
    status: "ok" | "error",
    result?: Readonly<AnalysisResult>,
  ): void {
    if (!this.enableMetrics) return;

    try {
      const attributes = { ...metricBaseAttributes, status };
      analysisCount.add(1, attributes);
      inferenceDuration.record(inferenceDurationMs / 1000, attributes);
      if (result) {
        for (const [scoreName, property] of resultFields) {
          score.record(result[property], {
            ...metricBaseAttributes,
            "score.name": scoreName,
          });
        }
      }
    } catch (error) {
      writeLog(
        "error",
        "analyzer",
        "metrics recording failed",
        { modelName: this.modelId, status },
        error,
      );
    }
  }

  /**
   * Stops scheduled analysis and releases the SDK session.
   *
   * Resolves once any in-flight analysis has settled. Teardown waits for it because
   * `terminateSession()` and `dispose()` block on the analyzer lock. Safe to call without
   * awaiting, and repeated calls return the same promise.
   */
  close(): Promise<void> {
    if (this.teardown) return this.teardown;
    this.closed = true;
    clearInterval(this.timer);
    this.collector.detach();
    const analyzer = this.nativeAnalyzer;
    this.nativeAnalyzer = null;
    this.teardown = (this.analysisInFlight ?? Promise.resolve()).then(() => {
      if (analyzer) this.release(analyzer);
    });
    return this.teardown;
  }

  private release(analyzer: AicAnalyzer): void {
    try {
      analyzer.terminateSession();
    } catch (error) {
      writeLog(
        "error",
        "analyzer",
        "session termination failed",
        { modelName: this.modelId, errorMessage: errorDetail(error) },
        error,
      );
    }
    try {
      analyzer.dispose();
    } catch (error) {
      writeLog(
        "error",
        "analyzer",
        "native disposal failed",
        { modelName: this.modelId, errorMessage: errorDetail(error) },
        error,
      );
    }
  }
}
