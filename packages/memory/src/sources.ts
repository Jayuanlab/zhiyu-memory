import type { SourceDescriptor } from "./ports";
import { MemoryError } from "./contracts";
/** A host-installed, immutable registry; request JSON cannot register sources or relax authority. */
export function createSourceRegistry(descriptors: readonly SourceDescriptor[]) {
  const sources = new Map<string, SourceDescriptor>();
  for (const descriptor of descriptors) {
    if (
      !descriptor.id?.trim() ||
      !descriptor.adapterVersion?.trim() ||
      !descriptor.kind?.trim() ||
      !descriptor.trustLevel?.trim() ||
      sources.has(descriptor.id)
    )
      throw new MemoryError(
        "invalid_source_registry",
        400,
        "Invalid or duplicate source registration",
      );
    sources.set(descriptor.id, Object.freeze({ ...descriptor }));
  }
  return {
    has: (id: string) => sources.has(id),
    get: (id: string) => sources.get(id),
    list: () => [...sources.values()].map((s) => ({ ...s })),
  };
}
