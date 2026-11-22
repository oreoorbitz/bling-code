/**
 * Answers a repeated read of an unchanged file with a short note instead of the content again.
 * Ported from qwen-code's file read cache (`packages/core/src/services/fileReadCache.ts` and the
 * `file_unchanged` path of `tools/read-file.ts`).
 *
 * Files are identified by device and inode, so symlinks and other spellings of a path share an
 * entry, and a change shows up as a different mtime or size. Only a repeat with the same offset and
 * limit is answered from the cache; a different range always reads. The entry remembers which tool
 * result holds the content, and is dropped when that result is cleared from the context, after a
 * compaction, or on a branch switch, so the note never points at content the model no longer has.
 */

import type { Stats } from "node:fs";

interface Entry {
	mtimeMs: number;
	size: number;
	offset: number | undefined;
	limit: number | undefined;
	/** The tool result that carries the content. */
	toolCallId: string;
}

export interface ReadRange {
	offset?: number;
	limit?: number;
}

function identity(stats: Stats): string | undefined {
	// An inode of 0 (some FAT and network filesystems) cannot tell files apart.
	return stats.ino === 0 ? undefined : `${stats.dev}:${stats.ino}`;
}

export class ReadCache {
	private readonly entries = new Map<string, Entry>();

	/** Whether a read of this range returns the content of an earlier result that is still in context. */
	isUnchanged(stats: Stats, range: ReadRange): boolean {
		const key = identity(stats);
		const entry = key === undefined ? undefined : this.entries.get(key);
		return (
			entry !== undefined &&
			entry.mtimeMs === stats.mtimeMs &&
			entry.size === stats.size &&
			entry.offset === range.offset &&
			entry.limit === range.limit
		);
	}

	/** Remember that `toolCallId` holds this file's content for this range. */
	record(stats: Stats, range: ReadRange, toolCallId: string): void {
		const key = identity(stats);
		if (key === undefined) return;
		this.entries.set(key, {
			mtimeMs: stats.mtimeMs,
			size: stats.size,
			offset: range.offset,
			limit: range.limit,
			toolCallId,
		});
	}

	/** Drop entries whose content lived in a tool result that left the context. */
	evict(toolCallIds: ReadonlySet<string>): void {
		for (const [key, entry] of this.entries) if (toolCallIds.has(entry.toolCallId)) this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}
}

export function unchangedReadNote(displayPath: string): string {
	return `File ${displayPath} is unchanged since it was last read in this conversation with the same offset and limit. Refer to that earlier content instead. If you cannot find it, or suspect the file was modified outside the read, edit, and write tools, read it with a different offset or limit.`;
}
