declare module "@ai-coustics/aic-sdk" {
  export class Model {
    static fromFile(path: string): Model;
    static download(modelId: string, downloadDir: string): string;
    getId(): string;
    getOptimalSampleRate(): number;
    getOptimalNumFrames(sampleRate: number): number;
  }

  export const ProcessorParameter: {
    readonly Bypass: number;
    readonly EnhancementLevel: number;
  };
  export type ProcessorParameter =
    (typeof ProcessorParameter)[keyof typeof ProcessorParameter];

  export class ProcessorContext {
    reset(): void;
    setParameter(parameter: ProcessorParameter, value: number): void;
    getParameter(parameter: ProcessorParameter): number;
    getOutputDelay(): number;
    updateBearerToken(token: string): void;
  }

  export class Processor {
    constructor(model: Model, licenseKey: string);
    initialize(
      sampleRate: number,
      numChannels: number,
      numFrames: number,
      allowVariableFrames?: boolean,
    ): void;
    processInterleaved(buffer: Float32Array): void;
    getProcessorContext(): ProcessorContext;
  }
}
