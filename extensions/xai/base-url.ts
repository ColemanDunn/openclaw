export const XAI_GROK_OAUTH_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

export function isXaiGrokProxyBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    return new URL(baseUrl).href.replace(/\/+$/u, "") === XAI_GROK_OAUTH_BASE_URL;
  } catch {
    return false;
  }
}
