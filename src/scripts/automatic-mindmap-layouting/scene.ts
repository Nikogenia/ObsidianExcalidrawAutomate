type CustomDataPatch = Parameters<ExcalidrawAutomate["addAppendUpdateCustomData"]>[1];
type CaptureUpdate = NonNullable<Parameters<ExcalidrawAutomate["addElementsToView"]>[4]>;

/** Undo capture for workbench-owned changes (indicators, metadata). */
export const CAPTURE_NEVER = "NEVER" as CaptureUpdate;
/** Undo capture for real content edits the user should be able to undo. */
export const CAPTURE_IMMEDIATELY = "IMMEDIATELY" as CaptureUpdate;

export interface MetadataPatch {
    id: string;
    patch: CustomDataPatch;
}

/**
 * Serializes asynchronous EA workbench transactions.
 *
 * The EA workbench is shared mutable state: an `ea.clear()` issued by one
 * transaction while another awaits `addElementsToView` silently drops the other
 * transaction's elements. Every scene mutation of the workbench runs through
 * one queue so transactions never interleave.
 */
export class TransactionQueue {
    private tail: Promise<unknown> = Promise.resolve();

    /**
     * Runs a transaction after all previously queued transactions.
     *
     * @param transaction Transaction body.
     * @returns The transaction result.
     */
    run<T>(transaction: () => Promise<T>): Promise<T> {
        const next = this.tail.then(transaction, transaction);
        this.tail = next.catch(() => undefined);
        return next;
    }
}

/**
 * Returns true for elements created by the workbench as temporary overlays.
 *
 * @param element Scene element.
 * @returns Whether the element is a temporary indicator.
 */
export function isTemporary(element: ExcalidrawElement): boolean {
    return (element.customData as Record<string, unknown> | undefined)?.isMindmapTemporary === true;
}

/**
 * Merges metadata into the current versions of the given elements.
 *
 * Elements are re-read from the scene by ID immediately before copying them to
 * the workbench. Copying a stale element snapshot would write its old position
 * back and undo any move the user made in the meantime.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param patches Metadata patches keyed by element ID.
 */
export async function saveMetadata(ea: ExcalidrawAutomate, patches: readonly MetadataPatch[]): Promise<void> {
    const ids = new Set(patches.map(({ id }) => id));
    const current = ea.getViewElements().filter((element) => ids.has(element.id));
    if (current.length === 0) return;
    const currentIds = new Set(current.map((element) => element.id));
    ea.clear();
    try {
        ea.copyViewElementsToEAforEditing(current);
        for (const { id, patch } of patches) {
            if (currentIds.has(id)) ea.addAppendUpdateCustomData(id, patch);
        }
        await ea.addElementsToView(false, false, false, false, CAPTURE_NEVER);
    } finally {
        ea.clear();
    }
}

/**
 * Moves elements by one offset in a single undoable transaction.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param ids IDs of the current scene elements to move.
 * @param dx Horizontal offset in scene coordinates.
 * @param dy Vertical offset in scene coordinates.
 */
export async function moveElements(
    ea: ExcalidrawAutomate,
    ids: ReadonlySet<string>,
    dx: number,
    dy: number,
): Promise<void> {
    const current = ea.getViewElements().filter((element) => ids.has(element.id));
    if (current.length === 0 || (dx === 0 && dy === 0)) return;
    ea.clear();
    try {
        ea.copyViewElementsToEAforEditing(current);
        for (const element of current) {
            const editable = ea.getElement(element.id);
            editable.x += dx;
            editable.y += dy;
        }
        await ea.addElementsToView(false, false, false, false, CAPTURE_IMMEDIATELY);
    } finally {
        ea.clear();
    }
    ea.getExcalidrawAPI()?.refreshAllArrows?.();
}

/**
 * Saves the current drawing through the public EA save path.
 *
 * `addElementsToView(..., save = true)` awaits the view's save. Only one
 * element is round-tripped; the view saves the complete scene.
 *
 * @param ea Active ExcalidrawAutomate instance.
 */
export async function saveCurrentDrawing(ea: ExcalidrawAutomate): Promise<void> {
    const first = ea.getViewElements()[0];
    if (!first) return;
    ea.clear();
    try {
        ea.copyViewElementsToEAforEditing([first]);
        await ea.addElementsToView(false, true, false, false, CAPTURE_NEVER);
    } finally {
        ea.clear();
    }
}

/**
 * Removes every temporary element synchronously through the imperative API.
 *
 * This path does not use EA. EA view methods require `targetView._loaded`,
 * which Obsidian clears before `onunload` runs, so they fail inside
 * `onViewUnloadHook` with "targetView not set". The React editor is still
 * mounted at that point and `updateScene` applies synchronously, so the save
 * that follows in `ExcalidrawView.onClose` no longer contains indicators.
 *
 * @param api Imperative API captured while the view was alive.
 * @returns True when indicators were removed.
 */
export function removeTemporaryElementsNow(api: ExcalidrawAPI | null | undefined): boolean {
    if (!api || api.isDestroyed) return false;
    const all = api.getSceneElementsIncludingDeleted();
    const kept = all.filter((element) => !isTemporary(element));
    if (kept.length === all.length) return false;
    api.updateScene({ elements: kept, captureUpdate: CAPTURE_NEVER });
    return true;
}
