export function exactPrefix(original: string, selected: string) {
	return (
		typeof selected === "string" &&
		original.startsWith(selected) &&
		Array.from(original).slice(0, Array.from(selected).length).join("") ===
			selected
	);
}

/** Rank only already authorized candidates. Priority and reservation are project policy. */
export function selectRecallCandidates<T extends { id: string }>(input: {
	ranked: readonly T[];
	maxItems: number;
	group(item: T): string | undefined;
	priority(item: T): boolean;
	reserve(item: T): boolean;
	reserveLimit: number;
	onDuplicate(item: T): void;
	onReserved(item: T): void;
}) {
	const groups = new Set<string>(),
		ids = new Set<string>(),
		duplicates = new Set<string>(),
		items: T[] = [];
	function select(item: T) {
		if (items.length >= input.maxItems || ids.has(item.id)) return false;
		const group = input.group(item);
		if (group && groups.has(group)) {
			if (!duplicates.has(item.id)) {
				input.onDuplicate(item);
				duplicates.add(item.id);
			}
			return false;
		}
		if (group) groups.add(group);
		items.push(item);
		ids.add(item.id);
		return true;
	}
	for (const item of input.ranked.filter(input.priority)) select(item);
	let reserved = 0;
	for (const item of input.ranked) {
		if (reserved >= input.reserveLimit || items.length >= input.maxItems) break;
		if (!input.priority(item) && input.reserve(item) && select(item)) {
			input.onReserved(item);
			reserved++;
		}
	}
	for (const item of input.ranked) {
		if (items.length >= input.maxItems) break;
		select(item);
	}
	return items;
}

export type BudgetEntry = {
	content: string;
	truncated?: boolean;
	truncationReason?: string;
};
export type BudgetPack<E extends BudgetEntry> = {
	constraints: E[];
	currentStates: E[];
	historicalEvidence: E[];
	interpretations: E[];
	openQuestions: Array<{ code: string; detail: string }>;
	budget: {
		maxTokens: number;
		usedUpperBound: number;
		unit: "utf8_bytes_upper_bound";
		truncated: boolean;
		negotiation?: {
			mode: "bounded_adaptive";
			preferredBytes: number;
			ceilingBytes: number;
			requiredBytes: number;
		};
	};
};
const size = (value: unknown) =>
	Buffer.byteLength(JSON.stringify(value), "utf8");
/** Constraints remain complete; clipping preserves Unicode code points and explicit truncation. */
export function budgetContextPack<
	E extends BudgetEntry,
	P extends BudgetPack<E>,
>(
	input: P,
	reservedBytes = 0,
	optionalOrder: readonly (
		| "currentStates"
		| "historicalEvidence"
		| "interpretations"
	)[] = ["currentStates", "historicalEvidence", "interpretations"],
): P | null {
	const questions = input.openQuestions.slice(0, 8).map((item) => ({
		code: item.code,
		detail: Array.from(item.detail).slice(0, 120).join(""),
	}));
	const clippedQuestions =
		input.openQuestions.length > 8 ||
		questions.some(
			(item, index) => item.detail !== input.openQuestions[index].detail,
		);
	const pack = {
		...input,
		constraints: [],
		currentStates: [],
		historicalEvidence: [],
		interpretations: [],
		openQuestions: questions,
		budget: {
			...input.budget,
			usedUpperBound: 0,
			truncated: input.budget.truncated || clippedQuestions,
		},
	} as P;
	const fits = () => size(pack) + 16 + reservedBytes <= pack.budget.maxTokens;
	for (const entry of input.constraints) {
		if (entry.truncated) return null;
		pack.constraints.push(entry);
		if (!fits()) return null;
	}
	for (const group of optionalOrder) {
		for (const entry of input[group]) {
			pack[group].push(entry);
			if (fits()) continue;
			pack[group].pop();
			pack.budget.truncated = true;
			const chars = Array.from(entry.content);
			let low = 0,
				high = chars.length,
				clipped: E | undefined;
			while (low <= high) {
				const mid = Math.floor((low + high) / 2),
					value = {
						...entry,
						content: chars.slice(0, mid).join(""),
						truncated: true,
						truncationReason: "context_budget",
					} as E;
				pack[group].push(value);
				const allowed = fits();
				pack[group].pop();
				if (allowed) {
					clipped = value;
					low = mid + 1;
				} else high = mid - 1;
			}
			if (clipped?.content) pack[group].push(clipped);
		}
	}
	if (!fits()) return null;
	pack.budget.usedUpperBound = size(pack) + 16;
	return pack;
}

/** Explicit opt-in, measured once from the same snapshot. Never raises a caller's ceiling. */
export function negotiateContextPack<
	E extends BudgetEntry,
	P extends BudgetPack<E>,
>(
	input: P,
	options: { ceilingBytes: number; reservedBytes?: number },
): { pack: P | null; requiredBytes: number } {
	const preferredBytes = input.budget.maxTokens,
		ceilingBytes = options.ceilingBytes,
		reserve = options.reservedBytes ?? 0;
	if (
		!Number.isSafeInteger(preferredBytes) ||
		!Number.isSafeInteger(ceilingBytes) ||
		preferredBytes < 1 ||
		ceilingBytes < preferredBytes ||
		!Number.isSafeInteger(reserve) ||
		reserve < 0
	)
		throw Error("invalid_context_budget");
	const negotiation = {
		mode: "bounded_adaptive" as const,
		preferredBytes,
		ceilingBytes,
		requiredBytes: 0,
	};
	const candidate = { ...input, budget: { ...input.budget, negotiation } };
	const mandatory = budgetContextPack<E, P>({
		...candidate,
		currentStates: [],
		historicalEvidence: [],
		interpretations: [],
		budget: { ...candidate.budget, maxTokens: Number.MAX_SAFE_INTEGER },
	} as P);
	if (!mandatory) throw Error("incomplete_safety_constraint");
	// Include serialized metadata, byte-count digits and final audit/notice reservation.
	const requiredBytes = mandatory.budget.usedUpperBound + reserve + 32;
	const effectiveBytes =
		requiredBytes <= preferredBytes
			? preferredBytes
			: Math.min(ceilingBytes, Math.ceil((requiredBytes + 2048) / 1024) * 1024);
	if (requiredBytes > ceilingBytes) return { pack: null, requiredBytes };
	const pack = budgetContextPack<E, P>(
		{
			...candidate,
			budget: {
				...candidate.budget,
				maxTokens: effectiveBytes,
				negotiation: { ...negotiation, requiredBytes },
			},
		} as P,
		reserve,
		["currentStates", "interpretations", "historicalEvidence"],
	);
	return { pack, requiredBytes };
}
