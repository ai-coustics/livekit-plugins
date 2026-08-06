import { AudioFrame, FrameProcessor } from "@livekit/rtc-node";

import {
  Model,
  type OtelConfig,
  Processor,
  type ProcessorContext,
  type ProcessorParameter,
  ProcessorParameter as ProcessorParameters,
} from "./sdk.js";

export type ModelInput = Model | string;

export interface AudioEnhancementParams {
  model: ModelInput;
  licenseKey?: string;
  enhancementLevel?: number;
  bypass?: number;
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

function resolveModel(value: ModelInput): Model {
  return typeof value === "string" ? Model.fromFile(value) : value;
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
  private readonly model: Model;
  private readonly licenseKey: string;
  private readonly otelConfig?: OtelConfig;
  private processor: InstanceType<typeof Processor> | null;
  private context: ProcessorContext | null;
  private readonly parameters = new Map<ProcessorParameter, number>();
  private streamConfig: { sampleRate: number; channels: number } | null = null;
  private optimalNumFrames = 0;
  private filteringEnabled = true;
  private lastErrorMessage: string | null = null;

  constructor(params: AudioEnhancementParams) {
    super();
    this.model = resolveModel(params.model);
    this.licenseKey = resolveLicenseKey(params.licenseKey);
    this.otelConfig = params.otelConfig;
    this.processor = new Processor(this.model, this.licenseKey, this.otelConfig);
    this.context = this.processor.getProcessorContext();

    if (params.enhancementLevel !== undefined) {
      this.setParameter(
        ProcessorParameters.EnhancementLevel,
        params.enhancementLevel,
      );
    }
    if (params.bypass !== undefined) {
      this.setParameter(ProcessorParameters.Bypass, params.bypass);
    }
  }

  isEnabled(): boolean {
    return this.filteringEnabled;
  }

  setEnabled(enabled: boolean): void {
    this.filteringEnabled = enabled;
  }

  get processorContext(): ProcessorContext {
    if (!this.context) {
      throw new Error("The ai-coustics processor is closed");
    }
    return this.context;
  }

  get outputDelay(): number {
    return this.processorContext.getOutputDelay();
  }

  setParameter(parameter: ProcessorParameter, value: number): void {
    this.parameters.set(parameter, value);
    if (this.streamConfig) {
      this.processorContext.setParameter(parameter, value);
    }
  }

  private initialize(sampleRate: number, channels: number): void {
    if (!this.processor) {
      this.processor = new Processor(this.model, this.licenseKey, this.otelConfig);
      this.context = this.processor.getProcessorContext();
    }

    this.optimalNumFrames = this.model.getOptimalNumFrames(sampleRate);
    this.processor.initialize(sampleRate, channels, this.optimalNumFrames, true);
    this.streamConfig = { sampleRate, channels };
    for (const [parameter, value] of this.parameters) {
      this.processorContext.setParameter(parameter, value);
    }
  }

  process(frame: AudioFrame): AudioFrame {
    if (!this.isEnabled()) {
      return frame;
    }

    try {
      if (
        !this.streamConfig ||
        this.streamConfig.sampleRate !== frame.sampleRate ||
        this.streamConfig.channels !== frame.channels
      ) {
        this.initialize(frame.sampleRate, frame.channels);
      }

      const expectedSamples = frame.samplesPerChannel * frame.channels;
      if (frame.data.length !== expectedSamples) {
        throw new Error(
          `AudioFrame contains ${frame.data.length} samples, expected ${expectedSamples}`,
        );
      }

      const samples = pcm16ToFloat32(frame.data);
      const samplesPerBlock = this.optimalNumFrames * frame.channels;
      for (let start = 0; start < samples.length; start += samplesPerBlock) {
        const end = Math.min(start + samplesPerBlock, samples.length);
        this.processor!.processInterleaved(samples.subarray(start, end));
      }

      this.lastErrorMessage = null;
      return new AudioFrame(
        float32ToPcm16(samples),
        frame.sampleRate,
        frame.channels,
        frame.samplesPerChannel,
        frame.userdata,
      );
    } catch (error) {
      this.logError(`ai-coustics processing failed: ${String(error)}`);
      return frame;
    }
  }

  close(): void {
    if (this.context && this.streamConfig) {
      try {
        this.context.reset();
      } catch (error) {
        this.logError(`Failed to reset the ai-coustics processor: ${String(error)}`);
      }
    }
    this.filteringEnabled = false;
    this.streamConfig = null;
    this.context = null;
    this.processor = null;
  }

  private logError(message: string): void {
    if (message === this.lastErrorMessage) {
      return;
    }
    this.lastErrorMessage = message;
    console.error(message);
  }
}

export function audioEnhancement(params: AudioEnhancementParams): AudioEnhancement {
  return new AudioEnhancement(params);
}
