import {
  ProcessorParameter as NativeProcessorParameter,
  VadParameter as NativeVadParameter,
  _setSdkId as nativeSetSdkId,
} from "@ai-coustics/aic-sdk";

/**
 * Single import boundary for the ai-coustics SDK.
 *
 * aic-sdk ships its own TypeScript declarations, so the classes and result types are
 * re-exported unchanged. `ProcessorParameter` and `VadParameter` are `const enum`s and
 * therefore exist at compile time only; each is mirrored as a plain object so the plugin
 * can re-export it as part of its public runtime API.
 */
export {
  Analyzer,
  Model,
  Processor,
  Vad,
  type AnalysisResult,
  type ProcessorContext,
  type VadContext,
} from "@ai-coustics/aic-sdk";

export const ProcessorParameter = {
  Bypass: NativeProcessorParameter.Bypass,
  EnhancementLevel: NativeProcessorParameter.EnhancementLevel,
} as const;
export type ProcessorParameter =
  (typeof ProcessorParameter)[keyof typeof ProcessorParameter];

export const VadParameter = {
  SpeechHoldDuration: NativeVadParameter.SpeechHoldDuration,
  Sensitivity: NativeVadParameter.Sensitivity,
  MinimumSpeechDuration: NativeVadParameter.MinimumSpeechDuration,
} as const;
export type VadParameter = (typeof VadParameter)[keyof typeof VadParameter];

export const setSdkId: (id: number) => void = nativeSetSdkId;
