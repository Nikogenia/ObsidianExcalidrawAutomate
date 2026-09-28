import type { MindmapPadding, MindmapShape } from "./metadata";
import type { LogicalElement } from "./groups";

export interface IndicatorState {
    ids: string[];
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

async function replaceIndicators(
    ea: ExcalidrawAutomate,
    indicatorState: IndicatorState,
    create: () => string[],
): Promise<void> {
    ea.clear();
    const previous = ea
        .getViewElements()
        .filter((element) => indicatorState.ids.includes(element.id) || (element.customData as Record<string, unknown> | undefined)?.isMindmapTemporary === true);
    if (previous.length > 0) {
        ea.copyViewElementsToEAforEditing(previous);
        for (const element of previous) {
            const editable = ea.getElement(element.id);
            if (editable) editable.isDeleted = true;
        }
    }
    indicatorState.ids = create();
    await ea.addElementsToView(false, false);
    const topIndex = ea.getViewElements().length;
    for (const id of indicatorState.ids) ea.moveViewElementToZIndex(id, topIndex);
    ea.clear();
}

/**
 * Rebuilds all temporary previews in one unsaved EA transaction.
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
    await replaceIndicators(ea, indicatorState, () => {
        const ids: string[] = [];
        if (border) {
            const bounds = paddedBounds(border.bounds, padding);
            ea.style.strokeColor = "#e03131";
            ea.style.strokeStyle = "dashed";
            ea.style.strokeWidth = 2;
            ea.style.fillStyle = "solid";
            ea.style.opacity = 100;
            const id = ea.addRect(bounds.x, bounds.y, bounds.width, bounds.height);
            ea.addAppendUpdateCustomData(id, { isMindmapTemporary: true });
            ids.push(id);
        }
        if (root) {
            ea.style.strokeColor = "#1971c2";
            ea.style.strokeStyle = "dashed";
            ea.style.strokeWidth = 2;
            const rootShape = (root.anchor.customData as Record<string, unknown> | undefined)?.mindmapShape === "rectangle"
                ? "rectangle"
                : "ellipse";
            const id = rootShape === "ellipse"
                ? ea.addEllipse(root.bounds.x, root.bounds.y, root.bounds.width, root.bounds.height)
                : ea.addRect(root.bounds.x, root.bounds.y, root.bounds.width, root.bounds.height);
            ea.addAppendUpdateCustomData(id, { isMindmapTemporary: true });
            ids.push(id);
        }
        for (const node of nodes) {
            ea.style.strokeColor = "#2f9e44";
            ea.style.strokeStyle = "dashed";
            ea.style.strokeWidth = 2;
            const shape = node.shape ?? (node.logical.anchor.type === "ellipse" ? "ellipse" : "rectangle");
            const id = shape === "ellipse"
                ? ea.addEllipse(node.logical.bounds.x, node.logical.bounds.y, node.logical.bounds.width, node.logical.bounds.height)
                : ea.addRect(node.logical.bounds.x, node.logical.bounds.y, node.logical.bounds.width, node.logical.bounds.height);
            ea.addAppendUpdateCustomData(id, { isMindmapTemporary: true });
            ids.push(id);
            if (node.parent) {
                const child = centerOf(node.logical);
                const parent = centerOf(node.parent);
                const directionX = parent.x - child.x;
                const directionY = parent.y - child.y;
                const length = Math.max(Math.sqrt(directionX * directionX + directionY * directionY), 1);
                const arrowLength = Math.min(24, length / 3);
                const arrow = ea.addArrow([
                    [child.x, child.y],
                    [child.x + directionX / length * arrowLength, child.y + directionY / length * arrowLength],
                ], { endArrowHead: "arrow" });
                ea.addAppendUpdateCustomData(arrow, { isMindmapTemporary: true });
                ids.push(arrow);
            }
        }
        return ids;
    });
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
): Promise<void> {
    await replaceIndicators(ea, indicatorState, () => []);
}