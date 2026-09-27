export interface LogicalElement {
    anchor: ExcalidrawElement;
    elements: ExcalidrawElement[];
    bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}

/**
 * Resolves a canvas selection to one logical element or group.
 *
 * EA exposes group members as individual elements sharing groupIds. A selection
 * is valid when it contains one maximum group; the full group is then resolved
 * from the scene and its largest element is used as the stable metadata anchor.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param selection Current canvas selection.
 * @param scene Current scene elements.
 * @returns One logical element, or undefined for an ambiguous selection.
 */
export function resolveLogicalSelection(
    ea: ExcalidrawAutomate,
    selection: readonly ExcalidrawElement[],
    scene: readonly ExcalidrawElement[],
): LogicalElement | undefined {
    if (selection.length === 0) return undefined;
    const selected = [...selection];
    const maximumGroups = ea.getMaximumGroups(selected);
    if (maximumGroups.length > 1) return undefined;

    const commonGroup = ea.getCommonGroupForElements(selected);
    if (selected.length > 1 && !commonGroup) return undefined;
    const first = selected[0];
    const members = ea.getElementsInTheSameGroupWithElement(first, scene);
    const elements = members.length > 0 ? members : [first];
    const anchor = ea.getLargestElement(elements);
    const bounds = ea.getBoundingBox(elements);
    return {
        anchor,
        elements,
        bounds: {
            x: bounds.topX,
            y: bounds.topY,
            width: bounds.width,
            height: bounds.height,
        },
    };
}

/**
 * Resolves a persisted anchor and expands it to its current group members.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param anchor Persisted anchor element.
 * @param scene Current scene elements.
 * @returns The logical element represented by the anchor.
 */
export function resolveAnchor(
    ea: ExcalidrawAutomate,
    anchor: ExcalidrawElement | undefined,
    scene: readonly ExcalidrawElement[],
): LogicalElement | undefined {
    if (!anchor) return undefined;
    return resolveLogicalSelection(ea, [anchor], scene);
}