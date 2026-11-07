import type { ParsedMindmap } from "./parser";

export type MindmapShape = "ellipse" | "rectangle";
export type LineEnd = "start" | "end";

export interface MindmapPadding {
    top: number;
    left: number;
    bottom: number;
    right: number;
}

export interface MindmapRuntimeState {
    borderId?: string;
    padding: MindmapPadding;
    rootId?: string;
    rootShape: MindmapShape;
    connectionDistance: number;
    mindmap?: ParsedMindmap;
}

/** Persistent `mindmapEdge` value on the line element that draws an edge. */
export type MindmapEdgeMetadata = {
    parentId: string;
    childId: string;
    parentEnd: LineEnd;
    parentOffset: { x: number; y: number };
    childOffset: { x: number; y: number };
    parentGap: number;
    childGap: number;
};

export const DEFAULT_PADDING: MindmapPadding = {
    top: 90,
    left: 100,
    bottom: 110,
    right: 100,
};

export const DEFAULT_CONNECTION_DISTANCE = 15;

export const DEFAULT_RUNTIME_STATE: MindmapRuntimeState = {
    padding: DEFAULT_PADDING,
    rootShape: "ellipse",
    connectionDistance: DEFAULT_CONNECTION_DISTANCE,
};

/**
 * Reads a value from Excalidraw custom data without trusting its runtime shape.
 *
 * @param value Element custom data.
 * @param key Custom data key.
 * @returns The value when the key exists, otherwise undefined.
 */
export function getCustomDataValue(
    value: Record<string, unknown> | undefined,
    key: string,
): unknown {
    return value?.[key];
}

/**
 * Normalizes a persisted mindmap shape to the two public script values.
 *
 * @param value Persisted shape value.
 * @returns A normalized shape, defaulting to ellipse.
 */
export function normalizeShape(value: unknown): MindmapShape {
    return value === "rectangle" || value === "rect" ? "rectangle" : "ellipse";
}

/**
 * Returns the effective node shape of an anchor element.
 *
 * Persisted `mindmapShape` metadata wins. Without metadata the Excalidraw type
 * decides: `ellipse` stays an ellipse and every other element type (rectangle,
 * diamond, text, image, ...) is treated as a rectangle. Do not pass the raw
 * element type to `normalizeShape`, which maps unknown values to ellipse.
 *
 * @param element Anchor element.
 * @returns The normalized shape.
 */
export function shapeOf(element: ExcalidrawElement): MindmapShape {
    const persisted = getCustomDataValue(element.customData as Record<string, unknown> | undefined, "mindmapShape");
    if (persisted !== undefined) return normalizeShape(persisted);
    return element.type === "ellipse" ? "ellipse" : "rectangle";
}

/**
 * Clamps a numeric setting and rounds it to the integer contract.
 *
 * @param value Candidate number.
 * @param minimum Inclusive lower bound.
 * @param maximum Inclusive upper bound.
 * @param fallback Value used for malformed input.
 * @returns A valid integer in the requested range.
 */
export function clampInteger(
    value: unknown,
    minimum: number,
    maximum: number,
    fallback: number,
): number {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(numeric)));
}

/**
 * Reads valid border padding from custom data.
 *
 * @param value Element custom data.
 * @returns Valid padding or the default padding.
 */
export function readPadding(value: Record<string, unknown> | undefined): MindmapPadding {
    const padding = getCustomDataValue(value, "mindmapPadding");
    if (!padding || typeof padding !== "object") return { ...DEFAULT_PADDING };
    const candidate = padding as Record<string, unknown>;
    return {
        top: clampInteger(candidate.top, -120, 120, DEFAULT_PADDING.top),
        left: clampInteger(candidate.left, -120, 120, DEFAULT_PADDING.left),
        bottom: clampInteger(candidate.bottom, -120, 120, DEFAULT_PADDING.bottom),
        right: clampInteger(candidate.right, -120, 120, DEFAULT_PADDING.right),
    };
}

/**
 * Finds the first valid configured border and root in stable scene order.
 *
 * @param elements Current non-deleted scene elements.
 * @returns Runtime configuration loaded from element metadata.
 */
export function loadRuntimeState(elements: readonly ExcalidrawElement[]): MindmapRuntimeState {
    const state: MindmapRuntimeState = { ...DEFAULT_RUNTIME_STATE };

    for (const element of elements) {
        const customData = element.customData as Record<string, unknown> | undefined;
        if (!state.borderId && getCustomDataValue(customData, "isMindmapBorder") === true) {
            state.borderId = element.id;
            state.padding = readPadding(customData);
        }
        if (getCustomDataValue(customData, "isMindmapRoot") === true) {
            if (!state.rootId) {
                state.rootId = element.id;
                state.rootShape = normalizeShape(getCustomDataValue(customData, "mindmapShape"));
                state.connectionDistance = clampInteger(
                    getCustomDataValue(customData, "mindmapConnectionDistance"),
                    1,
                    300,
                    DEFAULT_CONNECTION_DISTANCE,
                );
            }
        }
    }

    return state;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function readVector(value: unknown): { x: number; y: number } | undefined {
    const candidate = value as { x?: unknown; y?: unknown } | null | undefined;
    return isFiniteNumber(candidate?.x) && isFiniteNumber(candidate?.y) ? { x: candidate.x, y: candidate.y } : undefined;
}

/**
 * Reads and validates the edge metadata of a line element.
 *
 * @param element Scene element.
 * @returns The metadata, or undefined when the element tracks no valid edge.
 */
export function readEdgeMetadata(element: ExcalidrawElement): MindmapEdgeMetadata | undefined {
    const data = element.customData as Record<string, unknown> | undefined;
    if (data?.isMindmapEdge !== true) return undefined;
    const edge = data.mindmapEdge as Partial<Record<keyof MindmapEdgeMetadata, unknown>> | undefined;
    const parentOffset = readVector(edge?.parentOffset);
    const childOffset = readVector(edge?.childOffset);
    if (!edge || !parentOffset || !childOffset) return undefined;
    const { parentId, childId, parentEnd, parentGap, childGap } = edge;
    if (typeof parentId !== "string" || typeof childId !== "string") return undefined;
    if ((parentEnd !== "start" && parentEnd !== "end") || !isFiniteNumber(parentGap) || !isFiniteNumber(childGap)) return undefined;
    return { parentId, childId, parentEnd, parentOffset, childOffset, parentGap, childGap };
}
