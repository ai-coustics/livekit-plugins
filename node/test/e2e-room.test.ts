import { initializeLogger, voice } from "@livekit/agents";
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  TrackPublishOptions,
  TrackSource,
  dispose,
} from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";

import { Model, Processor } from "../src/index.js";

const describeIf = process.env.AIC_SDK_LICENSE ? describe : describe.skip;
const livekitUrl = process.env.LIVEKIT_URL ?? "ws://127.0.0.1:7880";
const livekitApiKey = process.env.LIVEKIT_API_KEY ?? "devkey";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET ?? "secret";
const modelId = process.env.AIC_INTEGRATION_MODEL_ID ?? "quail-vf-2.2-s-16khz";
const modelDir =
  process.env.AIC_INTEGRATION_MODEL_DIR ??
  path.join(os.homedir(), ".cache", "aic-sdk", "models");

const inputSampleRate = 16_000;
const publishSampleRate = 48_000;
const publishFrameMs = 20;
const licenseGracePeriodMs = 10_000;

initializeLogger({ pretty: false, level: "error" });

type FrameFormat = {
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
};

class ObservedProcessor extends Processor {
  readonly createdAt = Date.now();
  calls = 0;
  successTimes: number[] = [];
  formats: FrameFormat[] = [];
  closed = false;

  override process(frame: AudioFrame): AudioFrame {
    this.calls += 1;
    this.formats.push({
      sampleRate: frame.sampleRate,
      channels: frame.channels,
      samplesPerChannel: frame.samplesPerChannel,
    });
    const output = super.process(frame);
    // Processor returns the original frame when it catches an SDK error and fails open.
    if (output !== frame) {
      this.successTimes.push(Date.now());
    }
    return output;
  }

  override close(): void {
    this.closed = true;
    super.close();
  }
}

async function token({
  identity,
  roomName,
  agentParticipant = false,
}: {
  identity: string;
  roomName: string;
  agentParticipant?: boolean;
}): Promise<string> {
  const accessToken = new AccessToken(livekitApiKey, livekitApiSecret, {
    identity,
    ttl: "10m",
  });
  accessToken.addGrant({
    room: roomName,
    roomJoin: true,
    roomCreate: true,
    canPublish: true,
    canSubscribe: true,
    agent: agentParticipant,
  });
  if (agentParticipant) {
    accessToken.kind = "agent";
  }
  return await accessToken.toJwt();
}

async function connectRoom({
  identity,
  roomName,
  agentParticipant = false,
}: {
  identity: string;
  roomName: string;
  agentParticipant?: boolean;
}): Promise<Room> {
  const room = new Room();
  await room.connect(
    livekitUrl,
    await token({ identity, roomName, agentParticipant }),
    { autoSubscribe: true, dynacast: false },
  );
  return room;
}

async function publishTestSignal(source: AudioSource, until: number): Promise<void> {
  const samplesPerFrame = (publishSampleRate * publishFrameMs) / 1000;
  let frameIndex = 0;
  let nextTick = Date.now();

  while (Date.now() < until) {
    const data = new Int16Array(samplesPerFrame);
    for (let sample = 0; sample < samplesPerFrame; sample += 1) {
      const position = (frameIndex * samplesPerFrame + sample) / publishSampleRate;
      const signal = 0.28 * Math.sin(2 * Math.PI * 220 * position);
      const noise = 0.1 * Math.sin(2 * Math.PI * 997 * position);
      data[sample] = Math.max(
        -32768,
        Math.min(32767, Math.round((signal + noise) * 32768)),
      );
    }
    await source.captureFrame(
      new AudioFrame(data, publishSampleRate, 1, samplesPerFrame),
    );

    frameIndex += 1;
    nextTick += publishFrameMs;
    const wait = nextTick - Date.now();
    if (wait > 0) {
      await delay(wait);
    } else {
      nextTick = Date.now();
    }
  }
}

afterAll(async () => {
  await dispose();
});

describeIf("Processor in a real AgentSession room", () => {
  it(
    "processes microphone audio after the license grace period and closes with RoomIO",
    async () => {
      fs.mkdirSync(modelDir, { recursive: true });
      const model = Model.fromFile(Model.download(modelId, modelDir));
      const processor = new ObservedProcessor({ model });
      const roomName = `ai-coustics-e2e-${randomUUID()}`;
      let agentRoom: Room | undefined;
      let publisherRoom: Room | undefined;
      let source: AudioSource | undefined;
      let session: voice.AgentSession | undefined;
      let sessionStarted = false;

      try {
        agentRoom = await connectRoom({
          identity: "agent",
          roomName,
          agentParticipant: true,
        });
        publisherRoom = await connectRoom({ identity: "publisher", roomName });

        session = new voice.AgentSession({
          vad: null,
          turnHandling: { turnDetection: "manual" },
          userAwayTimeout: null,
        });
        await session.start({
          agent: new voice.Agent({ instructions: "E2E audio probe" }),
          room: agentRoom,
          record: false,
          inputOptions: {
            audioSampleRate: inputSampleRate,
            audioNumChannels: 1,
            participantIdentity: "publisher",
            noiseCancellation: processor,
            textEnabled: false,
            videoEnabled: false,
          },
          outputOptions: {
            audioEnabled: false,
            transcriptionEnabled: false,
          },
        });
        sessionStarted = true;

        source = new AudioSource(publishSampleRate, 1);
        const track = LocalAudioTrack.createAudioTrack("e2e-microphone", source);
        const publishOptions = new TrackPublishOptions();
        publishOptions.source = TrackSource.SOURCE_MICROPHONE;
        await publisherRoom.localParticipant!.publishTrack(track, publishOptions);

        // Continue beyond the SDK's authentication grace period, while guaranteeing at least
        // three seconds of actual room audio if room setup itself took unusually long.
        const streamUntil = Math.max(Date.now() + 3_000, processor.createdAt + 12_000);
        await publishTestSignal(source, streamUntil);

        expect(processor.calls).toBeGreaterThanOrEqual(20);
        expect(processor.formats.length).toBe(processor.calls);
        expect(
          processor.formats.every(
            ({ sampleRate, channels, samplesPerChannel }) =>
              sampleRate === inputSampleRate && channels === 1 && samplesPerChannel > 0,
          ),
        ).toBe(true);
        expect(processor.successTimes.length).toBeGreaterThan(0);
        expect(
          processor.successTimes.some(
            (processedAt) => processedAt >= processor.createdAt + licenseGracePeriodMs,
          ),
        ).toBe(true);
      } finally {
        if (sessionStarted) {
          await session!.close();
        } else {
          processor.close();
        }
        await source?.close();
        await publisherRoom?.disconnect();
        await agentRoom?.disconnect();
      }

      expect(processor.closed).toBe(true);
    },
    45_000,
  );
});
