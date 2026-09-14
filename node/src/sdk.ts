import {
  ProcessorParameter as NativeProcessorParameter,
  VadParameter as NativeVadParameter,
  _setSdkId as nativeSetSdkId,
} from "@ai-coustics/aic-sdk";

/**
 * Single import boundary for the ai-coustics SDK.
 *
 * aic-sdk ships its own TypeScript declarations, so the classes and result types are
 * re-exported unchanged. `ProcessorParameter` and `VadParameter` are declared as
 * `const enum`s, which TypeScript treats as compile-time-only even though napi-rs does
 * emit runtime objects for them. Each is therefore mirrored as a plain object the plugin
 * owns, so it can be re-exported as part of the public runtime API without depending on
 * declarations a bundler is free to erase.
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
