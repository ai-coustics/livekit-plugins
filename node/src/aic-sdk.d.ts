declare module "@ai-coustics/aic-sdk" {
  export class Model {
    static fromFile(path: string): Model;
    static download(modelId: string, downloadDir: string): string;
    getId(): string;
    getOptimalSampleRate(): number;
    getOptimalBlockSize(sampleRate: number): number;
  }

  export interface AnalysisResult {
    riskScore: number;
    speakerReverb: number;
    speakerLoudness: number;
    interferingSpeech: number;
    mediaSpeech: number;
    noise: number;
    packetLoss: number;
  }

  export class Collector {
    initialize(
      sampleRate: number,
      blockSize: number,
      variableBlockSize?: boolean,
    ): void;
    buffer(samples: Float32Array): void;
  }

  export class Analyzer {
    reset(): void;
    analyzeBuffered(): AnalysisResult;
    terminateSession(): void;
    updateBearerToken(token: string): void;
  }

  export function analyzerPair(
    model: Model,
    licenseKey: string,
  ): { collector: Collector; analyzer: Analyzer };

  export const ProcessorParameter: {
    readonly Bypass: number;
    readonly EnhancementLevel: number;
  };
  export type ProcessorParameter =
    (typeof ProcessorParameter)[keyof typeof ProcessorParameter];

  export const VadParameter: {
    readonly SpeechHoldDuration: number;
    readonly Sensitivity: number;
    readonly MinimumSpeechDuration: number;
  };
  export type VadParameter = (typeof VadParameter)[keyof typeof VadParameter];

  export class ProcessorContext {
    reset(): void;
    setParameter(parameter: ProcessorParameter, value: number): void;
    getParameter(parameter: ProcessorParameter): number;
    getAudioDelay(): number;
    updateBearerToken(token: string): void;
  }

  export class Processor {
    constructor(model: Model, licenseKey: string);
    initialize(
      sampleRate: number,
      blockSize: number,
      variableBlockSize?: boolean,
    ): void;
    process(buffer: Float32Array): void;
    getContext(): ProcessorContext;
    terminateSession(): void;
  }

  export class VadContext {
    reset(): void;
    isSpeechDetected(): boolean;
    rawVadProbability(): number;
    setParameter(parameter: VadParameter, value: number): void;
    getParameter(parameter: VadParameter): number;
    getPredictionDelay(): number;
    updateBearerToken(token: string): void;
  }

  export class Vad {
    constructor(model: Model, licenseKey: string);
    initialize(
      sampleRate: number,
      blockSize: number,
      variableBlockSize?: boolean,
    ): void;
    process(buffer: Float32Array): void;
    getContext(): VadContext;
    terminateSession(): void;
  }

  /** Internal integration hook exported by the SDK for official wrappers. */
  export function _setSdkId(id: number): void;
}
