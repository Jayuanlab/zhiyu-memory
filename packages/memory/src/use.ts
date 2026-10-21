import { AsyncLocalStorage } from "node:async_hooks";
export type UseVersion = { identity: string; version: string };
/** Host-only composition: proof authenticity, namespace-qualified keys and transactional admission
 * come from installed adapters. No serialized receipt grants permission. */
export function createUseGuard<C, P>(ports: {
	unavailable(): Error;
	scope<T>(work: () => Promise<T>): Promise<T>;
	contextKey(value: C): string;
	contextVersions(value: C): UseVersion[];
	merge(current: C | undefined, incoming: C): { value: C; addedCount: number };
	proofKey(value: P): string;
	proofVersions(value: P): UseVersion[];
	admit(
		groups: readonly C[],
		proofs: readonly P[],
		sequence: number,
		assertCurrent: () => void,
	): Promise<void>;
	maxRefs?: number;
	maxPolicies?: number;
}) {
	type State = {
		active: boolean;
		groups: Map<string, C>;
		proofs: Map<string, P>;
		versions: Map<string, string>;
		generation: number;
		sequence: number;
		proofCount: number;
		failure?: Error;
		admission?: Promise<void>;
		supported?: boolean;
	};
	const contexts = new AsyncLocalStorage<State>(),
		maxRefs = ports.maxRefs ?? 256,
		maxPolicies = ports.maxPolicies ?? 64;
	function fail(state: State): never {
		state.failure ??= ports.unavailable();
		throw state.failure;
	}
	function check(state: State) {
		if (!state.active || state.failure) fail(state);
	}
	function versions(state: State, values: UseVersion[]) {
		for (const { identity, version } of values) {
			const prior = state.versions.get(identity);
			if (
				!identity ||
				!version ||
				(prior && prior !== version) ||
				(!prior && state.versions.size >= maxRefs)
			)
				fail(state);
			state.versions.set(identity, version);
		}
	}
	const guard = {
		invalidate(): never {
			const state = contexts.getStore();
			if (!state) throw ports.unavailable();
			return fail(state);
		},
		async run<T>(work: () => Promise<T>): Promise<T> {
			const current = contexts.getStore();
			if (current) {
				check(current);
				return work();
			}
			const state: State = {
				active: true,
				groups: new Map(),
				proofs: new Map(),
				versions: new Map(),
				generation: 0,
				sequence: 0,
				proofCount: 0,
			};
			return ports.scope(() =>
				contexts.run(state, async () => {
					try {
						return await work();
					} finally {
						state.active = false;
						state.groups.clear();
						state.proofs.clear();
						state.versions.clear();
					}
				}),
			);
		},
		bind(supported: boolean) {
			const state = contexts.getStore();
			if (!state) return;
			check(state);
			state.supported = state.supported !== false && supported;
			if (!state.supported && state.versions.size) fail(state);
		},
		registrationRequired() {
			const state = contexts.getStore();
			if (!state) return false;
			check(state);
			if (state.supported === false) fail(state);
			return true;
		},
		supported() {
			const state = contexts.getStore();
			if (!state) return false;
			check(state);
			return state.supported === true;
		},
		registerProof(proof: P) {
			const state = contexts.getStore();
			if (!state) return;
			check(state);
			if (state.supported === false) fail(state);
			const key = ports.proofKey(proof);
			if (state.proofs.has(key)) return;
			const refs = ports.proofVersions(proof);
			if (
				state.proofs.size + state.groups.size >= maxPolicies ||
				state.proofCount + refs.length > maxRefs
			)
				fail(state);
			versions(state, refs);
			state.proofs.set(key, proof);
			state.proofCount += refs.length;
			state.generation++;
		},
		registerContext(input: C) {
			const state = contexts.getStore();
			if (!state) return;
			check(state);
			const refs = ports.contextVersions(input);
			if (!refs.length) return;
			if (state.supported === false) fail(state);
			const key = ports.contextKey(input),
				current = state.groups.get(key);
			if (!current && state.groups.size + state.proofs.size >= maxPolicies)
				fail(state);
			versions(state, refs);
			const merged = ports.merge(current, input);
			if (state.proofCount + merged.addedCount > maxRefs) fail(state);
			state.groups.set(key, merged.value);
			state.proofCount += merged.addedCount;
			state.generation++;
		},
		snapshot() {
			const state = contexts.getStore();
			if (!state) throw ports.unavailable();
			check(state);
			const generation = state.generation;
			return {
				groups: [...state.groups.values()],
				proofs: [...state.proofs.values()],
				proofCount: state.proofCount,
				assertCurrent: () => {
					check(state);
					if (state.generation !== generation) fail(state);
				},
			};
		},
		async assertCurrent(): Promise<void> {
			const state = contexts.getStore();
			if (!state) throw ports.unavailable();
			check(state);
			if (state.supported === undefined) fail(state);
			if (state.admission) {
				await state.admission;
				return guard.assertCurrent();
			}
			if (!state.groups.size && !state.proofs.size) return;
			const snapshot = guard.snapshot(),
				sequence = ++state.sequence;
			const pending = (async () =>
				ports.admit(
					snapshot.groups,
					snapshot.proofs,
					sequence,
					snapshot.assertCurrent,
				))().catch(() => fail(state));
			state.admission = pending;
			try {
				await pending;
			} finally {
				if (state.admission === pending) state.admission = undefined;
			}
		},
	};
	return guard;
}
