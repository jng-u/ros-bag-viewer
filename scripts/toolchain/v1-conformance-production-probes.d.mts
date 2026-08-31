export interface V1ConformanceProductionProbe {
  readonly caseId: string;
  readonly evidence: string;
  readonly testName: string;
}

export const V1_CONFORMANCE_PRODUCTION_PROBES: readonly V1ConformanceProductionProbe[];
export const V1_CONFORMANCE_DETERMINISTIC_REPORTER: string;
export function v1ConformanceProductionProbe(caseId: string): V1ConformanceProductionProbe;
export function v1ConformanceProductionCommand(caseId: string, receiptPath?: string): {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};
