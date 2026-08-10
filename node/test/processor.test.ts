import { AudioFrame } from "@livekit/rtc-node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logging = vi.hoisted(() => {
  const calls: Array<{
    level: "debug" | "info" | "warn" | "error";
    payload: Record<string, unknown>;
    message: string;
  }> = [];
  const write = (level: "debug" | "info" | "warn" | "error") =>
    (payload: Record<string, unknown>, message: string) =>
      calls.push({ level, payload, message });
  return {
    calls,
    logger: {
      debug: write("debug"),
      info: write("info"),
      warn: write("warn"),
      error: write("error"),
    },
  };
});

const sdk = vi.hoisted(() => {
  const instances: FakeProcessor[] = [];
  const nativeCalls: Array<[string, number?]> = [];

  class FakeContext {
    parameters: Array<[number, number]> = [];
    parameterErrors = new Map<number, Error>();
    updateBearerTokenError: Error | null = null;
    resetCount = 0;
    bearerTokens: string[] = [];

    setParameter(parameter: number, value: number): void {
      const error = this.parameterErrors.get(parameter);
      if (error) throw error;
      this.parameters.push([parameter, value]);
    }

    getAudioDelay(): number {
      return 42;
    }

    getParameter(parameter: number): number {
      for (let index = this.parameters.length - 1; index >= 0; index -= 1) {
        const entry = this.parameters[index]!;
        if (entry[0] === parameter) return entry[1];
      }
      throw new Error("parameter has not been set");
    }

    updateBearerToken(token: string): void {
      if (this.updateBearerTokenError) throw this.updateBearerTokenError;
      this.bearerTokens.push(token);
    }

    reset(): void {
      this.resetCount += 1;
    }
  }

  class FakeModel {
    static fromFileCalls: string[] = [];
    static downloadCalls: Array<[string, string]> = [];

    constructor(
      readonly sampleRate = 16000,
      readonly blockSize = 2,
    ) {}

    getId(): string {
      return "test-model";
    }

    getOptimalSampleRate(): number {
      return this.sampleRate;
    }

    getOptimalBlockSize(): number {
      return this.blockSize;
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
    getContextCalls = 0;
    readonly initializations: Array<[number, number, boolean]> = [];
    readonly blocks: number[][] = [];
    error: Error | null = null;
    terminateCalls = 0;

    constructor() {
      if (FakeProcessor.constructorError) {
        throw FakeProcessor.constructorError;
      }
      instances.push(this);
      nativeCalls.push(["processor"]);
    }

    getContext(): FakeContext {
      this.getContextCalls += 1;
      return this.context;
    }

    initialize(...config: [number, number, boolean]): void {
      this.initializations.push(config);
    }

    process(block: Float32Array): void {
      if (this.error) throw this.error;
      this.blocks.push(Array.from(block));
    }

    terminateSession(): void {
      this.terminateCalls += 1;
    }
  }

  return { FakeModel, FakeProcessor, instances, nativeCalls };
});

vi.mock("@ai-coustics/aic-sdk", () => ({
  Model: sdk.FakeModel,
  Processor: sdk.FakeProcessor,
  ProcessorParameter: { Bypass: 0, EnhancementLevel: 1 },
  Vad: class {},
  VadParameter: {
    SpeechHoldDuration: 2,
    Sensitivity: 3,
    MinimumSpeechDuration: 4,
  },
  _setSdkId: (id: number) => sdk.nativeCalls.push(["sdk_id", id]),
}));

vi.mock("@livekit/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@livekit/agents")>();
  return { ...actual, log: () => logging.logger };
});

import {
  Model,
  Processor,
  ProcessorParameter,
  float32ToPcm16,
  pcm16ToFloat32,
} from "../src/index.js";

describe("Processor", () => {
  beforeEach(() => {
    sdk.instances.length = 0;
    sdk.FakeModel.fromFileCalls.length = 0;
    sdk.FakeModel.downloadCalls.length = 0;
    sdk.FakeProcessor.constructorError = null;
    sdk.nativeCalls.length = 0;
    logging.calls.length = 0;
  });

  it("constructs without a probe frame and processes one complete LiveKit frame", () => {
    const enhancer = new Processor({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });
    enhancer.getContext().setParameter(ProcessorParameter.EnhancementLevel, 0.75);
    const processor = sdk.instances[0]!;
    expect(processor.initializations).toEqual([]);
    expect(processor.blocks).toEqual([]);
    expect(processor.context.resetCount).toBe(0);
    expect(sdk.nativeCalls.slice(0, 2)).toEqual([
      ["sdk_id", 9],
      ["processor"],
    ]);

    const input = new Int16Array([1000, -1000, 2000, -2000, 3000, -3000]);
    const userdata = { source: "test" };
    const output = enhancer.process(new AudioFrame(input, 48000, 2, 3, userdata));

    expect(Array.from(output.data)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(output.userdata).toBe(userdata);
    expect(processor.initializations.at(-1)).toEqual([48000, 3, false]);
    expect(processor.blocks.at(-1)).toEqual([0, 0, 0]);
    expect(processor.context.parameters.filter(([key]) => key === 1)).toEqual([
      [1, 0.75],
    ]);
  });

  it("gets a logging ProcessorContext and rejects a closed Processor", () => {
    const enhancer = new Processor({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });
    const processor = sdk.instances[0]!;

    expect(enhancer.getContext()).not.toBe(processor.context);
    expect(processor.getContextCalls).toBe(2); // internal context plus public request

    enhancer.close();
    expect(() => enhancer.getContext()).toThrow("closed ai-coustics Processor");
  });

  it("delegates context operations and logs rejected parameters", () => {
    const enhancer = new Processor({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });
    const nativeContext = sdk.instances[0]!.context;
    const context = enhancer.getContext();

    context.setParameter(ProcessorParameter.EnhancementLevel, 0.7);
    expect(context.getParameter(ProcessorParameter.EnhancementLevel)).toBe(0.7);
    expect(context.getAudioDelay()).toBe(42);
    context.reset();
    context.updateBearerToken("new-token");

    expect(nativeContext.resetCount).toBe(1);
    expect(nativeContext.bearerTokens).toEqual(["new-token"]);

    nativeContext.parameterErrors.set(1, new Error("out of range"));
    context.setParameter(ProcessorParameter.EnhancementLevel, 1.1);

    expect(
      logging.calls.find(
        ({ level, message }) =>
          level === "warn" && message.includes("Processor: parameter rejected"),
      )?.payload,
    ).toMatchObject({
      parameter: ProcessorParameter.EnhancementLevel,
      parameterValue: 1.1,
      errorMessage: "out of range",
    });
  });

  it("does not log context getter calls", () => {
    const enhancer = new Processor({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });
    const context = enhancer.getContext();
    context.setParameter(ProcessorParameter.EnhancementLevel, 0.7);
    logging.calls.length = 0;

    expect(context.getParameter(ProcessorParameter.EnhancementLevel)).toBe(0.7);
    expect(context.getAudioDelay()).toBe(42);

    expect(logging.calls).toEqual([]);
  });

  it("logs and rethrows bearer token update failures", () => {
    const enhancer = new Processor({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });
    const nativeContext = sdk.instances[0]!.context;
    const context = enhancer.getContext();
    nativeContext.updateBearerTokenError = new Error("token update failed");

    expect(() => context.updateBearerToken("new-token")).toThrow(
      "token update failed",
    );
    expect(
      logging.calls.find(({ message }) =>
        message.includes("bearer token update failed"),
      )?.payload,
    ).toMatchObject({
      contextOperation: "updateBearerToken",
      errorMessage: "token update failed",
    });
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
      [16000, 800, false],
      [16000, 160, false],
      [48000, 2400, false],
    ]);
  });

  it("warns about rejected Processor parameters without reapplying them", () => {
    const enhancer = new Processor({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });
    const context = enhancer.getContext();
    context.setParameter(ProcessorParameter.Bypass, 1);
    const processor = sdk.instances[0]!;
    enhancer.process(new AudioFrame(new Int16Array(800), 16000, 1, 800));
    context.setParameter(ProcessorParameter.EnhancementLevel, 0.9);
    enhancer.process(new AudioFrame(new Int16Array(160), 16000, 1, 160));

    expect(processor.context.parameters.filter(([key]) => key === 0)).toHaveLength(1);
    expect(processor.context.parameters.filter(([key]) => key === 1)).toEqual([
      [1, 0.9],
    ]);
    processor.context.parameterErrors.set(1, new Error("enhancement level out of range"));
    context.setParameter(ProcessorParameter.EnhancementLevel, 1.1);
    context.setParameter(ProcessorParameter.Bypass, 0);

    expect(processor.context.parameters).not.toContainEqual([1, 1.1]);
    expect(processor.context.parameters).toContainEqual([0, 0]);
    expect(
      logging.calls.find(
        ({ level, message }) =>
          level === "warn" && message.includes("Processor: parameter rejected"),
      )?.payload,
    ).toMatchObject({
      parameter: ProcessorParameter.EnhancementLevel,
      parameterValue: 1.1,
    });
  });

  it("allows later updates when the SDK rejects one parameter", () => {
    const enhancer = new Processor({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });
    const nativeContext = sdk.instances[0]!.context;
    nativeContext.parameterErrors.set(1, new Error("SDK rejected parameter"));
    const context = enhancer.getContext();

    context.setParameter(ProcessorParameter.EnhancementLevel, 0.8);
    context.setParameter(ProcessorParameter.Bypass, 1);

    expect(nativeContext.parameters).not.toContainEqual([1, 0.8]);
    expect(nativeContext.parameters).toContainEqual([0, 1]);
    expect(
      logging.calls.find(({ message }) => message.includes("Processor: parameter rejected"))
        ?.payload,
    ).toMatchObject({
      parameter: ProcessorParameter.EnhancementLevel,
      errorMessage: "SDK rejected parameter",
    });
  });

  it("delegates parameter validation to the SDK", () => {
    const enhancer = new Processor({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });

    enhancer.getContext().setParameter(ProcessorParameter.EnhancementLevel, 1.1);

    expect(sdk.instances[0]!.context.parameters).toContainEqual([1, 1.1]);
  });

  it("passes through while disabled and resets immediately when re-enabled", () => {
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
    expect(processor.context.resetCount).toBe(1);
    enhancer.process(frame);
  });

  it("rate-limits structured processing errors and reports recovery", () => {
    const enhancer = new Processor({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });
    const processor = sdk.instances[0]!;
    processor.error = new Error("boom");
    const frame = new AudioFrame(new Int16Array(800), 16000, 1, 800);

    expect(enhancer.process(frame)).toBe(frame);
    expect(enhancer.process(frame)).toBe(frame);
    const failures = logging.calls.filter(
      ({ level, message }) =>
        level === "error" && message.includes("failed; passing audio through"),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload).toMatchObject({
      modelProvider: "ai-coustics",
      modelName: "test-model",
      processingStage: "process",
      errorType: "Error",
      errorMessage: "boom",
      consecutiveFailures: 1,
      failedFrameCount: 1,
      error: processor.error,
    });

    processor.error = null;
    enhancer.process(frame);
    const recovery = logging.calls.find(({ message }) =>
      message.includes("Processor: recovered"),
    );
    expect(recovery?.payload).toMatchObject({
      recoveredFailureCount: 2,
      failedFrameCount: 2,
      lastFailureStage: "process",
      lastErrorType: "Error",
      lastErrorMessage: "boom",
    });

    enhancer.close();
    expect(processor.terminateCalls).toBe(1);
    expect(enhancer.process(frame)).toBe(frame);
    const summary = logging.calls.find(
      ({ message }) => message === "Processor: closed",
    );
    expect(summary?.payload).toMatchObject({
      frameCount: 3,
      processedFrameCount: 1,
      failedFrameCount: 2,
      initializationCount: 1,
      audioDelaySamples: 42,
      audioDelayMs: 2.625,
    });
  });

  it("adds stream context to logs and resets between publications", () => {
    const enhancer = new Processor({
      model: new sdk.FakeModel(),
      licenseKey: "test-license",
    });
    const processor = sdk.instances[0]!;
    enhancer.onStreamInfoUpdated({
      roomName: "diagnostic-room",
      participantIdentity: "caller",
      publicationSid: "TR_first",
    });
    enhancer.process(new AudioFrame(new Int16Array(800), 16000, 1, 800));

    const initialized = logging.calls.find(
      ({ message }) => message === "Processor: initialized",
    );
    expect(initialized?.payload).toMatchObject({
      plugin: "ai-coustics",
      component: "processor",
      roomName: "diagnostic-room",
      participantIdentity: "caller",
      publicationSid: "TR_first",
      audioDelaySamples: 42,
      audioDelayMs: 2.625,
    });

    enhancer.onStreamInfoUpdated({
      roomName: "diagnostic-room",
      participantIdentity: "caller",
      publicationSid: "TR_second",
    });
    enhancer.onStreamInfoCleared();
    expect(processor.context.resetCount).toBe(2);
  });

  it("warns immediately for cumulative processing backlog", () => {
    const clock = [0, 0, 0, 0, 310, 310];
    const now = vi
      .spyOn(performance, "now")
      .mockImplementation(() => clock.shift()!);
    const enhancer = new Processor({
      model: new sdk.FakeModel(100, 10),
      licenseKey: "test-license",
    });

    enhancer.process(new AudioFrame(new Int16Array(10), 100, 1, 10));

    const warning = logging.calls.find(({ message }) =>
      message.includes("falling behind realtime"),
    );
    expect(warning?.payload).toMatchObject({
      processingDurationMs: 310,
      sdkProcessingDurationMs: 310,
      frameDurationMs: 100,
      realtimeFactor: 3.1,
      processingBacklogMs: 210,
    });
    now.mockRestore();
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
