import { createServer, type IncomingMessage } from "node:http";
import { MemoryError } from "./contracts";
import { object, keys, fail } from "./validation";

/** The transport receives only trusted authenticated clients; it cannot issue identity or install consumers. */
export function createMemoryHttpServer(options: {
	clientForBearer: (token: string) => Promise<{
		capabilities(): unknown;
		execute(input: unknown): Promise<unknown>;
		read(input: unknown): Promise<unknown>;
		evidence(input: unknown): Promise<unknown>;
		recall(input: unknown): Promise<any>;
		issueUse(pack: any, input: unknown): Promise<unknown>;
		dispatchRemote(input: unknown): Promise<unknown>;
		useStatus(input: unknown): Promise<unknown>;
		records: {
			execute(input: unknown): Promise<unknown>;
			read(input: unknown): Promise<unknown>;
		};
	}>;
}) {
	async function body(req: IncomingMessage) {
		if (req.headers["content-type"]?.split(";")[0] !== "application/json")
			fail("json_required", 415);
		if (req.headers["content-encoding"]) fail("encoding_unsupported", 415);
		const chunks: Buffer[] = [];
		let length = 0;
		for await (const chunk of req) {
			length += chunk.length;
			if (length > 262144) fail("request_too_large", 413);
			chunks.push(Buffer.from(chunk));
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		} catch {
			return fail("invalid_json");
		}
	}
	const server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json; charset=utf-8");
		res.setHeader("cache-control", "no-store");
		res.setHeader("x-content-type-options", "nosniff");
		try {
			// No cookies, ambient identity, CORS or request-controlled namespace/destination.
			if (req.headers.origin) fail("browser_origin_denied", 403);
			const auth = req.headers.authorization;
			if (!auth || !/^Bearer [A-Za-z0-9_-]{43}$/.test(auth))
				fail("authentication_required", 401);
			const client = await options.clientForBearer(auth.slice(7));
			if (req.method === "GET" && req.url === "/v1/capabilities") {
				res.end(JSON.stringify(client.capabilities()));
				return;
			}
			if (req.method !== "POST") fail("route_not_found", 404);
			const input = await body(req);
			let result: unknown;
			switch (req.url) {
				case "/v1/commands":
					result = await client.execute(input);
					break;
				case "/v1/read":
					result = await client.read(input);
					break;
				case "/v1/evidence":
					result = await client.evidence(input);
					break;
				case "/v1/records/commands":
					result = await client.records.execute(input);
					break;
				case "/v1/records/query":
					result = await client.records.read(input);
					break;
				case "/v1/recall":
					result = await client.recall(input);
					break;
				case "/v1/use/prepare": {
					const args = object(input);
					keys(args, ["recall", "consumerId", "purpose"]);
					const pack = await client.recall(args.recall);
					result = {
						pack,
						use: await client.issueUse(pack, {
							consumerId: args.consumerId,
							purpose: args.purpose,
						}),
					};
					break;
				}
				case "/v1/use/dispatch":
					result = await client.dispatchRemote(input);
					break;
				case "/v1/use/status":
					result = await client.useStatus(input);
					break;
				default:
					fail("route_not_found", 404);
			}
			res.end(JSON.stringify(result));
		} catch (error) {
			res.statusCode = error instanceof MemoryError ? error.status : 503;
			res.end(
				JSON.stringify({
					code:
						error instanceof MemoryError ? error.code : "service_unavailable",
					...(error && typeof error === "object" && "admissionId" in error
						? { admissionId: error.admissionId }
						: {}),
				}),
			);
		}
	});
	server.requestTimeout = 15000;
	server.headersTimeout = 10000;
	server.maxRequestsPerSocket = 100;
	return server;
}

/** Explicit HTTP adapter. Never retries dispatch or converts an unknown outcome to success. */
export function createRemoteMemoryClient(baseUrl: string, token: string) {
	const base = new URL(baseUrl);
	if (
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		base.pathname !== "/"
	)
		throw Error("invalid_service_origin");
	if (
		base.protocol !== "https:" &&
		!(
			base.protocol === "http:" &&
			["127.0.0.1", "[::1]"].includes(base.hostname)
		)
	)
		throw Error("tls_required");
	return {
		async request(route: string, input?: unknown): Promise<any> {
			if (!/^\/v1\/[a-z/]+$/.test(route)) throw Error("invalid_route");
			const response = await fetch(new URL(route, base), {
				method: input === undefined ? "GET" : "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: input === undefined ? undefined : JSON.stringify(input),
				redirect: "error",
				signal: AbortSignal.timeout(20000),
			});
			const data = await response.json();
			if (!response.ok)
				throw Object.assign(
					new MemoryError(data.code, response.status, data.code),
					{ admissionId: data.admissionId },
				);
			return data;
		},
	};
}
