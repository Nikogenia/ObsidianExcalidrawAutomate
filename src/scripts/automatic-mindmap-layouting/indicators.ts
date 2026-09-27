import type { MindmapPadding } from "./metadata";
import type { LogicalElement } from "./groups";

export interface IndicatorState {
    ids: string[];
}

export interface NodeIndicator {
    logical: LogicalElement;
    parent?: LogicalElement;
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
        .filter((element) => indicatorState.ids.includes(element.id));
    if (previous.length > 0) {
        ea.copyViewElementsToEAforEditing(previous);
        for (const element of previous) {
            const editable = ea.getElement(element.id);
            if (editable) editable.isDeleted = true;
        }
    }
    indicatorState.ids = create();
    await ea.addElementsToView(false, false);
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
            const id = root.anchor.type === "ellipse"
                ? ea.addEllipse(root.bounds.x, root.bounds.y, root.bounds.width, root.bounds.height)
                : ea.addRect(root.bounds.x, root.bounds.y, root.bounds.width, root.bounds.height);
            ea.addAppendUpdateCustomData(id, { isMindmapTemporary: true });
            ids.push(id);
        }
        for (const node of nodes) {
            ea.style.strokeColor = "#2f9e44";
            ea.style.strokeStyle = "dashed";
            ea.style.strokeWidth = 2;
            const id = node.logical.anchor.type === "ellipse"
                ? ea.addEllipse(node.logical.bounds.x, node.logical.bounds.y, node.logical.bounds.width, node.logical.bounds.height)
                : ea.addRect(node.logical.bounds.x, node.logical.bounds.y, node.logical.bounds.width, node.logical.bounds.height);
            ea.addAppendUpdateCustomData(id, { isMindmapTemporary: true });
            ids.push(id);
            if (node.parent) {
                const child = centerOf(node.logical);
                const parent = centerOf(node.parent);
                const arrow = ea.addArrow([[child.x, child.y], [parent.x, parent.y]], { endArrowHead: "arrow" });
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
 * Replaces the temporary red border preview in one EA transaction.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param indicatorState Mutable temporary indicator registry.
 * @param border Border element whose bounds are previewed.
 * @param padding Padded border settings.
 */
export async function refreshBorderIndicator(
    ea: ExcalidrawAutomate,
    indicatorState: IndicatorState,
    border: LogicalElement | undefined,
    padding: MindmapPadding,
): Promise<void> {
    await replaceIndicators(ea, indicatorState, () => {
        if (!border) return [];
        const bounds = paddedBounds(border.bounds, padding);
        ea.style.strokeColor = "#e03131";
        ea.style.strokeStyle = "dashed";
        ea.style.strokeWidth = 2;
        ea.style.fillStyle = "solid";
        ea.style.opacity = 100;
        const id = ea.addRect(bounds.x, bounds.y, bounds.width, bounds.height);
        ea.addAppendUpdateCustomData(id, { isMindmapTemporary: true });
        return [id];
    });
}

/**
 * Replaces the temporary blue root preview.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param indicatorState Mutable temporary indicator registry.
 * @param root Root element whose bounds are previewed.
 */
export async function refreshRootIndicator(
    ea: ExcalidrawAutomate,
    indicatorState: IndicatorState,
    root: LogicalElement | undefined,
): Promise<void> {
    await replaceIndicators(ea, indicatorState, () => {
        if (!root) return [];
        ea.style.strokeColor = "#1971c2";
        ea.style.strokeStyle = "dashed";
        ea.style.strokeWidth = 2;
        ea.style.fillStyle = "solid";
        ea.style.opacity = 100;
        const id = root.anchor.type === "ellipse"
            ? ea.addEllipse(root.bounds.x, root.bounds.y, root.bounds.width, root.bounds.height)
            : ea.addRect(root.bounds.x, root.bounds.y, root.bounds.width, root.bounds.height);
        ea.addAppendUpdateCustomData(id, { isMindmapTemporary: true });
        return [id];
    });
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