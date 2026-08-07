import { VADEventType, initializeLogger } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";

import { Model, Processor, VAD } from "../src/index.js";

initializeLogger({ pretty: false, level: "silent" });

const describeIf = process.env.AIC_SDK_LICENSE ? describe : describe.skip;
const modelId =
  process.env.AIC_INTEGRATION_MODEL_ID ?? "quail-vf-2.2-s-16khz";
const vadModelId =
  process.env.AIC_INTEGRATION_VAD_MODEL_ID ?? "vad-2.1-xxs-16khz";
const modelDir =
  process.env.AIC_INTEGRATION_MODEL_DIR ??
  path.join(os.homedir(), ".cache", "aic-sdk", "models");
const sampleRate = 16000;
const samplesPerFrame = 800; // LiveKit Agents' current 50 ms default.

function decodeBase85(input: string): Buffer {
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
  const padding = (5 - (input.length % 5)) % 5;
  const padded = input + "~".repeat(padding);
  const decoded = Buffer.alloc((padded.length / 5) * 4);

  for (let source = 0, target = 0; source < padded.length; source += 5, target += 4) {
    let value = 0;
    for (let index = source; index < source + 5; index += 1) {
      const digit = alphabet.indexOf(padded[index]!);
      if (digit < 0) throw new Error("Invalid Base85 fixture");
      value = value * 85 + digit;
    }
    decoded.writeUInt32BE(value, target);
  }
  return decoded.subarray(0, decoded.length - padding);
}

function recordedSpeechFixture(): Int16Array {
  const fixturePath = path.resolve(
    process.cwd(),
    "../python/tests/data/yes_speech_i8.b85",
  );
  const encoded = fs.readFileSync(fixturePath, "utf8").trim();
  const quantized = inflateSync(decodeBase85(encoded));
  return Int16Array.from(
    new Int8Array(quantized.buffer, quantized.byteOffset, quantized.byteLength),
    (sample) => sample * 256,
  );
}

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
  let model: ReturnType<typeof Model.fromFile>;

  beforeAll(() => {
    fs.mkdirSync(modelDir, { recursive: true });
    model = Model.fromFile(Model.download(modelId, modelDir));
  });

  it("processes 50 ms frames with a downloaded model", () => {
    const enhancer = new Processor({ model });
    const outputs = Array.from({ length: 40 }, (_, index) =>
      enhancer.process(frame(index)),
    );

    expect(outputs.every((output) => output.samplesPerChannel === samplesPerFrame)).toBe(
      true,
    );
    const inputTail = Array.from({ length: 20 }, (_, offset) =>
      Array.from(frame(offset + 20).data),
    ).flat();
    const outputTail = outputs.slice(20).flatMap((output) => Array.from(output.data));
    expect(outputTail).not.toEqual(inputTail);
    enhancer.close();
  }, 120_000);

  it("supports stereo and runtime bypass updates", () => {
    const enhancer = new Processor({
      model,
      processorParameters: { bypass: true },
    });
    const output = enhancer.process(frame(0, 2));
    enhancer.setParameters({ bypass: false });

    expect(output.channels).toBe(2);
    expect(output.samplesPerChannel).toBe(samplesPerFrame);
    for (let sample = 0; sample < output.samplesPerChannel; sample += 1) {
      expect(output.data[sample * 2]).toBe(output.data[sample * 2 + 1]);
    }
    enhancer.close();
  }, 120_000);
});

describeIf("native VAD integration", () => {
  let model: ReturnType<typeof Model.fromFile>;

  beforeAll(() => {
    fs.mkdirSync(modelDir, { recursive: true });
    model = Model.fromFile(Model.download(vadModelId, modelDir));
  });

  it("runs the SDK at the LiveKit input rate without plugin resampling", async () => {
    const detector = new VAD({
      model,
      vadParameters: { sensitivity: 0.5 },
    });
    const stream = detector.stream();
    const inputSampleRate = 48_000;
    const inputSamplesPerFrame = inputSampleRate / 20;

    for (let index = 0; index < 10; index += 1) {
      stream.pushFrame(
        new AudioFrame(
          new Int16Array(inputSamplesPerFrame),
          inputSampleRate,
          1,
          inputSamplesPerFrame,
        ),
      );
    }
    stream.endInput();
    const events = [];
    for await (const event of stream) events.push(event);
    const inferenceEvents = events.filter(
      (event) => event.type === VADEventType.INFERENCE_DONE,
    );

    expect(inferenceEvents.length).toBeGreaterThan(0);
    expect(
      inferenceEvents.every(
        (event) =>
          event.probability >= 0 &&
          event.probability <= 1 &&
          event.frames[0]?.sampleRate === inputSampleRate &&
          event.frames[0]?.channels === 1,
      ),
    ).toBe(true);
  }, 120_000);

  it("detects and buffers recorded speech", async () => {
    const detector = new VAD({
      model,
      vadParameters: {
        sensitivity: 0.5,
        speechHoldDuration: 0.1,
        minimumSpeechDuration: 0,
      },
      prefixPaddingDuration: 100,
    });
    const stream = detector.stream();
    const speech = recordedSpeechFixture();
    const audio = new Int16Array(sampleRate / 2 + speech.length + sampleRate);
    audio.set(speech, sampleRate / 2);

    for (let start = 0; start < audio.length; start += samplesPerFrame) {
      const block = audio.slice(start, start + samplesPerFrame);
      stream.pushFrame(new AudioFrame(block, sampleRate, 1, block.length));
    }
    stream.endInput();
    const events = [];
    for await (const event of stream) events.push(event);
    const starts = events.filter(
      (event) => event.type === VADEventType.START_OF_SPEECH,
    );
    const ends = events.filter((event) => event.type === VADEventType.END_OF_SPEECH);

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0]!.speechDuration).toBeGreaterThan(0);
    expect(ends[0]!.silenceDuration).toBeGreaterThanOrEqual(100);
    expect(starts[0]!.frames).toHaveLength(1);
    expect(ends[0]!.frames).toHaveLength(1);
    expect(ends[0]!.frames[0]!.sampleRate).toBe(sampleRate);

    const buffered = ends[0]!.frames[0]!.data;
    const bufferedBytes = Buffer.from(
      buffered.buffer,
      buffered.byteOffset,
      buffered.byteLength,
    );
    const speechBytes = Buffer.from(speech.buffer, speech.byteOffset, speech.byteLength);
    expect(bufferedBytes.indexOf(speechBytes)).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
