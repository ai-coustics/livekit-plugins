import { AudioFrame, FrameProcessor } from "@livekit/rtc-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logging = vi.hoisted(() => {
  const calls: Array<{ fields: Record<string, unknown>; message: string }> = [];
  return {
    calls,
    logger: {
      info: (fields: Record<string, unknown>, message: string) =>
        calls.push({ fields, message }),
    },
  };
});

const sdk = vi.hoisted(() => {
  class FakeCollector {
    initializations: Array<[number, number, boolean]> = [];
    blocks: number[][] = [];

    initialize(sampleRate: number, blockSize: number, variable: boolean): void {
      this.initializations.push([sampleRate, blockSize, variable]);
    }

    buffer(samples: Float32Array): void {
      this.blocks.push(Array.from(samples));
    }
  }

  class FakeAnalyzer {
    analyzeCalls = 0;
    resetCalls = 0;
    terminateCalls = 0;

    analyzeBuffered() {
      this.analyzeCalls += 1;
      return {
        riskScore: 0.1,
        speakerReverb: 0.2,
        speakerLoudness: 0.3,
        interferingSpeech: 0.4,
        mediaSpeech: 0.5,
        noise: 0.6,
        packetLoss: 0.7,
      };
    }

    reset(): void {
      this.resetCalls += 1;
    }

    terminateSession(): void {
      this.terminateCalls += 1;
    }

    updateBearerToken(): void {}
  }

  const collectors: FakeCollector[] = [];
  const analyzers: FakeAnalyzer[] = [];
  const sdkIds: number[] = [];
  return { FakeCollector, FakeAnalyzer, collectors, analyzers, sdkIds };
});

vi.mock("@ai-coustics/aic-sdk", () => ({
  Model: class {},
  Processor: class {},
  ProcessorParameter: { Bypass: 0, EnhancementLevel: 1 },
  Vad: class {},
  VadParameter: {
    SpeechHoldDuration: 2,
    Sensitivity: 3,
    MinimumSpeechDuration: 4,
  },
  analyzerPair: () => {
    const collector = new sdk.FakeCollector();
    const analyzer = new sdk.FakeAnalyzer();
    sdk.collectors.push(collector);
    sdk.analyzers.push(analyzer);
    return { collector, analyzer };
  },
  _setSdkId: (id: number) => sdk.sdkIds.push(id),
}));

vi.mock("@livekit/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@livekit/agents")>();
  return { ...actual, log: () => logging.logger };
});

import { Analyzer, Collector } from "../src/index.js";

function makeFrame(channels = 1): AudioFrame {
  const mono = [32767, -32768, 16384, -16384];
  const data = Int16Array.from(
    channels === 1 ? mono : mono.flatMap((sample) => Array(channels).fill(sample)),
  );
  return new AudioFrame(data, 16000, channels, 4);
}

describe("Analyzer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    logging.calls.length = 0;
    sdk.collectors.length = 0;
    sdk.analyzers.length = 0;
    sdk.sdkIds.length = 0;
  });

  afterEach(() => vi.useRealTimers());

  it("exposes a transparent FrameProcessor collector that downmixes audio", () => {
    const analyzer = new Analyzer({
      model: {} as never,
      licenseKey: "test-license",
      analysisInterval: 60,
    });

    expect(analyzer.collector).toBeInstanceOf(Collector);
    expect(analyzer.collector).toBeInstanceOf(FrameProcessor);
    expect(sdk.sdkIds).toEqual([9]);

    const frame = makeFrame(2);
    expect(analyzer.collector.process(frame)).toBe(frame);
    expect(sdk.collectors[0]!.initializations).toEqual([[16000, 4, false]]);
    expect(sdk.collectors[0]!.blocks[0]).toEqual([
      32767 / 32768,
      -1,
      0.5,
      -0.5,
    ]);

    analyzer.collector.onStreamInfoCleared();
    expect(sdk.analyzers[0]!.resetCalls).toBe(1);
    analyzer.close();
    expect(sdk.analyzers[0]!.terminateCalls).toBe(1);
  });

  it("analyzes on the configured interval and logs the result", () => {
    const analyzer = new Analyzer({
      model: {} as never,
      licenseKey: "test-license",
      analysisInterval: 0.01,
    });
    analyzer.collector.process(makeFrame());

    vi.advanceTimersByTime(10);

    expect(sdk.analyzers[0]!.analyzeCalls).toBe(1);
    expect(logging.calls).toEqual([
      {
        message: "ai-coustics analysis result",
        fields: {
          modelProvider: "ai-coustics",
          riskScore: 0.1,
          speakerReverb: 0.2,
          speakerLoudness: 0.3,
          interferingSpeech: 0.4,
          mediaSpeech: 0.5,
          noise: 0.6,
          packetLoss: 0.7,
        },
      },
    ]);
    analyzer.close();
  });

  it("stops the analyzer when RoomIO closes its collector", () => {
    const analyzer = new Analyzer({
      model: {} as never,
      licenseKey: "test-license",
      analysisInterval: 1,
    });

    analyzer.collector.close();
    vi.advanceTimersByTime(1000);

    expect(analyzer.collector.isEnabled()).toBe(false);
    expect(sdk.analyzers[0]!.terminateCalls).toBe(1);
    expect(sdk.analyzers[0]!.analyzeCalls).toBe(0);
  });

  it("defaults to analyzing every five seconds", () => {
    const analyzer = new Analyzer({
      model: {} as never,
      licenseKey: "test-license",
    });
    analyzer.collector.process(makeFrame());

    vi.advanceTimersByTime(4999);
    expect(sdk.analyzers[0]!.analyzeCalls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(sdk.analyzers[0]!.analyzeCalls).toBe(1);

    analyzer.close();
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects invalid interval %s",
    (analysisInterval) => {
      expect(
        () =>
          new Analyzer({
            model: {} as never,
            licenseKey: "test-license",
            analysisInterval,
          }),
      ).toThrow(/analysisInterval/);
    },
  );
});
