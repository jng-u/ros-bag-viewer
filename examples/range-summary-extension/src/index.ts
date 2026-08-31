import {
  TRUSTED_EXTENSION_API_VERSION,
  type TrustedExtensionDefinition,
  type TrustedResourceHandle,
} from "@ros-web-viewer/extension-api";

export interface RangeSummaryConfig {
  readonly maxSamples: number;
}

export interface RangeSummaryMessage {
  readonly ranges: readonly number[];
}

export const rangeSummaryExtension = Object.freeze({
    apiVersion: TRUSTED_EXTENSION_API_VERSION,
    id: "range-summary",
    requiredCapabilities: Object.freeze(["bounded-resources", "diagnostics", "source-messages"] as const),
    create(context) {
      let maxSamples = 0;
      let summary: TrustedResourceHandle | undefined;
      let disposed = false;
      return {
        configure(config) {
          if (!Number.isSafeInteger(config.maxSamples) || config.maxSamples <= 0 || config.maxSamples > 16_384) {
            throw new Error("maxSamples must be between 1 and 16384");
          }
          maxSamples = config.maxSamples;
        },
        attachSource() {
          summary?.dispose();
          summary = undefined;
        },
        update(message) {
          const finite = message.value.ranges.slice(0, maxSamples).filter(Number.isFinite);
          summary?.dispose();
          summary = context.allocateResource("text-buffer", Math.max(1, finite.length * 8));
          context.emitDiagnostic(
            "info",
            "RANGE_SUMMARY",
            `topic=${message.topic}; samples=${finite.length}; epoch=${message.sourceEpoch}`,
          );
        },
        render() {
          if (summary === undefined || summary.disposed) throw new Error("range summary is not ready");
        },
        suspend() {},
        handleError() {},
        dispose() {
          if (disposed) return;
          disposed = true;
          summary?.dispose();
          summary = undefined;
        },
      };
    },
  } satisfies TrustedExtensionDefinition<RangeSummaryConfig, RangeSummaryMessage>);
