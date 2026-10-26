import * as l10n from '@vscode/l10n';
import type { AIReviewFinding, AIReviewResult, AIReviewSeverity } from '@gitlens/ai/models/results.js';
import { getReviewFindingLocations } from '@gitlens/ai/models/results.js';
import type { KeyMap } from '../../../../../config.js';
import type {
	ReviewCommentPlace,
	ReviewFindingNote,
	ReviewThreadItem,
	ScopeFile,
} from '../../../../plus/graph/graphService.js';

export type ReviewFindingState = 'resolved' | 'dismissed';

/** What a review remembers about its changeset beyond the AI result: which files the reader has been
 *  through, which were set aside, and what became of each finding. Plain data on the anchor's registry
 *  entry, so it survives panel remounts and anchor switches like the run itself. */
export interface ReviewSession {
	/** Viewed marks by path. `contentId` is the content (see `ScopeFile.contentId`) the mark was made
	 *  against; a file that moved on since reads as re-queued rather than silently still viewed. */
	readonly viewed: ReadonlyMap<string, { contentId?: string }>;
	/** Files set aside — out of the checklist and out of the AI's diff. */
	readonly excluded: ReadonlySet<string>;
	/** Findings no longer open; absent = open. */
	readonly findingStates: ReadonlyMap<string, ReviewFindingState>;
	/** What was said about a finding after the fact — the reader's replies and the agent's additions, in
	 *  the order they came. */
	readonly notes: ReadonlyMap<string, readonly ReviewFindingNote[]>;
	/** The reader's own comments on lines of the diff, in the order they were written — findings with
	 *  source `user`. They belong to the review, not to an AI run: a new run or a discard keeps them. */
	readonly comments?: readonly AIReviewFinding[];
	/** A reading order the reader took from an orient pass; files not in it follow in tree order. */
	readonly order?: readonly string[];
}

export const emptyReviewSession: ReviewSession = Object.freeze({
	viewed: new Map<string, { contentId?: string }>(),
	excluded: new Set<string>(),
	findingStates: new Map<string, ReviewFindingState>(),
	notes: new Map<string, readonly ReviewFindingNote[]>(),
});

export type ReviewFileProgress = 'viewed' | 'changed' | 'unviewed';

export type ReviewFileIdentity = Pick<ScopeFile, 'path' | 'contentId'>;

/** `'changed'` = marked viewed against content that has since moved on. When either side has no
 *  content id the mark holds — un-checking everything on every tick would be worse than trusting it. */
export function getReviewFileProgress(
	session: ReviewSession | undefined,
	file: ReviewFileIdentity,
): ReviewFileProgress {
	const mark = session?.viewed.get(file.path);
	if (mark == null) return 'unviewed';
	if (file.contentId == null || mark.contentId == null || mark.contentId === file.contentId) return 'viewed';
	return 'changed';
}

export interface ReviewProgress {
	viewed: number;
	/** Viewed once, changed since — re-queued. */
	changed: number;
	/** Files in the walk — the scope minus the set-aside ones. */
	total: number;
}

export function getReviewProgress(
	session: ReviewSession | undefined,
	files: readonly ReviewFileIdentity[] | undefined,
): ReviewProgress {
	const progress: ReviewProgress = { viewed: 0, changed: 0, total: 0 };
	for (const file of files ?? []) {
		if (session?.excluded.has(file.path)) continue;

		progress.total++;
		const state = getReviewFileProgress(session, file);
		if (state === 'viewed') {
			progress.viewed++;
		} else if (state === 'changed') {
			progress.changed++;
		}
	}
	return progress;
}

/** The findings that can sit in a diff — those with a file and a line — as the editor's threads. */
export function getReviewThreadItems(
	result: AIReviewResult | undefined,
	session: ReviewSession | undefined,
): ReviewThreadItem[] {
	const items: ReviewThreadItem[] = [];
	if (result == null) return items;

	for (const area of result.focusAreas) {
		for (const finding of area.findings ?? []) {
			const notes = session?.notes.get(finding.id);
			// One thread per place the finding holds — all of them the one finding's: same state, same notes
			for (const [index, location] of getReviewFindingLocations(finding).entries()) {
				if (location.lineRange == null) continue;

				items.push({
					id: index === 0 ? finding.id : `${finding.id}#${index}`,
					findingId: finding.id,
					path: location.filePath,
					line: location.lineRange.start,
					lineEnd: location.lineRange.end,
					severity: finding.severity,
					title: finding.title,
					description: finding.description,
					state: session?.findingStates.get(finding.id) ?? 'open',
					...(finding.source != null ? { source: finding.source } : {}),
					...(notes?.length ? { notes: [...notes] } : {}),
				});
			}
		}
	}
	return items;
}

/** The stops of a walk, in reading order — the session's order first, then tree order (path-sorted);
 *  set-aside files left out; the tree's own rendered order, when given, orders what the plan doesn't. */
export function getReviewReadingOrder(
	session: ReviewSession | undefined,
	files: readonly ReviewFileIdentity[] | undefined,
	treeOrder?: readonly string[],
): string[] {
	const present = new Set((files ?? []).map(f => f.path));
	const ordered = (session?.order ?? []).filter(p => present.has(p) && !session?.excluded.has(p));
	const placed = new Set(ordered);
	// The rest reads top to bottom as the checklist shows it; by path until the tree has said its order
	const rank = new Map((treeOrder ?? []).map((p, i) => [p, i]));
	const rest = (files ?? [])
		.filter(f => !placed.has(f.path) && !session?.excluded.has(f.path))
		.map(f => f.path)
		.sort((a, b) => {
			const ra = rank.get(a);
			const rb = rank.get(b);
			if (ra != null && rb != null) return ra - rb;
			if (ra != null) return -1;
			if (rb != null) return 1;
			return a.localeCompare(b);
		});
	return [...ordered, ...rest];
}

export function withReadingOrder(session: ReviewSession, order: readonly string[] | undefined): ReviewSession {
	const current = session.order;
	if (current === order) return session;
	if (
		current != null &&
		order != null &&
		current.length === order.length &&
		current.every((p, i) => p === order[i])
	) {
		return session;
	}

	return { ...session, order: order };
}

export function isReviewComplete(progress: ReviewProgress): boolean {
	return progress.total > 0 && progress.viewed === progress.total;
}

export interface ReviewFindingCounts {
	open: number;
	resolved: number;
	dismissed: number;
}

export function countReviewFindingStates(
	result: AIReviewResult | undefined,
	session: ReviewSession | undefined,
): ReviewFindingCounts {
	const counts: ReviewFindingCounts = { open: 0, resolved: 0, dismissed: 0 };
	if (result == null) return counts;

	for (const area of result.focusAreas) {
		for (const finding of area.findings ?? []) {
			const state = session?.findingStates.get(finding.id);
			if (state == null) {
				counts.open++;
			} else {
				counts[state]++;
			}
		}
	}
	return counts;
}

/** What a checklist row says about its file's findings: how many are still open, how many are
 *  closed, and the worst open severity — the row's mark takes its color from that. */
export interface ReviewFileFindings {
	open: number;
	closed: number;
	/** The highest severity among the open findings; absent when none is open. */
	severity?: AIReviewSeverity;
	/** Where to land when the reader opens the file from its mark: the first open finding with a line,
	 *  or the first finding at all once every one is closed; absent when none names a line. */
	target?: { readonly start: number; readonly end: number };
}

const severityRank: Record<AIReviewSeverity, number> = { critical: 0, warning: 1, suggestion: 2 };

/** Findings by file path, from every focus area — the model's own and the agent's reported back
 *  alike. Findings with no file (general remarks) have no row to mark and are left out. */
export function getReviewFileFindings(
	result: AIReviewResult | undefined,
	session: ReviewSession | undefined,
): ReadonlyMap<string, ReviewFileFindings> {
	const byPath = new Map<string, ReviewFileFindings>();
	if (result == null) return byPath;

	// Files whose target is an open finding already — a closed one never replaces it
	const openTargets = new Set<string>();
	for (const area of result.focusAreas) {
		for (const finding of area.findings ?? []) {
			const open = session?.findingStates.get(finding.id) == null;
			// A finding counts once per file it holds in, however many places it has there
			const counted = new Set<string>();
			for (const location of getReviewFindingLocations(finding)) {
				let entry = byPath.get(location.filePath);
				if (entry == null) {
					entry = { open: 0, closed: 0 };
					byPath.set(location.filePath, entry);
				}

				if (
					location.lineRange != null &&
					!openTargets.has(location.filePath) &&
					(open || entry.target == null)
				) {
					entry.target = location.lineRange;
					if (open) {
						openTargets.add(location.filePath);
					}
				}

				if (counted.has(location.filePath)) continue;

				counted.add(location.filePath);

				if (!open) {
					entry.closed++;
					continue;
				}

				entry.open++;
				if (entry.severity == null || severityRank[finding.severity] < severityRank[entry.severity]) {
					entry.severity = finding.severity;
				}
			}
		}
	}
	return byPath;
}

/** Ids of findings that are resolved or dismissed — what markdown export and the findings list leave out. */
export function getClosedFindingIds(session: ReviewSession | undefined): ReadonlySet<string> {
	if (!session?.findingStates.size) return emptyReviewSession.excluded;

	return new Set(session.findingStates.keys());
}

// Each update returns the same session when it would change nothing, so callers can skip a no-op write.

export function withFilesViewed(
	session: ReviewSession,
	files: readonly ReviewFileIdentity[],
	viewed: boolean,
): ReviewSession {
	let next: Map<string, { contentId?: string }> | undefined;
	for (const file of files) {
		if (viewed) {
			if (getReviewFileProgress(session, file) === 'viewed') continue;

			next ??= new Map(session.viewed);
			next.set(file.path, { contentId: file.contentId });
		} else {
			if (!session.viewed.has(file.path)) continue;

			next ??= new Map(session.viewed);
			next.delete(file.path);
		}
	}
	return next == null ? session : { ...session, viewed: next };
}

export function withFileExcluded(session: ReviewSession, path: string, excluded: boolean): ReviewSession {
	if (session.excluded.has(path) === excluded) return session;

	const next = new Set(session.excluded);
	if (excluded) {
		next.add(path);
	} else {
		next.delete(path);
	}
	return { ...session, excluded: next };
}

export function withFindingState(
	session: ReviewSession,
	findingId: string,
	state: ReviewFindingState | undefined,
): ReviewSession {
	if (session.findingStates.get(findingId) === state) return session;

	const next = new Map(session.findingStates);
	if (state == null) {
		next.delete(findingId);
	} else {
		next.set(findingId, state);
	}
	return { ...session, findingStates: next };
}

/** Appends a note to a finding; an empty one is ignored. */
export function withFindingNote(session: ReviewSession, findingId: string, note: ReviewFindingNote): ReviewSession {
	const text = note.text.trim();
	if (!text) return session;

	const next = new Map(session.notes);
	next.set(findingId, [...(session.notes.get(findingId) ?? []), { ...note, text: text }]);
	return { ...session, notes: next };
}

/** Drops the AI findings' states and notes — for a result that is being discarded; viewed marks,
 *  exclusions and the reader's own comments (with their states and notes) belong to the review and stay. */
export function withoutFindings(session: ReviewSession): ReviewSession {
	const kept = new Set(session.comments?.map(c => c.id));
	const keep = <T>(map: ReadonlyMap<string, T>) => new Map([...map].filter(([id]) => kept.has(id)));
	const findingStates = keep(session.findingStates);
	const notes = keep(session.notes);
	if (findingStates.size === session.findingStates.size && notes.size === session.notes.size) return session;

	return { ...session, findingStates: findingStates, notes: notes };
}

/** The focus area the reader's comments show under — ahead of the AI's, since they are the reader's own word. */
export const userFocusAreaId = 'user';

/** A comment the reader wrote on lines of the diff, as a finding: no severity to speak of (`suggestion`
 *  only so the shared shape holds — it is never shown), no title, the text as the description. */
export function createReviewComment(id: string, place: ReviewCommentPlace, text: string): AIReviewFinding {
	return {
		id: id,
		severity: 'suggestion',
		title: '',
		description: text,
		filePath: place.path,
		lineRange: { start: place.line, end: place.lineEnd },
		source: 'user',
	};
}

export function withReviewComment(session: ReviewSession, comment: AIReviewFinding): ReviewSession {
	const text = comment.description.trim();
	if (!text || session.comments?.some(c => c.id === comment.id)) return session;

	return { ...session, comments: [...(session.comments ?? []), { ...comment, description: text }] };
}

/** Rewrites a comment's text; an empty one leaves it as it was — removing is its own step. */
export function withReviewCommentText(session: ReviewSession, id: string, text: string): ReviewSession {
	const trimmed = text.trim();
	const comment = session.comments?.find(c => c.id === id);
	if (comment == null || !trimmed || comment.description === trimmed) return session;

	return {
		...session,
		comments: session.comments!.map(c => (c.id === id ? { ...c, description: trimmed } : c)),
	};
}

/** Removes a comment, its state and the notes on it. */
export function withoutReviewComment(session: ReviewSession, id: string): ReviewSession {
	if (!session.comments?.some(c => c.id === id)) return session;

	const comments = session.comments.filter(c => c.id !== id);
	const findingStates = new Map(session.findingStates);
	findingStates.delete(id);
	const notes = new Map(session.notes);
	notes.delete(id);
	return {
		...session,
		comments: comments.length > 0 ? comments : undefined,
		findingStates: findingStates,
		notes: notes,
	};
}

let lastWithComments:
	| { result: AIReviewResult | undefined; comments: readonly AIReviewFinding[]; merged: AIReviewResult }
	| undefined;

/** The review as the reader sees it: the AI's result with the reader's comments as a focus area of their own,
 *  first. Without comments it is the result itself; with comments and no result, a result of just them.
 *  The same inputs give the same object, so what keys on identity (the panel, the thread sync) holds still. */
export function withReviewComments(
	result: AIReviewResult | undefined,
	session: ReviewSession | undefined,
): AIReviewResult | undefined {
	const comments = session?.comments;
	if (!comments?.length) return result;

	const last = lastWithComments;
	if (last != null && last.result === result && last.comments === comments) return last.merged;

	const merged: AIReviewResult = {
		overview: result?.overview ?? '',
		mode: result?.mode ?? 'single-pass',
		focusAreas: [
			{
				id: userFocusAreaId,
				label: l10n.t('Your comments'),
				rationale: l10n.t('What you noted on the lines of the diff — for the fix and the later reviews.'),
				severity: 'suggestion',
				files: [...new Set(comments.map(c => c.filePath!))],
				findings: comments,
			},
			...(result?.focusAreas.filter(a => a.id !== userFocusAreaId) ?? []),
		],
	};
	lastWithComments = { result: result, comments: comments, merged: merged };
	return merged;
}

export type ReviewReadingKey = 'next' | 'previous' | 'markViewed';

const reviewReadingKeys: Record<ReviewReadingKey, string> = { next: ']', previous: '[', markViewed: 'V' };

/** The keyboard shortcut for a reading step under `keymap`, the way the panel names it — `⌥]` / `Alt+]` on the
 *  alternate keymap, `⌘⌥G ]` / `Ctrl+Shift+G ]` chorded, nothing when shortcuts are off. Mirrors the
 *  `gitlens.review.*:key` keybindings, which live on separate command ids and so never show in the
 *  editor's own hovers. */
export function getReviewReadingShortcut(
	keymap: KeyMap | undefined,
	key: ReviewReadingKey,
	isMac: boolean,
): string | undefined {
	const k = reviewReadingKeys[key];
	switch (keymap) {
		case 'alternate':
			return isMac ? `⌥${k}` : `Alt+${k}`;
		case 'chorded':
			return isMac ? `⌘⌥G ${k}` : `Ctrl+Shift+G ${k}`;
		default:
			return undefined;
	}
}
