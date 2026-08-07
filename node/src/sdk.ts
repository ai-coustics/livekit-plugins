import {
  Model as NativeModel,
  Processor as NativeProcessor,
  ProcessorParameter as NativeProcessorParameter,
  _setSdkId as nativeSetSdkId,
} from "@ai-coustics/aic-sdk";

/** Public structural types for aic-sdk 0.22, which does not ship TypeScript declarations. */
export interface Model {
  getId(): string;
  getOptimalSampleRate(): number;
  getOptimalBlockSize(sampleRate: number): number;
}

interface ModelConstructor {
  fromFile(path: string): Model;
  download(modelId: string, downloadDir: string): string;
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
  getAudioDelay(): number;
  updateBearerToken(token: string): void;
}

interface ProcessorInstance {
  initialize(
    sampleRate: number,
    blockSize: number,
    variableBlockSize?: boolean,
  ): void;
  process(buffer: Float32Array): void;
  getContext(): ProcessorContext;
  terminateSession(): void;
}

interface ProcessorConstructor {
  new (model: Model, licenseKey: string): ProcessorInstance;
}

export const Model: ModelConstructor = NativeModel;
export const Processor: ProcessorConstructor = NativeProcessor;
export const setSdkId: (id: number) => void = nativeSetSdkId;
