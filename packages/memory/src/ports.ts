import type {
  AppendCommand,
  CommandReceipt,
  Namespace,
  Observation,
  ReadReceipt,
  VersionRef,
} from "./contracts";
export type Identity = {
  namespace: Namespace;
  principalId: string;
  traceId: string;
};
export type SourceDescriptor = {
  id: string;
  adapterVersion: string;
  kind: string;
  trustLevel: string;
  validateExtensions?: (value: Record<string, unknown>) => void;
};
export type StoredCommand = { requestHash: string; receipt: CommandReceipt };
/** All methods run inside the SAME transaction. Reads must hold source versions until receipt commit. */
export interface ObservationTransaction {
  authorize(
    identity: Identity,
    operation: "append" | "read" | "receipt",
  ): Promise<void>;
  lockCommand(identity: Identity, commandId: string): Promise<void>;
  command(identity: Identity, commandId: string): Promise<StoredCommand | null>;
  observation(namespace: Namespace, id: string): Promise<Observation | null>;
  append(identity: Identity, observation: Observation): Promise<Observation>;
  saveCommand(
    identity: Identity,
    stored: StoredCommand,
  ): Promise<CommandReceipt>;
  saveRead(identity: Identity, receipt: ReadReceipt): Promise<ReadReceipt>;
}
export interface ObservationStore {
  provider: string;
  transaction<T>(
    work: (store: ObservationTransaction) => Promise<T>,
  ): Promise<T>;
}
/** A trusted migration codec preserves an existing scheme; callers cannot supply one in JSON. */
export type ObservationFormat = {
  commandHash(command: AppendCommand): string;
  version(record: Observation): VersionRef;
};
