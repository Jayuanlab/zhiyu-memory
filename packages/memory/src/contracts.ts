export const PROTOCOL = "general-memory.v1-draft" as const;
export type Namespace = { tenantId: string; projectId: string };
export type RecordRef = Namespace & { kind: "observation"; id: string };
export type VersionRef = { record: RecordRef; scheme: string; value: string };
export type SourceRef = {
  sourceId: string;
  externalId: string;
  version?: string;
};
export type Observation = {
  namespace: Namespace;
  id: string;
  source: SourceRef;
  observedAt: string;
  ingestedAt: string;
  content: string;
  contentHash: string;
  provenance: { kind: string; trustLevel: string };
  extensions: Record<string, unknown>;
};
export type AppendCommand = {
  protocolVersion: typeof PROTOCOL;
  kind: "observation.append";
  commandId: string;
  payload: {
    source: SourceRef;
    observedAt: string;
    content: string;
    extensions?: Record<string, unknown>;
  };
};
export type Range = { start: number; end: number; unit: "unicode_code_points" };
export type Query =
  | { purpose: "current"; ref: RecordRef }
  | { purpose: "evidence"; ref: VersionRef; range: Range }
  | { purpose: "receipt"; commandId: string };
export type CommandReceipt = {
  id: string;
  commandId: string;
  ref: VersionRef;
  createdAt: string;
};
export type ReadReceipt = {
  id: string;
  purpose: "current" | "evidence";
  ref: VersionRef;
  actualRange: Range;
  totalLength: number;
  createdAt: string;
};
export type Meta = {
  traceId: string;
  protocolVersion: typeof PROTOCOL;
  implementationVersion: "memory-g1.v1";
  provider: string;
  detail: string;
  warnings: string[];
};
export type AppendResult = {
  status: "committed";
  replayed: boolean;
  observation: Observation;
  ref: VersionRef;
  receipt: CommandReceipt;
  meta: Meta;
};
export type ReadResult =
  | {
      status: "ok";
      content: string;
      ref: VersionRef;
      receipt: ReadReceipt;
      meta: Meta;
    }
  | { status: "not_found" | "unavailable"; code: string; meta: Meta }
  | { status: "committed"; receipt: CommandReceipt; meta: Meta };
export class MemoryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}
