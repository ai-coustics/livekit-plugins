import {
  Model as NativeModel,
  Processor as NativeProcessor,
  ProcessorParameter as NativeProcessorParameter,
  Vad as NativeVad,
  VadParameter as NativeVadParameter,
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

export const VadParameter: {
  readonly SpeechHoldDuration: number;
  readonly Sensitivity: number;
  readonly MinimumSpeechDuration: number;
} = NativeVadParameter;
export type VadParameter = (typeof VadParameter)[keyof typeof VadParameter];

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

export interface VadContext {
  reset(): void;
  isSpeechDetected(): boolean;
  rawVadProbability(): number;
  setParameter(parameter: VadParameter, value: number): void;
  getParameter(parameter: VadParameter): number;
  getPredictionDelay(): number;
  updateBearerToken(token: string): void;
}

export interface VadInstance {
  initialize(
    sampleRate: number,
    blockSize: number,
    variableBlockSize?: boolean,
  ): void;
  process(buffer: Float32Array): void;
  getContext(): VadContext;
  terminateSession(): void;
}

interface VadConstructor {
  new (model: Model, licenseKey: string): VadInstance;
}

export const Model: ModelConstructor = NativeModel;
export const Processor: ProcessorConstructor = NativeProcessor;
export const Vad: VadConstructor = NativeVad;
export const setSdkId: (id: number) => void = nativeSetSdkId;
