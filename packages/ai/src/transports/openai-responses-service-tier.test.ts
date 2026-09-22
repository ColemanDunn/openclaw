import { describe, expect, it } from "vitest";
import { createResponsesAssistantOutput } from "../providers/openai-responses-shared.js";
import type { Model } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  processResponsesStream,
  type OpenAIResponsesStreamEvent,
} from "./openai-responses-stream-internal.js";

const nativeOpenAIModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

async function* responseEvents(events: Array<Record<string, unknown>>) {
  for (const event of events) {
    yield event as OpenAIResponsesStreamEvent;
  }
}

describe("Responses service-tier facts", () => {
  it.each(["default", "priority", undefined, null, "untrusted-value"])(
    "retains returned service-tier facts independently of the requested tier: %s",
    async (serviceTier) => {
      const output = createResponsesAssistantOutput(nativeOpenAIModel);
      await processResponsesStream(
        responseEvents([
          {
            type: "response.completed",
            response: {
              id: "resp_service_tier",
              status: "completed",
              service_tier: serviceTier,
              output: [],
            },
          },
        ]),
        output,
        new AssistantMessageEventStream(),
        nativeOpenAIModel,
        { serviceTier: "priority" },
      );
      expect(output.stopReason).toBe("stop");
      expect(
        output.diagnostics?.filter((entry) => entry.type === "provider_service_tier") ?? [],
      ).toEqual(
        serviceTier === "default" || serviceTier === "priority"
          ? [
              {
                type: "provider_service_tier",
                timestamp: expect.any(Number),
                details: { serviceTier },
              },
            ]
          : [],
      );
    },
  );
});
