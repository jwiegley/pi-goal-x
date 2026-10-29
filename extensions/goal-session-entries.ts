import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The fields Goal X reads from a Pi session entry. */
export interface GoalSessionEntry {
	type?: string;
	customType?: string;
	data?: unknown;
}

type SessionManager = ExtensionContext["sessionManager"];

/**
 * Hosts with indexed session history answer "latest custom entry of this type
 * on the active branch" without materializing the branch. Pi 1.4 does not
 * declare the query, so it is detected at runtime.
 */
interface IndexedCustomEntries {
	getLatestCustomEntry(customType: string, options: { scope: "active" }): GoalSessionEntry | undefined;
}

function indexedCustomEntries(manager: SessionManager): IndexedCustomEntries | null {
	const candidate = manager as Partial<IndexedCustomEntries>;
	return typeof candidate.getLatestCustomEntry === "function" ? candidate as IndexedCustomEntries : null;
}

/**
 * Return the newest active-branch entry of each requested custom type that
 * `accept` takes, keyed by custom type.
 *
 * An indexed host answers one query per type, so cost is independent of the
 * session's length; only the newest entry of each type is considered there.
 * Other hosts fall back to one reverse branch scan that stops as soon as every
 * type has an accepted entry, which is the behaviour Goal X always had.
 */
export function latestActiveCustomEntries(
	manager: SessionManager,
	customTypes: readonly string[],
	accept: (customType: string, entry: GoalSessionEntry) => boolean = () => true,
): Map<string, GoalSessionEntry> {
	const found = new Map<string, GoalSessionEntry>();
	const indexed = indexedCustomEntries(manager);
	if (indexed) {
		for (const customType of customTypes) {
			const entry = indexed.getLatestCustomEntry(customType, { scope: "active" });
			if (entry?.type === "custom" && entry.customType === customType && accept(customType, entry)) found.set(customType, entry);
		}
		return found;
	}
	const wanted = new Set(customTypes);
	const entries = manager.getBranch() as readonly GoalSessionEntry[];
	for (let i = entries.length - 1; i >= 0 && found.size < wanted.size; i--) {
		const entry = entries[i]!;
		if (entry.type !== "custom" || !entry.customType || !wanted.has(entry.customType) || found.has(entry.customType)) continue;
		if (accept(entry.customType, entry)) found.set(entry.customType, entry);
	}
	return found;
}
