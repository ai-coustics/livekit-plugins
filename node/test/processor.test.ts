import { AudioFrame } from "@livekit/rtc-node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const instances: FakeProcessor[] = [];

  class FakeContext {
    parameters: Array<[number, number]> = [];
    resetCount = 0;

    setParameter(parameter: number, value: number): void {
      this.parameters.push([parameter, value]);
    }

    getOutputDelay(): number {
      return 42;
    }

    reset(): void {
      this.resetCount += 1;
    }
  }

  class FakeModel {
    static fromFileCalls: string[] = [];
    static downloadCalls: Array<[string, string]> = [];

    getId(): string {
      return "test-model";
    }

    getOptimalSampleRate(): number {
      return 16000;
    }

    getOptimalNumFrames(): number {
      return 2;
    }

    static fromFile(modelPath: string): FakeModel {
      this.fromFileCalls.push(modelPath);
      return new FakeModel();
    }

    static download(modelId: string, downloadDir: string): string {
      this.downloadCalls.push([modelId, downloadDir]);
      return `${downloadDir}/${modelId}.aicmodel`;
    }
  }

  class FakeProcessor {
    static constructorError: Error | null = null;
    readonly context = new FakeContext();
    readonly initializations: Array<[number, number, number, boolean]> = [];
    readonly blocks: number[][] = [];
    error: Error | null = null;

    constructor() {
      if (FakeProcessor.constructorError) {
        throw FakeProcessor.constructorError;
      }
      instances.push(this);
    }

    getProcessorContext(): FakeContext {
      return this.context;
    }

    initialize(...config: [number, number, number, boolean]): void {
      this.initializations.push(config);
    }

    processInterleaved(block: Float32Array): void {
      if (this.error) throw this.error;
      this.blocks.push(Array.from(block));
    }
  }

  return { FakeModel, FakeProcessor, instances };
});

vi.mock("@ai-coustics/aic-sdk", () => ({
  Model: sdk.FakeModel,
  OtelConfig: class {},
  Processor: sdk.FakeProcessor,
  ProcessorParameter: { Bypass: 0, EnhancementLevel: 1 },
}));

import {
  Model,
  Processor,
  float32ToPcm16,
  pcm16ToFloat32,
} from "../src/index.js";

describe("Processor", () => {
  beforeEach(() => {
    sdk.instances.length = 0;
    sdk.FakeModel.fromFileCalls.length = 0;
    sdk.FakeModel.downloadCalls.length = 0;
    sdk.FakeProcessor.constructorError = null;
  });

  it("constructs without a probe frame and processes one complete LiveKit frame", () => {
    const enhancer = new Processor({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
      processorParameters: { enhancementLevel: 0.75 },
    });
    const processor = sdk.instances[0]!;
    expect(processor.initializations).toEqual([]);
    expect(processor.blocks).toEqual([]);
    expect(processor.context.resetCount).toBe(0);

    const input = new Int16Array([1000, -1000, 2000, -2000, 3000, -3000]);
    const userdata = { source: "test" };
    const output = enhancer.process(new AudioFrame(input, 48000, 2, 3, userdata));

    expect(Array.from(output.data)).toEqual(Array.from(input));
    expect(output.userdata).toBe(userdata);
    expect(processor.initializations.at(-1)).toEqual([48000, 2, 3, false]);
    expect(processor.blocks.at(-1)!.length).toBe(6);
    expect(processor.context.parameters.filter(([key]) => key === 1)).toEqual([
      [1, 0.75],
    ]);
    expect(enhancer.outputDelay).toBe(42);
  });

  it("wraps Processor construction errors", () => {
    const sdkError = new Error("invalid license format");
    sdk.FakeProcessor.constructorError = sdkError;

    try {
      new Processor({
        model: new sdk.FakeModel(),
        licenseKey: "bad-license",
      });
      throw new Error("expected construction to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Failed to create ai-coustics Processor",
      );
      expect((error as Error & { cause?: unknown }).cause).toBe(sdkError);
    }
  });

  it("reinitializes when any frame geometry changes", () => {
    const enhancer = new Processor({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });
    const processor = sdk.instances[0]!;
    enhancer.process(new AudioFrame(new Int16Array(800), 16000, 1, 800));
    enhancer.process(new AudioFrame(new Int16Array(800), 16000, 1, 800));
    enhancer.process(new AudioFrame(new Int16Array(160), 16000, 1, 160));
    enhancer.process(new AudioFrame(new Int16Array(2400), 48000, 1, 2400));

    expect(processor.initializations).toEqual([
      [16000, 1, 800, false],
      [16000, 1, 160, false],
      [48000, 1, 2400, false],
    ]);
  });

  it("validates Processor parameters without reapplying them", () => {
    const enhancer = new Processor({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
      processorParameters: { bypass: true },
    });
    const processor = sdk.instances[0]!;
    enhancer.process(new AudioFrame(new Int16Array(800), 16000, 1, 800));
    enhancer.setParameters({ enhancementLevel: 0.9 });
    enhancer.process(new AudioFrame(new Int16Array(160), 16000, 1, 160));

    expect(processor.context.parameters.filter(([key]) => key === 0)).toHaveLength(1);
    expect(processor.context.parameters.filter(([key]) => key === 1)).toEqual([
      [1, 0.9],
    ]);
    expect(() => enhancer.setParameters({ enhancementLevel: 1.1 })).toThrow(
      "enhancementLevel",
    );
  });

  it("passes through while disabled and resets when re-enabled", () => {
    const enhancer = new Processor({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });
    const processor = sdk.instances[0]!;
    const frame = new AudioFrame(new Int16Array(800), 16000, 1, 800);
    enhancer.process(frame);
    const before = processor.blocks.length;

    enhancer.setEnabled(false);
    expect(enhancer.process(frame)).toBe(frame);
    expect(processor.blocks).toHaveLength(before);
    enhancer.setEnabled(true);
    enhancer.process(frame);
    expect(processor.context.resetCount).toBe(1);
  });

  it("deduplicates processing errors and releases on close", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const enhancer = new Processor({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });
    const processor = sdk.instances[0]!;
    processor.error = new Error("boom");
    const frame = new AudioFrame(new Int16Array(800), 16000, 1, 800);

    expect(enhancer.process(frame)).toBe(frame);
    expect(enhancer.process(frame)).toBe(frame);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    enhancer.close();
    expect(() => enhancer.processorContext).toThrow("closed");
    errorSpy.mockRestore();
  });

  it("exposes SDK model download and file loading", () => {
    const modelPath = Model.download(
      "quail-vf-2.2-l-16khz",
      "/tmp/aic-test-models",
    );
    const model = Model.fromFile(modelPath);

    expect(model).toBeInstanceOf(sdk.FakeModel);
    expect(sdk.FakeModel.downloadCalls).toEqual([
      ["quail-vf-2.2-l-16khz", "/tmp/aic-test-models"],
    ]);
    expect(sdk.FakeModel.fromFileCalls.at(-1)).toBe(
      "/tmp/aic-test-models/quail-vf-2.2-l-16khz.aicmodel",
    );
  });
});

describe("PCM conversion", () => {
  it("round-trips signed 16-bit endpoints", () => {
    const pcm = new Int16Array([-32768, -1, 0, 1, 32767]);
    expect(float32ToPcm16(pcm16ToFloat32(pcm))).toEqual(pcm);
  });
});
