import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import {
  createOpenAICompletionsTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "@openclaw/ai/transports";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XAI_GROK_OAUTH_BASE_URL } from "./base-url.js";
import { wrapXaiProviderStream } from "./stream.js";

type XaiApi = "openai-completions" | "openai-responses";
const initialHost = getAiTransportHost();
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };
const model: Model = {
  api: "openai-responses",
  provider: "xai",
  id: "grok-4.6",
  name: "Grok",
  baseUrl: "https://api.x.ai/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

afterEach(() => configureAiTransportHost(initialHost));

function successfulResponse(api: XaiApi, tier?: string): Response {
  const item = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "hello", annotations: [] }],
  };
  const events =
    api === "openai-completions"
      ? [
          {
            id: "chat_1",
            choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
          },
          {
            id: "chat_1",
            service_tier: tier,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ]
      : [
          { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
          {
            type: "response.content_part.added",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hello" },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              status: "completed",
              output: [item],
              service_tier: tier,
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ];
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function installTransport(responses: Response[]) {
  const payloads: Array<Record<string, unknown>> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("expected a JSON request body");
    }
    payloads.push(JSON.parse(init.body) as Record<string, unknown>);
    const response = responses.shift();
    if (!response) {
      throw new Error("unexpected additional request");
    }
    return response;
  });
  configureAiTransportHost({ buildModelFetch: () => fetch });
  return { fetch, payloads };
}

function wrapped(api: XaiApi, fastMode: boolean | (() => boolean) = true, streamFn?: StreamFn) {
  return wrapXaiProviderStream({
    provider: model.provider,
    modelId: model.id,
    streamFn:
      streamFn ??
      (api === "openai-responses"
        ? createOpenAIResponsesTransportStreamFn()
        : createOpenAICompletionsTransportStreamFn()),
    extraParams: { fastMode, tool_stream: false },
  })!;
}

function notices(message: AssistantMessage) {
  return message.diagnostics?.filter((entry) => entry.type === "provider_notice") ?? [];
}

function rejectedResponse(error: unknown = "Argument not supported: service_tier", status = 400) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("xAI priority request and recovery", () => {
  it.each([
    ["openai-responses", "https://api.x.ai/v1", "grok-4.6"],
    ["openai-completions", XAI_GROK_OAUTH_BASE_URL, "grok-future"],
  ] as const)(
    "requests priority without changing model or reasoning via %s",
    async (api, baseUrl, id) => {
      const { payloads } = installTransport([successfulResponse(api, "priority")]);
      const result = await (
        await wrapped(api)({ ...model, api, baseUrl, id }, context, {
          apiKey: "test-key",
          reasoning: "high",
        })
      ).result();
      expect(result.stopReason).toBe("stop");
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({ model: id, service_tier: "priority" });
      if (api === "openai-responses") {
        expect(payloads[0]?.reasoning).toMatchObject({ effort: "high" });
      }
      expect(notices(result)).toEqual([]);
    },
  );

  it.each(["openai-responses", "openai-completions"] as const)(
    "recovers one rejected default before output via %s for result and event consumers",
    async (api) => {
      const { payloads } = installTransport([
        rejectedResponse(),
        successfulResponse(api),
        rejectedResponse({ message: "Argument not supported: service_tier" }),
        successfulResponse(api),
      ]);
      const invoke = () => wrapped(api)({ ...model, api }, context, { apiKey: "test-key" });
      const resultOnly = await (await invoke()).result();
      const stream = await invoke();
      const events = [];
      for await (const event of stream) {
        events.push(event);
      }
      const result = await stream.result();
      expect(resultOnly.stopReason).toBe("stop");
      expect(result.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text", text: "hello" })]),
      );
      expect(payloads.map((payload) => payload.service_tier)).toEqual([
        "priority",
        undefined,
        "priority",
        undefined,
      ]);
      expect(events[0]?.type).toBe("start");
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "done", message: result });
      expect(notices(resultOnly)).toHaveLength(1);
      expect(notices(result)).toHaveLength(1);
      expect(notices(result)[0]?.details?.code).toBe("xai_priority_downgrade");
    },
  );

  it.each(["mutate", "replace"] as const)(
    "preserves explicit priority from a caller %s without retrying",
    async (mode) => {
      const { payloads } = installTransport([rejectedResponse()]);
      const result = await (
        await wrapped("openai-responses")(model, context, {
          apiKey: "test-key",
          onPayload: (payload) => {
            if (mode === "replace") {
              return { ...(payload as Record<string, unknown>), service_tier: "priority" };
            }
            (payload as Record<string, unknown>).service_tier = "priority";
            return undefined;
          },
        })
      ).result();
      expect(result.stopReason).toBe("error");
      expect(payloads.map((payload) => payload.service_tier)).toEqual(["priority"]);
      expect(notices(result)).toEqual([]);
    },
  );

  it.each([
    ["Argument not supported: temperature", 400],
    ["service_tier is unavailable", 400],
    ["Argument not supported: service_tier", 403],
  ] as const)("surfaces unrelated rejection %s (%s)", async (error, status) => {
    const { payloads } = installTransport([rejectedResponse(error, status)]);
    const result = await (
      await wrapped("openai-responses")(model, context, { apiKey: "test-key" })
    ).result();
    expect(result.stopReason).toBe("error");
    expect(payloads).toHaveLength(1);
    expect(notices(result)).toEqual([]);
  });

  it("does not retry again or claim standard processing if the recovery fails", async () => {
    const { payloads } = installTransport([rejectedResponse(), rejectedResponse()]);
    const result = await (
      await wrapped("openai-responses")(model, context, { apiKey: "test-key" })
    ).result();
    expect(result.stopReason).toBe("error");
    expect(payloads.map((payload) => payload.service_tier)).toEqual(["priority", undefined]);
    expect(notices(result)).toEqual([]);
  });

  it.each(["default", "priority", undefined, "unrecognized"])(
    "only reports an explicit default response tier: %s",
    async (tier) => {
      installTransport([successfulResponse("openai-responses", tier)]);
      const stream = await wrapped("openai-responses")(model, context, { apiKey: "test-key" });
      for await (const event of stream) {
        expect(event.type).not.toBe("error");
      }
      const result = await stream.result();
      expect(result.stopReason).toBe("stop");
      expect(notices(result)).toHaveLength(tier === "default" ? 1 : 0);
    },
  );

  it("honors changing fast mode and an explicit standard tier", async () => {
    const { payloads } = installTransport(
      Array.from({ length: 3 }, () => successfulResponse("openai-responses", "default")),
    );
    let enabled = true;
    const streamFn = wrapped("openai-responses", () => enabled);
    await (await streamFn(model, context, { apiKey: "test-key" })).result();
    enabled = false;
    const disabled = await (await streamFn(model, context, { apiKey: "test-key" })).result();
    enabled = true;
    const explicit = await (
      await streamFn(model, context, {
        apiKey: "test-key",
        onPayload: (payload) => ({
          ...(payload as Record<string, unknown>),
          service_tier: "default",
        }),
      })
    ).result();
    expect(payloads.map((payload) => payload.service_tier)).toEqual([
      "priority",
      undefined,
      "default",
    ]);
    expect(notices(disabled)).toEqual([]);
    expect(notices(explicit)).toEqual([]);
  });

  it.each(["started", "aborted"] as const)(
    "does not recover a %s generation",
    async (condition) => {
      const controller = new AbortController();
      const source = vi.fn<StreamFn>(async (requestModel, _context, options) => {
        await options?.onPayload?.({}, requestModel);
        const error: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: 1,
          usage: createZeroUsageFixture(),
          stopReason: "error",
          errorCode: "400",
          errorMessage: "400 Argument not supported: service_tier",
        };
        const stream = createAssistantMessageEventStream();
        if (condition === "started") {
          stream.push({ type: "start", partial: error });
        } else {
          controller.abort();
        }
        stream.push({ type: "error", reason: "error", error });
        return stream;
      });
      const result = await (
        await wrapped("openai-responses", true, source)(model, context, {
          signal: controller.signal,
        })
      ).result();
      expect(result.stopReason).toBe("error");
      expect(source).toHaveBeenCalledTimes(1);
      expect(notices(result)).toEqual([]);
    },
  );
});
