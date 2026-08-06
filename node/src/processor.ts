import { AudioFrame, FrameProcessor } from "@livekit/rtc-node";

import {
  DEFAULT_DOWNLOAD_DIR,
  loadModel,
  type ModelInput,
} from "./model.js";
import {
  type OtelConfig,
  Processor,
  type ProcessorContext,
  type ProcessorParameter,
  ProcessorParameter as ProcessorParameters,
} from "./sdk.js";

const SLOW_WARNING_INTERVAL_MS = 10_000;

export interface ModelParameters {
  enhancementLevel?: number;
  bypass?: boolean;
}

export interface AudioEnhancementParams {
  /** SDK Model, artifact model ID, or local `.aicmodel` path. */
  model: ModelInput;
  licenseKey?: string;
  modelParameters?: ModelParameters;
  enhancementLevel?: number;
  bypass?: boolean;
  downloadDir?: string;
  otelConfig?: OtelConfig;
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
export class AudioEnhancement extends FrameProcessor<AudioFrame> {
  private processor: InstanceType<typeof Processor> | null;
  private context: ProcessorContext | null;
  private readonly parameters = new Map<ProcessorParameter, number>();
  private readonly modelParameters: ModelParameters;
  private streamFormat: [number, number, number] | null = null;
  private filteringEnabled = true;
  private needsReset = false;
  private lastErrorMessage: string | null = null;
  private lastSlowWarning = 0;

  constructor(params: AudioEnhancementParams) {
    super();
    const licenseKey = resolveLicenseKey(params.licenseKey);
    const model = loadModel(
      params.model,
      params.downloadDir ?? DEFAULT_DOWNLOAD_DIR,
    );
    try {
      this.processor = new Processor(
        model,
        licenseKey,
        params.otelConfig,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create ai-coustics Processor: ${detail}`, {
        cause: error,
      });
    }
    this.context = this.processor.getProcessorContext();
    this.modelParameters = { ...params.modelParameters };
    if (params.enhancementLevel !== undefined) {
      this.modelParameters.enhancementLevel = params.enhancementLevel;
    }
    if (params.bypass !== undefined) {
      this.modelParameters.bypass = params.bypass;
    }
    this.updateModelParameters(this.modelParameters);
  }

  isEnabled(): boolean {
    return this.filteringEnabled;
  }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.filteringEnabled) {
      this.needsReset = true;
    }
    this.filteringEnabled = enabled;
  }

  get processorContext(): ProcessorContext {
    if (!this.context) {
      throw new Error("The ai-coustics processor is closed");
    }
    return this.context;
  }

  get outputDelay(): number {
    if (!this.context) {
      throw new Error("The ai-coustics processor is closed");
    }
    return this.context.getOutputDelay();
  }

  setParameter(parameter: ProcessorParameter, value: number): void {
    this.parameters.set(parameter, value);
    this.context?.setParameter(parameter, value);
  }

  updateModelParameters(parameters: ModelParameters): void {
    if (parameters.enhancementLevel !== undefined) {
      const level = parameters.enhancementLevel;
      if (level < 0 || level > 1) {
        throw new Error(`enhancementLevel must be in [0.0, 1.0], got ${level}`);
      }
      this.modelParameters.enhancementLevel = level;
      this.setParameter(ProcessorParameters.EnhancementLevel, level);
    }
    if (parameters.bypass !== undefined) {
      if (typeof parameters.bypass !== "boolean") {
        throw new TypeError("bypass must be a boolean");
      }
      this.modelParameters.bypass = parameters.bypass;
      this.setParameter(ProcessorParameters.Bypass, parameters.bypass ? 1 : 0);
    }
  }

  private applyParameters(): void {
    if (!this.context) return;
    for (const [parameter, value] of this.parameters) {
      this.context.setParameter(parameter, value);
    }
  }

  process(frame: AudioFrame): AudioFrame {
    if (!this.isEnabled() || !this.processor || !this.context) {
      return frame;
    }

    const started = performance.now();
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
        this.processor.initialize(...streamFormat, false);
        this.streamFormat = streamFormat;
        this.needsReset = false;
        this.applyParameters();
        console.info(
          `ai-coustics initialized: ${streamFormat[0]} Hz, ${streamFormat[1]} ch, ` +
            `${streamFormat[2]} samples/frame, output delay ${this.context.getOutputDelay()} samples`,
        );
      }
      if (this.needsReset) {
        this.context.reset();
        this.needsReset = false;
      }

      const expectedSamples = frame.samplesPerChannel * frame.channels;
      if (frame.data.length !== expectedSamples) {
        throw new Error(
          `AudioFrame contains ${frame.data.length} samples, expected ${expectedSamples}`,
        );
      }

      const samples = pcm16ToFloat32(frame.data);
      this.processor.processInterleaved(samples);
      const data = float32ToPcm16(samples);
      this.lastErrorMessage = null;

      const elapsedMs = performance.now() - started;
      const frameDurationMs =
        (frame.samplesPerChannel / frame.sampleRate) * 1000;
      if (
        elapsedMs > frameDurationMs &&
        started - this.lastSlowWarning > SLOW_WARNING_INTERVAL_MS
      ) {
        this.lastSlowWarning = started;
        console.warn(
          `ai-coustics processing is slower than realtime ` +
            `(${elapsedMs.toFixed(1)} ms for a ${frameDurationMs.toFixed(1)} ms frame); ` +
            `consider a smaller model`,
        );
      }

      return new AudioFrame(
        data,
        frame.sampleRate,
        frame.channels,
        frame.samplesPerChannel,
        frame.userdata,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : `Error: ${String(error)}`;
      this.logError(message);
      return frame;
    }
  }

  close(): void {
    this.filteringEnabled = false;
    this.context = null;
    this.processor = null;
    this.streamFormat = null;
  }

  private logError(message: string): void {
    if (message === this.lastErrorMessage) {
      return;
    }
    this.lastErrorMessage = message;
    console.error(`ai-coustics processing failed; passing audio through: ${message}`);
  }
}

export function audioEnhancement(params: AudioEnhancementParams): AudioEnhancement {
  return new AudioEnhancement(params);
}
