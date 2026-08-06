import { AudioFrame } from "@livekit/rtc-node";
import { describe, expect, it } from "vitest";

import { Processor } from "../src/index.js";

const describeIf = process.env.AIC_SDK_LICENSE ? describe : describe.skip;
const modelId =
  process.env.AIC_INTEGRATION_MODEL_ID ?? "quail-vf-2.2-s-16khz";
const sampleRate = 16000;
const samplesPerFrame = 800; // LiveKit Agents' current 50 ms default.

function frame(index: number, channels = 1): AudioFrame {
  const data = new Int16Array(samplesPerFrame * channels);
  for (let sample = 0; sample < samplesPerFrame; sample += 1) {
    const position = (index * samplesPerFrame + sample) / sampleRate;
    const voice = 0.3 * Math.sin(2 * Math.PI * 220 * position);
    const noise = 0.1 * Math.sin(2 * Math.PI * 997 * position);
    const value = Math.max(
      -32768,
      Math.min(32767, Math.round((voice + noise) * 32768)),
    );
    for (let channel = 0; channel < channels; channel += 1) {
      data[sample * channels + channel] = value;
    }
  }
  return new AudioFrame(data, sampleRate, channels, samplesPerFrame);
}

describeIf("native Processor integration", () => {
  it("processes 50 ms model-ID frames", () => {
    const enhancer = new Processor({ model: modelId });
    const outputs = Array.from({ length: 40 }, (_, index) =>
      enhancer.process(frame(index)),
    );

    expect(outputs.every((output) => output.samplesPerChannel === samplesPerFrame)).toBe(
      true,
    );
    expect(enhancer.outputDelay).toBeGreaterThan(0);
    const inputTail = Array.from({ length: 20 }, (_, offset) =>
      Array.from(frame(offset + 20).data),
    ).flat();
    const outputTail = outputs.slice(20).flatMap((output) => Array.from(output.data));
    expect(outputTail).not.toEqual(inputTail);
  }, 120_000);

  it("supports stereo and runtime bypass updates", () => {
    const enhancer = new Processor({
      model: modelId,
      modelParameters: { bypass: true },
    });
    const output = enhancer.process(frame(0, 2));
    enhancer.updateModelParameters({ bypass: false });

    expect(output.channels).toBe(2);
    expect(output.samplesPerChannel).toBe(samplesPerFrame);
  }, 120_000);
});
