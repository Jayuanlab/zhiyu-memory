import { MemoryError } from "../../packages/memory/src/contracts";
import { createHttpEmbeddingProvider } from "../../packages/memory/src/embeddings";

export function embeddingFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const url = env.MEMORY_EMBEDDING_URL;
  const model = env.MEMORY_EMBEDDING_MODEL;
  const rawDimensions = env.MEMORY_EMBEDDING_DIMENSIONS;
  const apiKey = env.MEMORY_EMBEDDING_API_KEY;
  if ([url, model, rawDimensions, apiKey].every((value) => value === undefined)) return undefined;
  if (!url || !model || !rawDimensions || !/^[1-9]\d*$/.test(rawDimensions)) {
    throw new MemoryError("embedding_configuration_invalid", 500, "Embedding URL, model and dimensions are required together");
  }
  return {
    provider: createHttpEmbeddingProvider({ url, model, dimensions: Number(rawDimensions), apiKey }),
    defaultMode: "hybrid" as const,
    minSimilarity: 0.3,
  };
}
