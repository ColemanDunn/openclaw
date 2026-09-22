import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { buildPayloads } from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads provider notices", () => {
  it("delivers one provider status notice separately from the successful assistant reply", () => {
    const notice = "Priority was unavailable; this reply used standard processing.";
    const payloads = buildPayloads({
      assistantTexts: ["Done."],
      providerNotices: [notice, notice],
      assistantMessageIndex: 3,
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "answer-3",
    });

    expect(payloads).toHaveLength(2);
    const answer = expectDefined(payloads[0], "Expected the assistant reply");
    const status = expectDefined(payloads[1], "Expected the provider status notice");
    expect(answer.text).toBe("Done.");
    expect(getReplyPayloadMetadata(answer)).toMatchObject({
      assistantMessageIndex: 3,
      assistantTranscriptOwned: true,
    });
    expect(status).toEqual({ text: notice, isStatusNotice: true });
    expect(getReplyPayloadMetadata(status)?.assistantTranscriptOwned).toBeUndefined();
    expect(getReplyPayloadMetadata(status)?.assistantMessageIndex).toBeUndefined();
    expect(getReplyPayloadMetadata(status)?.assistantTranscriptIdempotencyKey).toBeUndefined();
  });

  it.each([
    { name: "silent", overrides: { assistantTexts: ["NO_REPLY"] } },
    { name: "empty", overrides: { assistantTexts: [] } },
    { name: "cron", overrides: { isCronTrigger: true } },
    { name: "heartbeat", overrides: { isHeartbeatTrigger: true } },
    { name: "aborted", overrides: { runAborted: true } },
    { name: "failed", overrides: { lastAssistant: makeAssistantMessageFixture() } },
    ...["NO_REPLY", ""].map((finalText) => ({
      name: finalText ? "silent after a prior answer" : "empty after a prior answer",
      overrides: {
        assistantTexts: ["Earlier answer.", finalText],
        answerSegments: [
          {
            textEnd: 1,
            messageEnd: 1,
            finalMessageStart: 1,
            lastAssistant: makeAgentAssistantMessage({
              content: [{ type: "text" as const, text: "Earlier answer." }],
            }),
          },
        ],
      },
    })),
    {
      name: "source-suppressed",
      overrides: {
        sourceReplyDeliveryMode: "message_tool_only" as const,
        didSendViaMessagingTool: true,
        didDeliverSourceReplyViaMessageTool: true,
      },
    },
  ])("does not turn a $name turn into a provider notification", ({ overrides }) => {
    const notice = "Priority was unavailable; this reply used standard processing.";
    const payloads = buildPayloads({
      assistantTexts: ["Done."],
      providerNotices: [notice],
      ...overrides,
    });

    expect(payloads.some((payload) => payload.isStatusNotice || payload.text === notice)).toBe(
      false,
    );
  });
});
