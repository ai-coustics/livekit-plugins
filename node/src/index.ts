export {
  Analyzer,
  type AnalysisEvent,
  type AnalyzerCallbacks,
  type AnalyzerOptions,
  Collector,
} from "./analyzer.js";
export {
  type AnalysisResult,
  Model,
  ProcessorParameter,
} from "./sdk.js";
export { FrameProcessorChain } from "./frame_processor_chain.js";
export {
  float32ToPcm16,
  pcm16ToFloat32,
  Processor,
  type ProcessorOptions,
} from "./processor.js";
export { ProcessorContext } from "./processor_context.js";
export { VAD, type VADOptions, type VADParameters, VADProcessor } from "./vad.js";

process.emitWarning(
  "@ai-coustics/livekit-plugin is deprecated. Use @ai-coustics/livekit-extras for VAD and " +
    "Analyzer, and @livekit/plugins-ai-coustics for speech enhancement. Migration guide: " +
    "https://docs.ai-coustics.com/reference/livekit/migrate-to-livekit-extras",
  { type: "DeprecationWarning", code: "AIC_LIVEKIT_PLUGIN_DEPRECATED" },
);
