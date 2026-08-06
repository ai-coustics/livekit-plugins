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
    getId(): string {
      return "test-model";
    }

    getOptimalSampleRate(): number {
      return 16000;
    }

    getOptimalNumFrames(): number {
      return 2;
    }

    static fromFile(): FakeModel {
      return new FakeModel();
    }
  }

  class FakeProcessor {
    readonly context = new FakeContext();
    readonly initializations: Array<[number, number, number, boolean]> = [];
    readonly blocks: number[][] = [];

    constructor() {
      instances.push(this);
    }

    getProcessorContext(): FakeContext {
      return this.context;
    }

    initialize(...config: [number, number, number, boolean]): void {
      this.initializations.push(config);
    }

    processInterleaved(block: Float32Array): void {
      this.blocks.push(Array.from(block));
    }
  }

  return { FakeContext, FakeModel, FakeProcessor, instances };
});

vi.mock("@ai-coustics/aic-sdk", () => ({
  Model: sdk.FakeModel,
  OtelConfig: class {},
  Processor: sdk.FakeProcessor,
  ProcessorParameter: { Bypass: 0, EnhancementLevel: 1 },
}));

import {
  AudioEnhancement,
  float32ToPcm16,
  pcm16ToFloat32,
} from "../src/processor.js";

describe("AudioEnhancement", () => {
  beforeEach(() => {
    sdk.instances.length = 0;
  });

  it("processes interleaved frames in optimal-sized blocks", () => {
    const model = new sdk.FakeModel();
    const enhancer = new AudioEnhancement({
      model,
      licenseKey: "test-license",
      enhancementLevel: 0.75,
    });
    const input = new Int16Array([1000, -1000, 2000, -2000, 3000, -3000]);
    const userdata = { source: "test" };
    const frame = new AudioFrame(input, 48000, 2, 3, userdata);

    const output = enhancer.process(frame);
    const processor = sdk.instances[0]!;

    expect(Array.from(output.data)).toEqual(Array.from(input));
    expect(output.userdata).toBe(userdata);
    expect(processor.initializations).toEqual([[48000, 2, 2, true]]);
    expect(processor.blocks.map((block) => block.length)).toEqual([4, 2]);
    expect(processor.context.parameters).toEqual([[1, 0.75]]);
    expect(enhancer.outputDelay).toBe(42);
  });

  it("reinitializes only when the stream format changes", () => {
    const enhancer = new AudioEnhancement({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });
    const processor = sdk.instances[0]!;

    enhancer.process(new AudioFrame(new Int16Array(4), 16000, 1, 4));
    enhancer.process(new AudioFrame(new Int16Array(3), 16000, 1, 3));
    enhancer.process(new AudioFrame(new Int16Array(3), 48000, 1, 3));

    expect(processor.initializations).toEqual([
      [16000, 1, 2, true],
      [48000, 1, 2, true],
    ]);
  });

  it("passes frames through while disabled", () => {
    const enhancer = new AudioEnhancement({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });
    const frame = new AudioFrame(new Int16Array(1), 16000, 1, 1);
    enhancer.setEnabled(false);

    expect(enhancer.process(frame)).toBe(frame);
    expect(sdk.instances[0]!.blocks).toEqual([]);
  });

  it("resets and releases the processor on close", () => {
    const enhancer = new AudioEnhancement({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });
    const processor = sdk.instances[0]!;
    enhancer.process(new AudioFrame(new Int16Array(1), 16000, 1, 1));

    enhancer.close();

    expect(processor.context.resetCount).toBe(1);
    expect(() => enhancer.processorContext).toThrow("closed");
  });
});

describe("PCM conversion", () => {
  it("round-trips signed 16-bit endpoints", () => {
    const pcm = new Int16Array([-32768, -1, 0, 1, 32767]);
    expect(float32ToPcm16(pcm16ToFloat32(pcm))).toEqual(pcm);
  });
});
