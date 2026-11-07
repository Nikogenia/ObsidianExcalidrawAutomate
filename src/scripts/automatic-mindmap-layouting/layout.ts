import { containerIdOf, resolveAnchorId } from "./groups";
import { edgeEndpoints, edgeMetadata, lineEndpoints, reshapeLine, type EdgeBinding, type LineGeometry, type Point } from "./edges";
import { graphToScenePoint, type ParsedMindmap } from "./parser";
import { CAPTURE_NEVER } from "./scene";

type CaptureUpdate = NonNullable<Parameters<ExcalidrawAutomate["addElementsToView"]>[4]>;

interface Shift {
    dx: number;
    dy: number;
}

interface LineChange {
    binding: EdgeBinding;
    geometry: LineGeometry;
}

const MIN_CHANGE = 0.01;

function absolutePoints(element: ExcalidrawElement): Point[] {
    const points = (element as ExcalidrawElement & { points: readonly (readonly [number, number])[] }).points;
    return points.map(([x, y]) => ({ x: element.x + x, y: element.y + y }));
}

/** Collects the offset of every node member; tracked lines are placed separately. */
function nodeShifts(
    ea: ExcalidrawAutomate,
    mindmap: ParsedMindmap,
    scene: readonly ExcalidrawElement[],
    lineIds: ReadonlySet<string>,
): Map<string, Shift> {
    const shifts = new Map<string, Shift>();
    for (const node of mindmap.graph.getAllNodes()) {
        const logical = resolveAnchorId(ea, node.id, scene);
        if (!logical) continue;
        const target = graphToScenePoint(node.pos, mindmap.coordinateSpace);
        const dx = target.x - (logical.bounds.x + logical.bounds.width / 2);
        const dy = target.y - (logical.bounds.y + logical.bounds.height / 2);
        if (Math.abs(dx) < MIN_CHANGE && Math.abs(dy) < MIN_CHANGE) continue;
        for (const member of logical.elements) {
            if (!lineIds.has(member.id)) shifts.set(member.id, { dx, dy });
        }
    }
    return shifts;
}

/** Computes the new geometry of every tracked line and shifts its label by the moved midpoint. */
function lineChanges(
    mindmap: ParsedMindmap,
    scene: readonly ExcalidrawElement[],
    shifts: Map<string, Shift>,
): LineChange[] {
    const byId = new Map(scene.map((element) => [element.id, element]));
    const changes: LineChange[] = [];
    for (const binding of mindmap.edges.values()) {
        const line = byId.get(binding.lineId);
        const edge = mindmap.graph.getEdge(binding.childId);
        const current = line && lineEndpoints(line);
        if (!line || !edge || !current) continue;
        const ends = edgeEndpoints(mindmap.graph, edge, binding);
        const parent = graphToScenePoint(ends.parent, mindmap.coordinateSpace);
        const child = graphToScenePoint(ends.child, mindmap.coordinateSpace);
        const [start, end] = binding.parentEnd === "start" ? [parent, child] : [child, parent];
        changes.push({ binding, geometry: reshapeLine(absolutePoints(line), start, end) });
        const dx = (start.x + end.x - current.start.x - current.end.x) / 2;
        const dy = (start.y + end.y - current.start.y - current.end.y) / 2;
        for (const element of scene) {
            if (containerIdOf(element) === binding.lineId) shifts.set(element.id, { dx, dy });
        }
    }
    return changes;
}

/**
 * Writes a graph's layout back to the canvas in one transaction.
 *
 * Nodes move as complete logical elements, keeping their size, IDs, and
 * metadata. Tracked lines are redrawn from the anchors (`edgeEndpoints`) and
 * their `mindmapEdge` metadata receives the current offsets. Graph positions
 * are converted with the mindmap's coordinate space. The caller must run this
 * inside the workbench transaction queue, and the layout runner must keep its
 * `ParsedMindmap` while a run is active, because `hydrate` builds a new graph
 * after every scene change.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param mindmap Graph, bindings, and coordinate space to write.
 * @param captureUpdate Undo capture; defaults to not undoable (rollback covers runs).
 */
export async function writeGraphToScene(
    ea: ExcalidrawAutomate,
    mindmap: ParsedMindmap,
    captureUpdate: CaptureUpdate = CAPTURE_NEVER,
): Promise<void> {
    const scene = ea.getViewElements();
    const lineIds = new Set([...mindmap.edges.values()].map((binding) => binding.lineId));
    const shifts = nodeShifts(ea, mindmap, scene, lineIds);
    const lines = lineChanges(mindmap, scene, shifts);
    const changedIds = new Set([...shifts.keys(), ...lines.map(({ binding }) => binding.lineId)]);
    const changed = scene.filter((element) => changedIds.has(element.id));
    if (changed.length === 0) return;
    ea.clear();
    try {
        ea.copyViewElementsToEAforEditing(changed);
        for (const [id, { dx, dy }] of shifts) {
            const editable = ea.getElement(id);
            if (!editable) continue;
            editable.x += dx;
            editable.y += dy;
        }
        for (const { binding, geometry } of lines) {
            Object.assign(ea.getElement(binding.lineId), geometry);
            const edge = mindmap.graph.getEdge(binding.childId)!;
            ea.addAppendUpdateCustomData(binding.lineId, { mindmapEdge: edgeMetadata(edge, binding) });
        }
        await ea.addElementsToView(false, false, false, false, captureUpdate);
    } finally {
        ea.clear();
    }
}
