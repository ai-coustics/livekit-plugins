declare module "@ai-coustics/aic-sdk" {
  export class Model {
    static fromFile(path: string): Model;
    static download(modelId: string, downloadDir: string): string;
    getId(): string;
    getOptimalSampleRate(): number;
    getOptimalBlockSize(sampleRate: number): number;
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

  /** Internal integration hook exported by the SDK for official wrappers. */
  export function _setSdkId(id: number): void;
}
