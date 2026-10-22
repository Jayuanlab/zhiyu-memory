import { createHash } from "node:crypto";
import { MemoryError } from "./contracts";

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(inputs: readonly string[]): Promise<number[][]>;
}

function invalidResponse(): never {
  throw new MemoryError("embedding_invalid_response", 502, "Invalid embedding response");
}

function unavailable(): never {
  throw new MemoryError("embedding_unavailable", 503, "Embedding service unavailable");
}

export function normalizeEmbedding(value: unknown, dimensions: number): number[] {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || !Array.isArray(value) || value.length !== dimensions) invalidResponse();
  let scale = 0;
  for (const component of value) {
    if (typeof component !== "number" || !Number.isFinite(component)) invalidResponse();
    scale = Math.max(scale, Math.abs(component));
  }
  if (scale === 0) invalidResponse();
  // Scaling first avoids overflow and underflow for otherwise valid finite vectors.
  const scaled = value.map((component: number) => component / scale);
  const length = Math.sqrt(scaled.reduce((sum, component) => sum + component * component, 0));
  return scaled.map((component) => component / length);
}

export async function embedTexts(provider: EmbeddingProvider, texts: readonly string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  try {
    const vectors: unknown = await provider.embed(texts);
    if (!Array.isArray(vectors) || vectors.length !== texts.length) invalidResponse();
    return Array.from(vectors, (vector) => normalizeEmbedding(vector, provider.dimensions));
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    return unavailable();
  }
}

export type HttpEmbeddingOptions = {
  url: string;
  model: string;
  dimensions: number;
  apiKey?: string;
  timeoutMs?: number;
};

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function configurationInvalid(): never {
  throw new MemoryError("embedding_configuration_invalid", 500, "Invalid embedding configuration");
}

function configuredUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return configurationInvalid();
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || raw.includes("?") || raw.includes("#")) configurationInvalid();
  return url;
}

async function responseJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return invalidResponse();
  }
  if (!response.body) invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return invalidResponse();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    return invalidResponse();
  }
}

export function createHttpEmbeddingProvider(options: HttpEmbeddingOptions): EmbeddingProvider {
  if (typeof options.url !== "string" || typeof options.model !== "string" || !options.model.trim() || !Number.isSafeInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 65536) configurationInvalid();
  const url = configuredUrl(options.url);
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || (options.apiKey !== undefined && (typeof options.apiKey !== "string" || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey)))) configurationInvalid();
  const { model, dimensions, apiKey } = options;
  const id = "http-embedding:" + createHash("sha256").update(JSON.stringify([url.href, model, dimensions])).digest("hex");
  return {
    id,
    dimensions,
    async embed(inputs) {
      if (inputs.length === 0) return [];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model, input: inputs, encoding_format: "float" }),
          redirect: "manual",
          signal: controller.signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          return unavailable();
        }
        const body = await responseJson(response);
        if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data) || body.data.length !== inputs.length) invalidResponse();
        const result: number[][] = new Array(inputs.length);
        const seen = new Set<number>();
        for (const item of body.data) {
          if (!item || typeof item !== "object" || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= inputs.length || seen.has(item.index)) invalidResponse();
          seen.add(item.index);
          result[item.index] = normalizeEmbedding(item.embedding, dimensions);
        }
        return result;
      } catch (error) {
        if (error instanceof MemoryError) throw error;
        return unavailable();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
