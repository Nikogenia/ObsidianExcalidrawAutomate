import type { TreeGraph } from "./core/graph/types";

export type MindmapShape = "ellipse" | "rectangle";

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
    graph?: TreeGraph;
}

export const DEFAULT_PADDING: MindmapPadding = {
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
};

export const DEFAULT_RUNTIME_STATE: MindmapRuntimeState = {
    padding: DEFAULT_PADDING,
    rootShape: "ellipse",
    connectionDistance: 50,
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
        top: clampInteger(candidate.top, -120, 120, 0),
        left: clampInteger(candidate.left, -120, 120, 0),
        bottom: clampInteger(candidate.bottom, -120, 120, 0),
        right: clampInteger(candidate.right, -120, 120, 0),
    };
}

/**
 * Finds the first valid configured border and root in stable scene order.
 *
 * @param elements Current non-deleted scene elements.
 * @returns Runtime configuration loaded from element metadata.
 */
export function loadRuntimeState(elements: readonly ExcalidrawElement[]): MindmapRuntimeState {
    const state: MindmapRuntimeState = {
        padding: { ...DEFAULT_PADDING },
        rootShape: "ellipse",
        connectionDistance: 50,
    };

    for (const element of elements) {
        const customData = element.customData as Record<string, unknown> | undefined;
        if (!state.borderId && getCustomDataValue(customData, "isMindmapBorder") === true) {
            state.borderId = element.id;
            state.padding = readPadding(customData);
        }
        if (!state.rootId && getCustomDataValue(customData, "isMindmapRoot") === true) {
            state.rootId = element.id;
            state.rootShape = normalizeShape(getCustomDataValue(customData, "mindmapShape"));
            state.connectionDistance = clampInteger(
                getCustomDataValue(customData, "mindmapConnectionDistance"),
                1,
                300,
                50,
            );
        }
    }

    return state;
}