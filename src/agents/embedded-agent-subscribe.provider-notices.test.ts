import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { makeZeroUsageSnapshot } from "./usage.js";

describe("subscribeEmbeddedAgentSession provider notices", () => {
  it.each(["message_end", "turn_end"] as const)(
    "collects one provider notice from %s without leaking it into a new turn",
    async (eventType) => {
      const notice = "Priority was unavailable; this reply used standard processing.";
      const diagnostic = {
        type: "provider_notice",
        timestamp: 1,
        details: { code: "priority_unavailable", text: notice },
      };
      const first = createSubscribedSessionHarness({ runId: "notice-first" });
      const next = createSubscribedSessionHarness({ runId: "notice-next" });
      const message: AssistantMessage = {
        role: "assistant",
        api: "openai-responses",
        provider: "test-provider",
        model: "test-model",
        content: [{ type: "text", text: "Done." }],
        stopReason: "stop",
        timestamp: 1,
        usage: makeZeroUsageSnapshot(),
      };
      try {
        first.emit({ type: "message_end", message });
        first.emit({
          type: "message_end",
          message: {
            ...message,
            diagnostics: [{ ...diagnostic, type: "provider_service_tier" }],
          },
        });
        first.emit({
          type: "message_end",
          message: {
            ...message,
            provider: "openclaw",
            model: "delivery-mirror",
            diagnostics: [diagnostic],
          },
        });
        expect(first.subscription.getProviderNotices()).toEqual([]);

        first.emit({
          type: eventType,
          toolResults: [],
          message: {
            ...message,
            stopReason: "toolUse",
            content: [
              {
                type: "text",
                text: "Checking the result.",
                textSignature: JSON.stringify({ v: 1, id: "checking", phase: "commentary" }),
              },
              { type: "toolCall", id: "read-1", name: "read", arguments: {} },
            ],
            diagnostics: [diagnostic],
          },
        });
        expect(first.subscription.getProviderNotices()).toEqual([notice]);
        first.emit({
          type: "compaction_end",
          reason: "overflow",
          outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: true },
        });
        first.emit({ type: "message_end", message: { ...message, diagnostics: [diagnostic] } });
        await first.subscription.waitForPendingEvents();

        expect(first.subscription.getProviderNotices()).toEqual([notice]);
        expect(first.subscription.assistantTexts).not.toContain(notice);
        expect(next.subscription.getProviderNotices()).toEqual([]);
      } finally {
        first.subscription.unsubscribe();
        next.subscription.unsubscribe();
      }
    },
  );
});
