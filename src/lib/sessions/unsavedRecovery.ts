import type { Tab } from '../stores/tabs.svelte.js';
import { isHomePath } from '../utils/homeTab.js';
import { snapshotTab, validateTransferPayload, type TransferableTab } from '../utils/tabTransfer.js';

type PersistedEditor = TransferableTab & { isTruncated?: boolean };

/** Keep every open editor, including clean and empty untitled buffers. Partial
 * reads carry their guard so they can never be restored as complete documents. */
export function recoverySnapshot(tabs: readonly Tab[]): string {
	return JSON.stringify(tabs.filter((tab) => !isHomePath(tab.path)).map((tab) => ({
		...snapshotTab(tab),
		...(tab.isTruncated ? { isTruncated: true } : {}),
	})));
}

export function parseRecovery(json: string): PersistedEditor[] {
	const value: unknown = JSON.parse(json);
	if (!Array.isArray(value)) throw new Error('Invalid recovery snapshot');
	return value.map((entry) => {
		const tab = validateTransferPayload(JSON.stringify(entry));
		if (!tab || isHomePath(tab.path) || (entry.isTruncated !== undefined && typeof entry.isTruncated !== 'boolean')) {
			throw new Error('Invalid recovery document');
		}
		return { ...tab, ...(entry.isTruncated ? { isTruncated: true } : {}) };
	});
}

/** Restore over clean session tabs only; never merge two unsaved buffers. */
export function restoreRecoveryTabs(manager: {
	tabs: Tab[];
	closeTab: (id: string) => void;
	insertTransferredTab: (snapshot: TransferableTab) => string;
}, json: string): string[] {
	const restored: string[] = [];
	// Validate the entire record before changing any tabs.
	for (const snapshot of parseRecovery(json)) {
		const existing = snapshot.path
			? manager.tabs.find((tab) => tab.path === snapshot.path && !tab.isDirty)
			: undefined;
		if (existing) manager.closeTab(existing.id);
		// Editor-first keeps potentially pathological preview input out of startup.
		const id = manager.insertTransferredTab({ ...snapshot, isEditing: true, isSplit: false });
		const tab = manager.tabs.find((tab) => tab.id === id);
		if (tab && snapshot.isTruncated) tab.isTruncated = true;
		restored.push(id);
	}
	return restored;
}

/** One writer per window. A bounded delay, not a resetting debounce: continuous
 * typing must still reach disk. Serialized writes prevent an older IPC from
 * resurrecting content after a save, discard, or setting change. */
export function createUnsavedRecovery(options: {
	write: (json: string) => Promise<void>;
	onError: (error: unknown) => void;
}) {
	let latest = '[]';
	let timer: ReturnType<typeof setTimeout> | undefined;
	let writes = Promise.resolve(true);
	let disposed = false;

	function schedule(delay: number) {
		if (timer || disposed) return;
		timer = setTimeout(() => {
			timer = undefined;
			void enqueue(latest);
		}, delay);
	}

	function enqueue(json: string): Promise<boolean> {
		writes = writes.then(async () => {
			try {
				await options.write(json);
				return true;
			} catch (error) {
				options.onError(error);
				// Retry even if the user stopped typing, including failed cleanup.
				if (json === latest) schedule(2000);
				return false;
			}
		});
		return writes;
	}

	function update(json: string) {
		if (disposed || json === latest) return;
		latest = json;
		schedule(500);
	}

	function flush(json = latest): Promise<boolean> {
		if (timer) clearTimeout(timer);
		timer = undefined;
		latest = json;
		return enqueue(json);
	}

	function dispose() {
		disposed = true;
		if (timer) clearTimeout(timer);
	}

	return { update, flush, dispose };
}
