import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function isPriorityParameterRejection(message: AssistantMessage): boolean {
  // The SDK renders xAI's string and object error bodies differently. Only the
  // known pre-generation 400 rejection permits removing our optional default.
  return (
    message.errorCode === "400" &&
    (message.errorMessage === "400 Argument not supported: service_tier" ||
      message.errorMessage === '400 "Argument not supported: service_tier"')
  );
}

export function streamXaiPriority(
  underlying: StreamFn,
  model: Parameters<StreamFn>[0],
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
): ReturnType<StreamFn> {
  let injectedPriority = false;
  let requestedPriority = false;
  let retriedWithoutPriority = false;
  const start = (enablePriority: boolean) =>
    underlying(model, context, {
      ...options,
      onPayload: async (payload, requestModel) => {
        const replacement = await options?.onPayload?.(payload, requestModel);
        const request = asOptionalRecord(replacement === undefined ? payload : replacement);
        injectedPriority = enablePriority && request != null && request.service_tier === undefined;
        if (injectedPriority && request) {
          request.service_tier = "priority";
        }
        requestedPriority = request?.service_tier === "priority";
        return replacement;
      },
    });

  const initial = start(true);
  const selected = (async () => {
    let stream = await initial;
    let iterator = stream[Symbol.asyncIterator]();
    let first = await iterator.next();
    if (
      !first.done &&
      first.value.type === "error" &&
      first.value.reason === "error" &&
      first.value.error.stopReason === "error" &&
      injectedPriority &&
      !options?.signal?.aborted &&
      isPriorityParameterRejection(first.value.error)
    ) {
      await iterator.return?.();
      if (!options?.signal?.aborted) {
        stream = await start(false);
        iterator = stream[Symbol.asyncIterator]();
        first = await iterator.next();
        retriedWithoutPriority = !requestedPriority;
      }
    }
    return { stream, iterator, first };
  })();

  const noteDowngrade = (message: AssistantMessage) => {
    const confirmedDefault = message.diagnostics?.some(
      (entry) => entry.type === "provider_service_tier" && entry.details?.serviceTier === "default",
    );
    const confirmedPriority = message.diagnostics?.some(
      (entry) =>
        entry.type === "provider_service_tier" && entry.details?.serviceTier === "priority",
    );
    if (
      message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      ((retriedWithoutPriority && !confirmedPriority) || (requestedPriority && confirmedDefault)) &&
      !message.diagnostics?.some((entry) => entry.details?.code === "xai_priority_downgrade")
    ) {
      (message.diagnostics ??= []).push({
        type: "provider_notice",
        timestamp: Date.now(),
        details: {
          code: "xai_priority_downgrade",
          text: "Priority wasn’t granted; xAI used standard processing for part of this turn.",
        },
      });
    }
    return message;
  };

  // Select the first event once for both consumers. An error after start or any
  // partial output belongs to that generation and must never issue a second one.
  return {
    result: async () => noteDowngrade(await (await selected).stream.result()),
    async *[Symbol.asyncIterator]() {
      const { iterator, first } = await selected;
      let next = first;
      try {
        while (!next.done) {
          if (next.value.type === "done") {
            noteDowngrade(next.value.message);
          }
          yield next.value;
          next = await iterator.next();
        }
      } finally {
        await iterator.return?.();
      }
    },
  };
}
