import {
  type ProcessorContext as AicProcessorContext,
  type ProcessorParameter,
} from "./sdk.js";

type ProcessorContextLogger = (
  level: "debug" | "warn",
  message: string,
  fields: Record<string, unknown>,
  error?: unknown,
) => void;

/** Logging wrapper around an ai-coustics SDK ProcessorContext. */
export class ProcessorContext {
  constructor(
    private readonly context: AicProcessorContext,
    private readonly writeLog: ProcessorContextLogger,
  ) {}

  reset(): void {
    this.context.reset();
    this.writeLog("debug", "ai-coustics Processor reset", {});
  }

  setParameter(parameter: ProcessorParameter, value: number): void {
    try {
      this.context.setParameter(parameter, value);
    } catch (error) {
      this.writeLog(
        "warn",
        "ai-coustics Processor parameter rejected; keeping the current value",
        {
          contextOperation: "setParameter",
          parameter,
          parameterValue: value,
          errorType: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        error,
      );
      return;
    }
    this.writeLog(
      "debug",
      "ai-coustics Processor parameter updated",
      { parameter, parameterValue: value },
    );
  }

  getParameter(parameter: ProcessorParameter): number {
    return this.context.getParameter(parameter);
  }

  getAudioDelay(): number {
    return this.context.getAudioDelay();
  }

  updateBearerToken(token: string): void {
    try {
      this.context.updateBearerToken(token);
    } catch (error) {
      this.writeLog(
        "warn",
        "ai-coustics Processor bearer token update failed; keeping the current token",
        {
          contextOperation: "updateBearerToken",
          errorType: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        error,
      );
      throw error;
    }
    this.writeLog("debug", "ai-coustics Processor bearer token updated", {});
  }
}
