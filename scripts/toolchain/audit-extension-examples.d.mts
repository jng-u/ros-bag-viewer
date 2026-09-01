export interface AuditSourceProbeResult { filename: string; ok: boolean; error: string }
export function auditSourceBatch(probes: Array<{ source: string; filename?: string }>): AuditSourceProbeResult[];
