import { normalizeShape, type MindmapPadding, type MindmapShape } from "./metadata";
import type { LogicalElement } from "./groups";

type ExcalidrawImperativeAPI = ReturnType<ExcalidrawAutomate["getExcalidrawAPI"]>;

export interface IndicatorState {
    ids: string[];
    records: Record<string, { id: string; signature: string }>;
}

export interface NodeIndicator {
    logical: LogicalElement;
    parent?: LogicalElement;
    shape?: MindmapShape;
}

interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

function paddedBounds(bounds: Bounds, padding: MindmapPadding): Bounds {
    return {
        x: bounds.x + padding.left,
        y: bounds.y + padding.top,
        width: Math.max(1, bounds.width - padding.left - padding.right),
        height: Math.max(1, bounds.height - padding.top - padding.bottom),
    };
}

interface IndicatorSpec {
    key: string;
    signature: string;
    create: () => string;
}

async function reconcileIndicators(
    ea: ExcalidrawAutomate,
    indicatorState: IndicatorState,
    specs: readonly IndicatorSpec[],
): Promise<void> {
    const scene = ea.getViewElements();
    const desired = new Map(specs.map((spec) => [spec.key, spec]));
    const previousById = new Map(scene.map((element) => [element.id, element]));
    const staleKeys = Object.keys(indicatorState.records).filter((key) => {
        const record = indicatorState.records[key];
        return !desired.has(key) || previousById.get(record.id) === undefined;
    });
    const changedKeys = specs.filter((spec) => {
        const record = indicatorState.records[spec.key];
        return !record || record.signature !== spec.signature;
    }).map((spec) => spec.key);
    const ownedIds = new Set(Object.values(indicatorState.records).map((record) => record.id));
    const unknownTemporary = scene.filter((element) => {
        const data = element.customData as Record<string, unknown> | undefined;
        return data?.isMindmapTemporary === true && !ownedIds.has(element.id);
    });
    const idsToDelete = [...new Set([
        ...staleKeys.map((key) => indicatorState.records[key]?.id),
        ...changedKeys.map((key) => indicatorState.records[key]?.id),
        ...unknownTemporary.map((element) => element.id),
    ].filter((id): id is string => Boolean(id)))];
    if (idsToDelete.length === 0 && changedKeys.length === 0 && unknownTemporary.length === 0) return;

    ea.clear();
    const previous = idsToDelete
        .map((id) => previousById.get(id))
        .filter((element): element is ExcalidrawElement => Boolean(element));
    if (previous.length > 0) {
        ea.copyViewElementsToEAforEditing(previous);
        for (const element of previous) {
            const editable = ea.getElement(element.id);
            if (editable) editable.isDeleted = true;
        }
    }
    const nextRecords: Record<string, { id: string; signature: string }> = {};
    for (const spec of specs) {
        const previousRecord = indicatorState.records[spec.key];
        if (previousRecord && !changedKeys.includes(spec.key) && previousById.has(previousRecord.id)) {
            nextRecords[spec.key] = previousRecord;
            continue;
        }
        nextRecords[spec.key] = { id: spec.create(), signature: spec.signature };
    }
    await ea.addElementsToView(false, false);
    const nextIds = Object.values(nextRecords).map((record) => record.id);
    const topIndex = ea.getViewElements().length;
    for (const id of nextIds.filter((candidate) => !ownedIds.has(candidate))) ea.moveViewElementToZIndex(id, topIndex);
    indicatorState.records = nextRecords;
    indicatorState.ids = nextIds;
    ea.clear();
}

/**
 * Reconciles temporary previews in one unsaved EA transaction when needed.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param indicatorState Mutable temporary indicator registry.
 * @param border Optional border preview.
 * @param padding Border padding.
 * @param root Optional root preview.
 * @param nodes Parsed node previews and their parent relationships.
 */
export async function refreshIndicators(
    ea: ExcalidrawAutomate,
    indicatorState: IndicatorState,
    border: LogicalElement | undefined,
    padding: MindmapPadding,
    root: LogicalElement | undefined,
    nodes: readonly NodeIndicator[] = [],
): Promise<void> {
    const specs: IndicatorSpec[] = [];
    if (border) {
        const bounds = paddedBounds(border.bounds, padding);
        specs.push({
            key: "border",
            signature: JSON.stringify(bounds),
            create: () => {
                ea.style.strokeColor = "#e03131";
                ea.style.strokeStyle = "dashed";
                ea.style.strokeWidth = 2;
                ea.style.fillStyle = "solid";
                ea.style.opacity = 100;
                const id = ea.addRect(bounds.x, bounds.y, bounds.width, bounds.height);
                ea.addAppendUpdateCustomData(id, { isMindmapTemporary: true });
                return id;
            },
        });
    }
    if (root) {
        const rootData = root.anchor.customData as Record<string, unknown> | undefined;
        const rootShape = rootData?.mindmapShape !== undefined
            ? normalizeShape(rootData.mindmapShape)
            : root.anchor.type === "ellipse" ? "ellipse" : "rectangle";
        specs.push({
            key: "root",
            signature: JSON.stringify([rootShape, root.bounds]),
            create: () => {
                ea.style.strokeColor = "#1971c2";
                ea.style.strokeStyle = "dashed";
                ea.style.strokeWidth = 2;
                const id = rootShape === "ellipse"
                    ? ea.addEllipse(root.bounds.x, root.bounds.y, root.bounds.width, root.bounds.height)
                    : ea.addRect(root.bounds.x, root.bounds.y, root.bounds.width, root.bounds.height);
                ea.addAppendUpdateCustomData(id, { isMindmapTemporary: true });
                return id;
            },
        });
    }
    for (const node of nodes) {
        const shape = node.shape ?? (node.logical.anchor.type === "ellipse" ? "ellipse" : "rectangle");
        specs.push({
            key: `node:${node.logical.anchor.id}`,
            signature: JSON.stringify([shape, node.logical.bounds]),
            create: () => {
                ea.style.strokeColor = "#2f9e44";
                ea.style.strokeStyle = "dashed";
                ea.style.strokeWidth = 2;
                const id = shape === "ellipse"
                    ? ea.addEllipse(node.logical.bounds.x, node.logical.bounds.y, node.logical.bounds.width, node.logical.bounds.height)
                    : ea.addRect(node.logical.bounds.x, node.logical.bounds.y, node.logical.bounds.width, node.logical.bounds.height);
                ea.addAppendUpdateCustomData(id, { isMindmapTemporary: true });
                return id;
            },
        });
        if (node.parent) {
            const child = centerOf(node.logical);
            const parent = centerOf(node.parent);
            const directionX = parent.x - child.x;
            const directionY = parent.y - child.y;
            const length = Math.max(Math.sqrt(directionX * directionX + directionY * directionY), 1);
            const arrowLength = Math.min(60, length / 2);
            const points = [
                [child.x, child.y],
                [child.x + directionX / length * arrowLength, child.y + directionY / length * arrowLength],
            ] as [number, number][];
            specs.push({
                key: `arrow:${node.logical.anchor.id}`,
                signature: JSON.stringify(points),
                create: () => {
                    const arrow = ea.addArrow(points, { endArrowHead: "arrow" });
                    ea.addAppendUpdateCustomData(arrow, { isMindmapTemporary: true });
                    return arrow;
                },
            });
        }
    }
    await reconcileIndicators(ea, indicatorState, specs);
}

function centerOf(logical: LogicalElement): { x: number; y: number } {
    return {
        x: logical.bounds.x + logical.bounds.width / 2,
        y: logical.bounds.y + logical.bounds.height / 2,
    };
}

/**
 * Deletes all temporary indicators owned by the current runtime.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param indicatorState Mutable temporary indicator registry.
 */
export async function clearIndicators(
    ea: ExcalidrawAutomate,
    indicatorState: IndicatorState,
    api?: ExcalidrawImperativeAPI,
): Promise<void> {
    const scene = api?.getSceneElementsIncludingDeleted() ?? ea.getViewElements();
    const temporary = scene.filter((element) => {
        const data = element.customData as Record<string, unknown> | undefined;
        return data?.isMindmapTemporary === true;
    });
    if (temporary.length === 0) {
        indicatorState.records = {};
        indicatorState.ids = [];
        return;
    }
    if (api) {
        api.updateScene({
            elements: scene.filter((element) => !temporary.some((candidate) => candidate.id === element.id)),
        });
    } else {
        ea.deleteViewElements(temporary);
    }
    indicatorState.records = {};
    indicatorState.ids = [];
}