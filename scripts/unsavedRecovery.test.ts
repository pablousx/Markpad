import assert from 'node:assert/strict';
import test from 'node:test';
import { createUnsavedRecovery, parseRecovery, recoverySnapshot, restoreRecoveryTabs } from '../src/lib/sessions/unsavedRecovery.js';
import { buildTransferredTab, type TransferableTab } from '../src/lib/utils/tabTransfer.js';
import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';
import { HOME_TAB_PATH } from '../src/lib/utils/homeTab.js';
import { functionSource, readSource, sliceBetween } from './sourceTree.js';

const document: TransferableTab = {
	path: '', title: 'Untitled', rawContent: 'unsaved text', originalContent: '',
	isDirty: true, isEditing: true, isSplit: false, isScrollSynced: true,
	hasReplacementChars: false, encoding: 'utf-8', splitRatio: 0.5,
	scrollTop: 0, scrollPercentage: 0, anchorLine: asRendererLine(1),
	historyIndex: 0, history: [],
};

test('recovery round-trips untitled and file buffers with baseline and encoding', () => {
	const untitled = buildTransferredTab(document, [], 'Untitled');
	const file = buildTransferredTab({ ...document, path: '/notes.md', originalContent: 'saved', encoding: 'gbk' }, [], 'Untitled');
	assert.deepEqual(parseRecovery(recoverySnapshot([untitled, file])), [document, { ...document, path: '/notes.md', originalContent: 'saved', encoding: 'gbk' }]);
	assert.equal(file.originalContent, 'saved');
});

test('clean, empty untitled and partial editors persist, but the home tab does not', () => {
	const clean = buildTransferredTab({ ...document, rawContent: '' }, [], 'Untitled');
	const partial = buildTransferredTab(document, [], 'Untitled');
	partial.isTruncated = true;
	const home = buildTransferredTab({ ...document, path: HOME_TAB_PATH }, [], 'Untitled');
	const restored = parseRecovery(recoverySnapshot([clean, partial, home]));
	assert.equal(restored.length, 2);
	assert.equal(restored[0].rawContent, '');
	assert.equal(restored[0].originalContent, '');
	assert.equal(restored[1].isTruncated, true);
});

test('invalid recovery records are rejected before restoring any tab', () => {
	for (const json of ['null', '{}', 'broken', '[{}]', JSON.stringify([{ ...document, isTruncated: 'yes' }]), JSON.stringify([document, {}])]) {
		assert.throws(() => parseRecovery(json));
	}
});

test('restore replaces clean session copies, retains dirty copies, and opens untitled buffers', () => {
	const manager = {
		tabs: [
			buildTransferredTab({ ...document, path: '/notes.md', rawContent: 'saved', originalContent: 'saved' }, [], 'Untitled'),
			buildTransferredTab({ ...document, path: '/other.md' }, [], 'Untitled'),
		],
		closeTab(id: string) { this.tabs = this.tabs.filter((tab) => tab.id !== id); },
		insertTransferredTab(snapshot: TransferableTab) {
			const tab = buildTransferredTab(snapshot, this.tabs.map((tab) => tab.title), 'Untitled');
			this.tabs.push(tab);
			return tab.id;
		},
	};
	const dirtyId = manager.tabs[1].id;
	restoreRecoveryTabs(manager, JSON.stringify([
		{ ...document, path: '/notes.md', originalContent: 'saved', isEditing: false, isSplit: true },
		{ ...document, path: '/other.md', rawContent: 'another unsaved copy' },
		document,
	]));
	assert.equal(manager.tabs.length, 4);
	assert.equal(manager.tabs[0].id, dirtyId);
	assert.equal(manager.tabs[1].rawContent, 'unsaved text');
	assert.equal(manager.tabs[1].originalContent, 'saved');
	assert.equal(manager.tabs[1].isDirty, true);
	assert.equal(manager.tabs[1].isEditing, true);
	assert.equal(manager.tabs[1].isSplit, false);
	assert.equal(manager.tabs[3].path, '');
	const before = [...manager.tabs];
	assert.throws(() => restoreRecoveryTabs(manager, JSON.stringify([document, {}])));
	assert.deepEqual(manager.tabs, before);
});

test('saved file editors and blank untitled editors are restored as clean tabs', () => {
	const manager = {
		tabs: [] as ReturnType<typeof buildTransferredTab>[],
		closeTab() {},
		insertTransferredTab(snapshot: TransferableTab) {
			const tab = buildTransferredTab(snapshot, this.tabs.map((tab) => tab.title), 'Untitled');
			this.tabs.push(tab);
			return tab.id;
		},
	};
	const clean = { ...document, rawContent: 'saved', originalContent: 'saved', path: '/saved.md' };
	const empty = { ...document, rawContent: '' };
	const ids = restoreRecoveryTabs(manager, JSON.stringify([clean, empty, { ...clean, path: '/partial.md', isTruncated: true }]));
	assert.equal(ids.length, 3);
	assert.equal(manager.tabs[0].path, '/saved.md');
	assert.equal(manager.tabs[0].isDirty, false);
	assert.equal(manager.tabs[1].path, '');
	assert.equal(manager.tabs[1].isDirty, false);
	assert.equal(manager.tabs[2].isTruncated, true);
});

test('continuous changes reach disk within the bounded background delay', async (context) => {
	context.mock.timers.enable({ apis: ['setTimeout'] });
	const writes: string[] = [];
	const recovery = createUnsavedRecovery({ write: async (json) => { writes.push(json); }, onError: (error) => { throw error; } });
	recovery.update('first');
	context.mock.timers.tick(400);
	recovery.update('latest');
	context.mock.timers.tick(100);
	await Promise.resolve();
	assert.deepEqual(writes, ['latest']);
	recovery.update('[]');
	context.mock.timers.tick(500);
	await recovery.flush();
	assert.equal(writes.at(-1), '[]');
	recovery.dispose();
});

test('flush cancels delayed writes and serializes cleanup behind in-flight writes', async () => {
	const writes: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const recovery = createUnsavedRecovery({
		write: async (json) => { writes.push(json); if (writes.length === 1) await gate; },
		onError: (error) => { throw error; },
	});
	recovery.update('old');
	const first = recovery.flush('new');
	await Promise.resolve();
	const cleanup = recovery.flush('[]');
	assert.deepEqual(writes, ['new']);
	release();
	await Promise.all([first, cleanup]);
	assert.deepEqual(writes, ['new', '[]']);
	recovery.dispose();
});

test('window close persists enabled editors before the save/discard review, and refuses an unsafe exit', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');
	const settle = functionSource(viewer, 'settleForExit');
	const persistBranch = sliceBetween(settle, 'if (settings.persistOpenEditors)', '// Unsaved content and session restore');
	assert.match(persistBranch, /if \(!recoveryReady\)/);
	assert.match(persistBranch, /await unsavedRecovery\.flush\(recoverySnapshot\(tabManager\.tabs\)\)/);
	assert.match(persistBranch, /return false/);
	assert.match(persistBranch, /return true/);
	assert.doesNotMatch(persistBranch, /reviewDirtyTabs|canCloseTab|saveSilently/);
	assert.match(settle, /await reviewDirtyTabs/);
	const cleanRefresh = sliceBetween(viewer, 'const restoredIds = restoreRecoveryTabs', 'consumed.push(label)');
	assert.match(cleanRefresh, /tab\.isDirty \|\| !hasRealFilePath/);
	assert.match(cleanRefresh, /read_file_content_checked/);
});

test('failed writes retry without another edit and flush reports failure', async (context) => {
	context.mock.timers.enable({ apis: ['setTimeout'] });
	let attempts = 0;
	const recovery = createUnsavedRecovery({
		write: async () => { if (++attempts === 1) throw new Error('temporarily unavailable'); },
		onError: () => {},
	});
	assert.equal(await recovery.flush('unsaved'), false);
	assert.equal(attempts, 1);
	context.mock.timers.tick(2000);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(attempts, 2);
	assert.equal(await recovery.flush(), true);
	recovery.dispose();
});

test('write failures are reported without blocking later snapshots', async () => {
	const errors: unknown[] = [];
	const writes: string[] = [];
	const recovery = createUnsavedRecovery({
		write: async (json) => { writes.push(json); if (json === 'bad') throw new Error('disk full'); },
		onError: (error) => { errors.push(error); },
	});
	await recovery.flush('bad');
	await recovery.flush('[]');
	assert.equal(errors.length, 1);
	assert.deepEqual(writes, ['bad', '[]']);
	recovery.dispose();
});
