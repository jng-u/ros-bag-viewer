import {
  defineTrustedExtension,
  defineTrustedLifecycle,
  type TrustedExtensionDefinition,
  type TrustedResourceHandle,
} from "@ros-web-viewer/extension-api";

export interface RangeSummaryConfig {
  readonly maxSamples: number;
}

export interface RangeSummaryMessage {
  readonly ranges: readonly number[];
}

export const rangeSummaryExtension: TrustedExtensionDefinition<RangeSummaryConfig, RangeSummaryMessage> =
  defineTrustedExtension<RangeSummaryConfig, RangeSummaryMessage>(
    "range-summary",
    (context) => {
      let maxSamples = 0;
      let summary: TrustedResourceHandle | undefined;
      let disposed = false;
      return defineTrustedLifecycle<RangeSummaryConfig, RangeSummaryMessage>(
        (config) => {
          if (!Number.isSafeInteger(config.maxSamples) || config.maxSamples <= 0 || config.maxSamples > 16_384) {
            throw new Error("maxSamples must be between 1 and 16384");
          }
          maxSamples = config.maxSamples;
        },
        () => {
          summary?.dispose();
          summary = undefined;
        },
        (message) => {
          const finite = message.value.ranges.slice(0, maxSamples).filter(Number.isFinite);
          summary?.dispose();
          summary = context.allocateResource("text-buffer", Math.max(1, finite.length * 8));
          context.emitDiagnostic(
            "info",
            "RANGE_SUMMARY",
            `topic=${message.topic}; samples=${finite.length}; epoch=${message.sourceEpoch}`,
          );
        },
        () => {
          if (summary === undefined || summary.disposed) throw new Error("range summary is not ready");
        },
        () => {},
        () => {},
        () => {
          if (disposed) return;
          disposed = true;
          summary?.dispose();
          summary = undefined;
        },
      );
    },
    "bounded-resources",
    "diagnostics",
    "source-messages",
  );
