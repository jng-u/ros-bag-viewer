import {
  ReferenceCountedPayloadLease,
  type ChannelId,
  type NormalizedMessageEnvelope,
  type SourceEpoch,
  type SourceId,
} from "@ros-web-viewer/core-model";

import type { BrowserSample } from "./browser-runtime.js";
import type { TopicSummary } from "./shell.js";

/** Normalizes every recorded/live browser sample at the UI boundary before decoding. */
export function normalizeBrowserSample(
  sample: BrowserSample,
  topic: TopicSummary,
  epochValue: number,
  sourceLabel: string,
  tfQueryTimeNanos?: bigint,
): NormalizedMessageEnvelope {
  if (!Number.isSafeInteger(epochValue) || epochValue < 0) throw new Error("browser source epoch is invalid");
  const epoch = epochValue as SourceEpoch;
  return {
    version: 1,
    sourceId: (sourceLabel || "browser-source") as SourceId,
    channelId: topic.id as ChannelId,
    sourceSequence: sample.sourceSequence ?? sample.logTimeNanos,
    epoch,
    schedulingTime: { valueNanos: sample.logTimeNanos, source: "record", epoch },
    ...(tfQueryTimeNanos === undefined ? {} : { tfQueryTime: { valueNanos: tfQueryTimeNanos, source: "header" as const, epoch } }),
    schema: {
      capability: sample.channel.schema.capability,
      typeName: sample.channel.schema.name,
      provenance: [{ providerId: "browser-source", providerVersion: "1" }],
    },
    payload: new ReferenceCountedPayloadLease(epoch, sample.data.byteLength, sample.data),
    nativeTypeMetadata: Object.freeze({
      topicName: topic.name,
      messageEncoding: sample.channel.messageEncoding,
      ...(sample.channel.schema.encoding ? { schemaEncoding: sample.channel.schema.encoding } : {}),
    }),
    diagnostics: Object.freeze([]),
  };
}
