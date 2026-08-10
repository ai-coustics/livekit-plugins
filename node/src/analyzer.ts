import { log } from "@livekit/agents";
import {
  AudioFrame,
  FrameProcessor,
  type FrameProcessorStreamInfo,
} from "@livekit/rtc-node";

import { pcm16ToFloat32 } from "./processor.js";
import {
  type AnalysisResult,
  type AnalyzerInstance,
  type CollectorInstance,
  type Model,
  analyzerPair,
  setSdkId,
} from "./sdk.js";

const DEFAULT_ANALYSIS_INTERVAL_SECONDS = 5;

export interface AnalyzerOptions {
  /** Loaded ai-coustics SDK analysis model. */
  model: Model;
  licenseKey?: string;
  /** Seconds between analyses. Defaults to 5. */
  analysisInterval?: number;
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

/** Transparent LiveKit frame processor that collects audio for an Analyzer. */
export class Collector extends FrameProcessor<AudioFrame> {
  private nativeCollector: CollectorInstance | null;
  private readonly resetAnalyzer: () => void;
  private readonly closeAnalyzer: () => void;
  private streamFormat: [number, number, number] | null = null;
  private collectingEnabled = true;
  private closed = false;

  constructor(
    nativeCollector: CollectorInstance,
    resetAnalyzer: () => void,
    closeAnalyzer: () => void,
  ) {
    super();
    this.nativeCollector = nativeCollector;
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

  get initialized(): boolean {
    return this.streamFormat !== null && this.nativeCollector !== null;
  }

  override onStreamInfoUpdated(_info: FrameProcessorStreamInfo): void {
    this.reset();
  }

  override onStreamInfoCleared(): void {
    this.reset();
  }

  process(frame: AudioFrame): AudioFrame {
    const collector = this.nativeCollector;
    if (!this.collectingEnabled || !collector) return frame;

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
        collector.initialize(frame.sampleRate, frame.samplesPerChannel, false);
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
      collector.buffer(mono);
    } catch (error) {
      console.error("ai-coustics Collector failed; passing audio through", error);
    }

    return frame;
  }

  private reset(): void {
    if (this.closed) return;
    try {
      this.resetAnalyzer();
    } catch (error) {
      console.error(`Failed to reset ai-coustics Analyzer: ${errorDetail(error)}`);
    }
  }

  detach(): void {
    this.closed = true;
    this.collectingEnabled = false;
    this.streamFormat = null;
    this.nativeCollector = null;
  }

  close(): void {
    if (this.closed) return;
    this.detach();
    this.closeAnalyzer();
  }
}

/** Owns an SDK analyzer pair and periodically logs analysis of collected room audio. */
export class Analyzer {
  readonly collector: Collector;

  private nativeAnalyzer: AnalyzerInstance | null;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(options: AnalyzerOptions) {
    const analysisInterval =
      options.analysisInterval ?? DEFAULT_ANALYSIS_INTERVAL_SECONDS;
    if (!Number.isFinite(analysisInterval) || analysisInterval <= 0) {
      throw new Error("analysisInterval must be a finite value greater than zero");
    }

    setSdkId(9);
    let pair: ReturnType<typeof analyzerPair>;
    try {
      pair = analyzerPair(options.model, resolveLicenseKey(options.licenseKey));
    } catch (error) {
      throw new Error(`Failed to create ai-coustics Analyzer: ${errorDetail(error)}`, {
        cause: error,
      });
    }

    this.nativeAnalyzer = pair.analyzer;
    this.collector = new Collector(
      pair.collector,
      () => pair.analyzer.reset(),
      () => this.close(),
    );
    this.timer = setInterval(() => this.analyze(), analysisInterval * 1000);
    this.timer.unref?.();
  }

  private analyze(): void {
    const analyzer = this.nativeAnalyzer;
    if (!analyzer || !this.collector.initialized) return;

    try {
      const result = analyzer.analyzeBuffered();
      this.logResult(result);
    } catch (error) {
      console.error("ai-coustics Analyzer failed to analyze buffered audio", error);
    }
  }

  private logResult(result: AnalysisResult): void {
    const fields = {
      modelProvider: "ai-coustics",
      riskScore: result.riskScore,
      speakerReverb: result.speakerReverb,
      speakerLoudness: result.speakerLoudness,
      interferingSpeech: result.interferingSpeech,
      mediaSpeech: result.mediaSpeech,
      noise: result.noise,
      packetLoss: result.packetLoss,
    };
    try {
      log().info(fields, "ai-coustics analysis result");
    } catch {
      console.info("ai-coustics analysis result", fields);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.collector.detach();
    const analyzer = this.nativeAnalyzer;
    this.nativeAnalyzer = null;
    if (!analyzer) return;
    try {
      analyzer.terminateSession();
    } catch (error) {
      console.error(`Failed to terminate ai-coustics Analyzer session: ${errorDetail(error)}`);
    }
  }
}
