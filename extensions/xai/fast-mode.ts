import { isXaiGrokProxyBaseUrl } from "./base-url.js";
import { XAI_BASE_URL } from "./model-definitions.js";
import { isXaiProviderId } from "./provider-id.js";

const XAI_FAST_MODEL_IDS = new Map<string, string>([
  ["grok-3", "grok-3-fast"],
  ["grok-3-mini", "grok-3-mini-fast"],
  ["grok-4", "grok-4-fast"],
  ["grok-4-0709", "grok-4-fast"],
]);

export function resolveXaiFastModelId(model: {
  id: string;
  provider: string;
  api?: string;
}): string | undefined {
  return (model.api === "openai-completions" || model.api === "openai-responses") &&
    isXaiProviderId(model.provider)
    ? XAI_FAST_MODEL_IDS.get(model.id.trim())
    : undefined;
}

export function supportsXaiPriorityProcessing(model: {
  provider: string;
  api?: string;
  baseUrl?: string;
}): boolean {
  return (
    isXaiProviderId(model.provider) &&
    (model.api === "openai-completions" || model.api === "openai-responses") &&
    (model.baseUrl?.trim().replace(/\/+$/u, "") === XAI_BASE_URL ||
      isXaiGrokProxyBaseUrl(model.baseUrl))
  );
}
