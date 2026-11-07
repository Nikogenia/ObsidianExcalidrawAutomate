import p5 from "p5";
import { TreeEdgeGraph } from "./core/graph/TreeEdgeGraph";
import type { TreeNode } from "./core/graph/types";
import { isFixedFlagged, readEdgeMetadata, shapeOf, type LineEnd, type MindmapPadding } from "./metadata";
import { containerIdOf, resolveAnchor, type LogicalElement } from "./groups";
import { bindLineToEdge, lineEndpoints, type EdgeBinding, type Point } from "./edges";

export interface ParsedMindmap {
    graph: TreeEdgeGraph;
    nodes: LogicalElement[];
    /** Line element of each edge, keyed by child ID like `TreeEdgeGraph.edges`. */
    edges: Map<string, EdgeBinding>;
    /** Anchor IDs of fixed nodes (tree nodes and isolated fixed elements), in scene order. */
    fixedIds: string[];
    coordinateSpace: CoordinateSpace;
}

/** Default anchor region, matching the default of `TreeEdgeGraph` and the Nikogenia algorithm. */
const MAX_OFFSET_RATIO = 0.5;

export interface CoordinateSpace {
    origin: Point;
    width: number;
    height: number;
}

export function sceneToGraphPoint(point: Point, coordinateSpace: CoordinateSpace): Point {
    return {
        x: point.x - coordinateSpace.origin.x,
        y: point.y - coordinateSpace.origin.y,
    };
}

export function graphToScenePoint(point: Point, coordinateSpace: CoordinateSpace): Point {
    return {
        x: point.x + coordinateSpace.origin.x,
        y: point.y + coordinateSpace.origin.y,
    };
}

function customData(element: ExcalidrawElement): Record<string, unknown> {
    return (element.customData as Record<string, unknown> | undefined) ?? {};
}

function isTemporaryElement(element: ExcalidrawElement): boolean {
    return customData(element).isMindmapTemporary === true;
}

/**
 * Resolves every element flagged `isMindmapFixed` to its logical element.
 *
 * Lines, arrows, and members of the border are never fixed nodes (the UI does
 * not flag them, and a stale flag is ignored here). Several flagged members of
 * one group count once.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param scene Current scene elements.
 * @param border Configured border, if any.
 * @returns Fixed logical elements keyed by anchor ID, in scene order.
 */
export function resolveFixedElements(
    ea: ExcalidrawAutomate,
    scene: readonly ExcalidrawElement[],
    border: LogicalElement | undefined,
): Map<string, LogicalElement> {
    const borderIds = new Set(border?.elements.map((element) => element.id));
    const fixed = new Map<string, LogicalElement>();
    for (const element of scene) {
        if (!isFixedFlagged(element) || isTemporaryElement(element) || borderIds.has(element.id)) continue;
        if (element.type === "line" || element.type === "arrow") continue;
        const logical = resolveAnchor(ea, element, scene);
        if (logical && !logical.elements.some((member) => borderIds.has(member.id))) fixed.set(logical.anchor.id, logical);
    }
    return fixed;
}

/**
 * Marks fixed elements in the graph: a fixed tree node keeps its place in the
 * tree, every other fixed element becomes an isolated node without parent edge
 * (`TreeNode.fixed`, e.g. a logo reserving its space).
 */
function addFixedNodes(graph: TreeEdgeGraph, fixed: ReadonlyMap<string, LogicalElement>, space: CoordinateSpace): string[] {
    for (const [id, logical] of fixed) {
        if (graph.getNode(id)) graph.setFixed(id, true);
        else graph.addNode({ ...nodeFor(logical, undefined, space), fixed: true });
    }
    return [...fixed.keys()];
}

function center(logical: LogicalElement): Point {
    return {
        x: logical.bounds.x + logical.bounds.width / 2,
        y: logical.bounds.y + logical.bounds.height / 2,
    };
}

function distanceToBoundary(point: Point, logical: LogicalElement): number {
    const position = center(logical);
    const dx = point.x - position.x;
    const dy = point.y - position.y;
    if (shapeOf(logical.anchor) === "ellipse") {
        const radiusX = Math.max(logical.bounds.width / 2, 1);
        const radiusY = Math.max(logical.bounds.height / 2, 1);
        const normalizedDistance = Math.sqrt((dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY));
        const boundary = Math.sqrt((dx * dx) + (dy * dy)) / Math.max(normalizedDistance, 1e-6);
        return Math.abs(Math.sqrt((dx * dx) + (dy * dy)) - boundary);
    }
    const distanceX = Math.max(Math.abs(dx) - logical.bounds.width / 2, 0);
    const distanceY = Math.max(Math.abs(dy) - logical.bounds.height / 2, 0);
    return Math.sqrt(distanceX * distanceX + distanceY * distanceY);
}

function isLoop(candidateId: string, parentId: string, parentById: Map<string, string | undefined>): boolean {
    let current: string | undefined = parentId;
    while (current) {
        if (current === candidateId) return true;
        current = parentById.get(current);
    }
    return false;
}

interface Candidate {
    logical: LogicalElement;
    order: number;
}

/**
 * Resolves every element that may become a node exactly once per parse.
 * Lines, arrows, and container-bound text are never candidates; a group is
 * represented once, by its anchor.
 */
function nodeCandidates(scene: readonly ExcalidrawElement[], ea: ExcalidrawAutomate): Candidate[] {
    const candidates: Candidate[] = [];
    scene.forEach((element, order) => {
        if (element.type === "line" || element.type === "arrow" || containerIdOf(element) !== undefined) return;
        const logical = resolveAnchor(ea, element, scene);
        if (logical && logical.anchor.id === element.id) candidates.push({ logical, order });
    });
    return candidates;
}

/**
 * Returns the eligible element nearest to a line endpoint.
 *
 * Already queued elements stay in the candidate set on purpose. Excluding them
 * would make a line back to an already parsed node (for example the edge to the
 * parent) resolve to the next-nearest unrelated element. The caller rejects a
 * queued result instead.
 */
function nearestCandidate(
    endpoint: Point,
    candidates: readonly Candidate[],
    connectionDistance: number,
): LogicalElement | undefined {
    let best: { logical: LogicalElement; distance: number; order: number } | undefined;
    for (const { logical, order } of candidates) {
        const distance = distanceToBoundary(endpoint, logical);
        if (distance > connectionDistance) continue;
        if (!best || distance < best.distance || (distance === best.distance && order < best.order)) {
            best = { logical, distance, order };
        }
    }
    return best?.logical;
}

function nodeFor(logical: LogicalElement, parentId: string | undefined, space: CoordinateSpace): TreeNode {
    const point = center(logical);
    const graphPoint = sceneToGraphPoint(point, space);
    return {
        id: logical.anchor.id,
        ...(parentId ? { parentId } : {}),
        children: [],
        pos: new p5.Vector(graphPoint.x, graphPoint.y),
        shape: shapeOf(logical.anchor),
        width: logical.bounds.width,
        height: logical.bounds.height,
    };
}

function graphDimensions(border: LogicalElement, padding: MindmapPadding): { width: number; height: number } {
    return {
        width: Math.max(1, border.bounds.width - padding.left - padding.right),
        height: Math.max(1, border.bounds.height - padding.top - padding.bottom),
    };
}

function coordinateSpace(border: LogicalElement, padding: MindmapPadding): CoordinateSpace {
    const dimensions = graphDimensions(border, padding);
    return {
        origin: {
            x: border.bounds.x + padding.left,
            y: border.bounds.y + padding.top,
        },
        ...dimensions,
    };
}


/**
 * Reconstructs a previously parsed graph from persisted parent/children metadata.
 * The metadata is traversed breadth-first so TreeGraph receives parents first.
 * Fixed elements are added afterwards (`addFixedNodes`).
 */
export function loadMindmapFromMetadata(
    ea: ExcalidrawAutomate,
    root: LogicalElement,
    border: LogicalElement,
    padding: MindmapPadding,
): ParsedMindmap {
    const scene = ea.getViewElements().filter((element) => !isTemporaryElement(element));
    const space = coordinateSpace(border, padding);
    const graph = new TreeEdgeGraph("Mindmap", root.anchor.id, space.width, space.height, MAX_OFFSET_RATIO);
    const nodes: LogicalElement[] = [root];
    const queued = new Set<string>([root.anchor.id]);
    const queue: LogicalElement[] = [root];
    const byId = new Map(scene.map((element) => [element.id, element]));
    graph.addNode(nodeFor(root, undefined, space));

    for (let readIndex = 0; readIndex < queue.length; readIndex++) {
        const parent = queue[readIndex];
        const children = customData(parent.anchor).mindmapChildren;
        if (!Array.isArray(children)) continue;
        for (const childId of children) {
            if (typeof childId !== "string" || queued.has(childId)) continue;
            const child = resolveAnchor(ea, byId.get(childId), scene);
            if (!child || customData(child.anchor).isMindmapNode !== true) continue;
            if (customData(child.anchor).mindmapParent !== parent.anchor.id) continue;
            queued.add(childId);
            queue.push(child);
            nodes.push(child);
            graph.addNode(nodeFor(child, parent.anchor.id, space));
        }
    }
    const edges = hydrateEdges(graph, scene);
    const fixedIds = addFixedNodes(graph, resolveFixedElements(ea, scene, border), space);
    return { graph, nodes, edges, fixedIds, coordinateSpace: space };
}

/**
 * Applies persisted line metadata to the graph's edges.
 *
 * Offsets come from metadata rather than the line's current geometry, because a
 * node moved by hand must not turn the old line position into an anchor offset.
 * If several lines claim one edge (for example a copied line), the first in scene
 * order wins. An edge without a line stays centered and is simply not redrawn.
 */
function hydrateEdges(graph: TreeEdgeGraph, scene: readonly ExcalidrawElement[]): Map<string, EdgeBinding> {
    const edges = new Map<string, EdgeBinding>();
    for (const line of scene) {
        const metadata = readEdgeMetadata(line);
        const edge = metadata && graph.getEdge(metadata.childId);
        if (!metadata || !edge || edge.parentId !== metadata.parentId || edges.has(metadata.childId) || !lineEndpoints(line)) continue;
        graph.setOffset(edge, "parent", metadata.parentOffset.x, metadata.parentOffset.y);
        graph.setOffset(edge, "child", metadata.childOffset.x, metadata.childOffset.y);
        edges.set(metadata.childId, {
            lineId: line.id,
            parentId: metadata.parentId,
            childId: metadata.childId,
            parentEnd: metadata.parentEnd,
            parentGap: metadata.parentGap,
            childGap: metadata.childGap,
        });
    }
    return edges;
}

/**
 * Parses connected canvas nodes breadth-first from the configured root.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param root Configured root logical element.
 * @param connectionDistance Maximum endpoint-to-boundary distance.
 * @returns The parent-first graph, logical node representations, and the line of each edge.
 */
export function parseMindmap(
    ea: ExcalidrawAutomate,
    root: LogicalElement,
    connectionDistance: number,
    border: LogicalElement,
    padding: MindmapPadding,
): ParsedMindmap {
    const borderIds = new Set(border?.elements.map((element) => element.id));
    const scene = ea.getViewElements().filter((element) => {
        const data = customData(element);
        return data.isMindmapTemporary !== true && data.isMindmapBorder !== true && !borderIds.has(element.id);
    });
    const space = coordinateSpace(border, padding);
    const graph = new TreeEdgeGraph("Mindmap", root.anchor.id, space.width, space.height, MAX_OFFSET_RATIO);
    const edges = new Map<string, EdgeBinding>();
    const queue: LogicalElement[] = [root];
    const nodes: LogicalElement[] = [root];
    const queued = new Set([root.anchor.id]);
    const parentById = new Map<string, string | undefined>([[root.anchor.id, undefined]]);
    graph.addNode(nodeFor(root, undefined, space));
    const candidates = nodeCandidates(scene, ea);

    for (let readIndex = 0; readIndex < queue.length; readIndex++) {
        const parent = queue[readIndex];
        for (const line of scene) {
            const endpoints = lineEndpoints(line);
            if (!endpoints) continue;
            const nearStart = distanceToBoundary(endpoints.start, parent) <= connectionDistance;
            const nearEnd = distanceToBoundary(endpoints.end, parent) <= connectionDistance;
            if (!nearStart && !nearEnd) continue;
            const parentEnd: LineEnd = nearStart ? "start" : "end";
            const parentPoint = nearStart ? endpoints.start : endpoints.end;
            const endpoint = nearStart ? endpoints.end : endpoints.start;
            const candidate = nearestCandidate(endpoint, candidates, connectionDistance);
            if (!candidate || queued.has(candidate.anchor.id)) continue;
            if (isLoop(candidate.anchor.id, parent.anchor.id, parentById)) continue;
            queued.add(candidate.anchor.id);
            parentById.set(candidate.anchor.id, parent.anchor.id);
            queue.push(candidate);
            nodes.push(candidate);
            graph.addNode(nodeFor(candidate, parent.anchor.id, space));
            const binding = bindLineToEdge(
                graph,
                { lineId: line.id, childId: candidate.anchor.id, parentEnd },
                sceneToGraphPoint(parentPoint, space),
                sceneToGraphPoint(endpoint, space),
            );
            if (binding) edges.set(candidate.anchor.id, binding);
        }
    }

    console.log(`Parsed ${nodes.length} nodes from mindmap. Serialized graph:`);
    console.log(graph.serialize());
    return { graph, nodes, edges, fixedIds: [], coordinateSpace: space };
}
