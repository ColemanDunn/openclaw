import { normalizeProviderId } from "openclaw/plugin-sdk/model-ref-parse";

const XAI_PROVIDER_IDS = new Set(["xai", "x-ai"]);

// Provider dispatch preserves the selected alias. Keep all xAI-owned runtime policy symmetric.
export function isXaiProviderId(provider: unknown): boolean {
  return typeof provider === "string" && XAI_PROVIDER_IDS.has(normalizeProviderId(provider));
}

export const XAI_GROK_OAUTH_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

export function isXaiBaseUrl(baseUrl: string | undefined, expectedBaseUrl: string): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    return new URL(baseUrl).href.replace(/\/+$/u, "") === expectedBaseUrl;
  } catch {
    return false;
  }
}
