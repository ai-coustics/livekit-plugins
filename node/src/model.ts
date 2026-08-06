import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Model } from "./sdk.js";

export type ModelInput = Model | string;

export const DEFAULT_DOWNLOAD_DIR = path.join(
  os.homedir(),
  ".cache",
  "aic-sdk",
  "models",
);

function isModelPath(value: string): boolean {
  return (
    value.endsWith(".aicmodel") ||
    path.isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\")
  );
}

export function downloadModel(
  modelId: string,
  downloadDir = DEFAULT_DOWNLOAD_DIR,
): string {
  const target = path.resolve(downloadDir);
  fs.mkdirSync(target, { recursive: true });
  return Model.download(modelId, target);
}

export function loadModel(
  model: ModelInput,
  downloadDir = DEFAULT_DOWNLOAD_DIR,
): Model {
  if (typeof model !== "string") {
    return model;
  }
  if (isModelPath(model)) {
    return Model.fromFile(path.resolve(model));
  }
  return Model.fromFile(downloadModel(model, downloadDir));
}
