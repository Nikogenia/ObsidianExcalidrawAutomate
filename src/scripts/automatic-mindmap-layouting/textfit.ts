import { containerIdOf } from "./groups";
import { CAPTURE_IMMEDIATELY } from "./scene";

type TextElement = ExcalidrawElement & {
    type: "text";
    text: string;
    originalText: string;
    fontSize: number;
    fontFamily: number;
    lineHeight: number;
    textAlign: string;
    autoResize?: boolean;
};

type Lib = Window["ExcalidrawLib"];
type FontString = Parameters<Lib["wrapText"]>[1];

export interface TextFitResult {
    fitted: number;
    /** Already as narrow as possible, or auto-resizing (Excalidraw keeps those minimal itself). */
    unchanged: number;
    /** Container-bound text and texts whose line breaks could not be reproduced. */
    skipped: number;
}

interface WidthChange {
    id: string;
    width: number;
    dx: number;
}

/** Wider candidates tried above the measured width before giving up. */
const MAX_EXTRA_WIDTH = 4;
const MIN_SHRINK = 0.5;

function isText(element: ExcalidrawElement): element is TextElement {
    return element.type === "text";
}

/**
 * Finds the narrowest width at which Excalidraw wraps the text into exactly its
 * current lines.
 *
 * Excalidraw re-wraps `originalText` at the element width whenever a fixed-width
 * text is edited or refreshed (`refreshTextDimensions` -> `wrapText`). The
 * widest current line is a lower bound; because greedy wrapping at a width
 * between that line and the old width reproduces the same lines, the measured
 * width normally passes immediately. Each candidate is verified with
 * Excalidraw's own `wrapText`, so rounding in the measurement cannot change the
 * line breaks; a few slightly wider candidates are tried before giving up.
 */
function minimalWidth(lib: Lib, element: TextElement): number | undefined {
    const font = lib.getFontString({ fontSize: element.fontSize, fontFamily: element.fontFamily as never }) as FontString;
    const lines = element.text.split("\n");
    const widest = Math.max(...lines.map((line) => lib.measureText(line, font, element.lineHeight).width));
    for (let extra = 0; extra <= MAX_EXTRA_WIDTH; extra++) {
        const width = Math.ceil(widest) + extra;
        if (width > element.width) break;
        if (lib.wrapText(element.originalText, font, width) === element.text) return width;
    }
    return undefined;
}

/** Keeps the lines in place: centered and right-aligned lines are laid out relative to the width. */
function alignmentShift(element: TextElement, width: number): number {
    const shrink = element.width - width;
    if (element.textAlign === "center") return shrink / 2;
    if (element.textAlign === "right") return shrink;
    return 0;
}

/**
 * Reduces the width of the given free-standing text elements to the minimum
 * that keeps their line breaks and appearance, in one undoable transaction.
 *
 * Container-bound text is skipped (its width follows the container), and
 * auto-resizing text is already minimal.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param elements Candidate elements, for example the resolved selection.
 * @returns Counts of fitted, unchanged, and skipped text elements.
 */
export async function fitTextWidths(ea: ExcalidrawAutomate, elements: readonly ExcalidrawElement[]): Promise<TextFitResult> {
    const lib = window.ExcalidrawLib;
    const result: TextFitResult = { fitted: 0, unchanged: 0, skipped: 0 };
    const changes: WidthChange[] = [];
    for (const element of elements) {
        if (!isText(element)) continue;
        if (containerIdOf(element) !== undefined) {
            result.skipped++;
            continue;
        }
        if (element.autoResize !== false) {
            result.unchanged++;
            continue;
        }
        const width = minimalWidth(lib, element);
        if (width === undefined) result.skipped++;
        else if (element.width - width < MIN_SHRINK) result.unchanged++;
        else changes.push({ id: element.id, width, dx: alignmentShift(element, width) });
    }
    if (changes.length === 0) return result;
    const byId = new Set(changes.map(({ id }) => id));
    const current = ea.getViewElements().filter((element) => byId.has(element.id));
    ea.clear();
    try {
        ea.copyViewElementsToEAforEditing(current);
        for (const { id, width, dx } of changes) {
            const editable = ea.getElement(id);
            if (!editable) continue;
            editable.width = width;
            editable.x += dx;
            result.fitted++;
        }
        await ea.addElementsToView(false, false, false, false, CAPTURE_IMMEDIATELY);
    } finally {
        ea.clear();
    }
    return result;
}
