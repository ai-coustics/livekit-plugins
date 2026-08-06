import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  Model,
  type OtelConfig,
  Processor,
  type ProcessorContext,
  type ProcessorParameter,
} from "./sdk.js";

export type ModelInput = Model | string;

export const DEFAULT_DOWNLOAD_DIR = path.join(
  os.homedir(),
  ".cache",
  "aic-sdk",
  "models",
);

function isModelPath(value: string): boolean {
  return (
    value.endsWith(".aicmodel") ||
    path.isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\")
  );
}

export function downloadModel(
  modelId: string,
  downloadDir = DEFAULT_DOWNLOAD_DIR,
): string {
  const target = path.resolve(downloadDir);
  fs.mkdirSync(target, { recursive: true });
  return Model.download(modelId, target);
}

export function loadModel(
  model: ModelInput,
  downloadDir = DEFAULT_DOWNLOAD_DIR,
): Model {
  if (typeof model !== "string") {
    return model;
  }
  if (isModelPath(model)) {
    return Model.fromFile(path.resolve(model));
  }
  return Model.fromFile(downloadModel(model, downloadDir));
}

/** Small, testable wrapper around one SDK Processor and its context. */
export class EnhancerCore {
  private readonly model: Model;
  private readonly processor: InstanceType<typeof Processor>;
  readonly context: ProcessorContext;

  constructor(model: Model, licenseKey: string, otelConfig?: OtelConfig) {
    this.model = model;
    this.processor = new Processor(model, licenseKey, otelConfig);
    this.context = this.processor.getProcessorContext();
  }

  /** Force model authorization before a LiveKit call begins. */
  validateLicense(): void {
    const sampleRate = this.model.getOptimalSampleRate();
    const numFrames = this.model.getOptimalNumFrames(sampleRate);
    this.processor.initialize(sampleRate, 1, numFrames, false);
    this.processor.processInterleaved(new Float32Array(numFrames));
    this.context.reset();
  }

  initialize(sampleRate: number, channels: number, frames: number): void {
    this.processor.initialize(sampleRate, channels, frames, false);
  }

  processInterleaved(buffer: Float32Array): void {
    this.processor.processInterleaved(buffer);
  }

  setParameter(parameter: ProcessorParameter, value: number): void {
    this.context.setParameter(parameter, value);
  }

  reset(): void {
    this.context.reset();
  }

  get outputDelay(): number {
    return this.context.getOutputDelay();
  }
}

