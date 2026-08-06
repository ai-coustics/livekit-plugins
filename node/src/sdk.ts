import {
  Model as NativeModel,
  OtelConfig as NativeOtelConfig,
  Processor as NativeProcessor,
  ProcessorParameter as NativeProcessorParameter,
} from "@ai-coustics/aic-sdk";

/** Public structural types for aic-sdk 0.21, which does not ship TypeScript declarations. */
export interface Model {
  getId(): string;
  getOptimalSampleRate(): number;
  getOptimalNumFrames(sampleRate: number): number;
}

interface ModelConstructor {
  fromFile(path: string): Model;
  download(modelId: string, downloadDir: string): string;
}

export interface OtelConfig {
  enable: boolean;
  sessionId: string | null;
  exportIntervalMs: number;
}

interface OtelConfigConstructor {
  enabled(): OtelConfig;
  disabled(): OtelConfig;
  withSessionId(sessionId: string): OtelConfig;
}

export const ProcessorParameter: {
  readonly Bypass: number;
  readonly EnhancementLevel: number;
} = NativeProcessorParameter;
export type ProcessorParameter =
  (typeof ProcessorParameter)[keyof typeof ProcessorParameter];

export interface ProcessorContext {
  reset(): void;
  setParameter(parameter: ProcessorParameter, value: number): void;
  getParameter(parameter: ProcessorParameter): number;
  getOutputDelay(): number;
  updateBearerToken(token: string): void;
}

interface ProcessorInstance {
  initialize(
    sampleRate: number,
    numChannels: number,
    numFrames: number,
    allowVariableFrames?: boolean,
  ): void;
  processInterleaved(buffer: Float32Array): void;
  getProcessorContext(): ProcessorContext;
}

interface ProcessorConstructor {
  new (
    model: Model,
    licenseKey: string,
    otelConfig?: OtelConfig | null,
  ): ProcessorInstance;
}

export const Model: ModelConstructor = NativeModel;
export const OtelConfig: OtelConfigConstructor = NativeOtelConfig;
export const Processor: ProcessorConstructor = NativeProcessor;

