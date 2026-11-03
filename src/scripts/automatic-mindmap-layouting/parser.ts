import p5 from "p5";
import { TreeGraph, type TreeNode } from "./core/graph/types";
import { shapeOf, type MindmapPadding } from "./metadata";
import { containerIdOf, resolveAnchor, type LogicalElement } from "./groups";

export interface ParsedMindmap {
    graph: TreeGraph;
    nodes: LogicalElement[];
    coordinateSpace: CoordinateSpace;
}

interface Point {
    x: number;
    y: number;
}

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

function linePoints(element: ExcalidrawElement): [Point, Point] | undefined {
    if (element.type !== "line" && element.type !== "arrow") return undefined;
    const points = (element as ExcalidrawElement & { points?: readonly [number, number][] }).points;
    if (!points || points.length < 2) return undefined;
    const first = points[0];
    const last = points[points.length - 1];
    return [
        { x: element.x + first[0], y: element.y + first[1] },
        { x: element.x + last[0], y: element.y + last[1] },
    ];
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
 */
export function loadMindmapFromMetadata(
    ea: ExcalidrawAutomate,
    root: LogicalElement,
    border: LogicalElement,
    padding: MindmapPadding = { top: 0, left: 0, bottom: 0, right: 0 },
): ParsedMindmap {
    const scene = ea.getViewElements().filter((element) => customData(element).isMindmapTemporary !== true);
    const space = coordinateSpace(border, padding);
    const graph = new TreeGraph("Mindmap", root.anchor.id, space.width, space.height);
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
    return { graph, nodes, coordinateSpace: space };
}

/**
 * Parses connected canvas nodes breadth-first from the configured root.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param root Configured root logical element.
 * @param connectionDistance Maximum endpoint-to-boundary distance.
 * @returns The parent-first graph and logical node representations.
 */
export function parseMindmap(
    ea: ExcalidrawAutomate,
    root: LogicalElement,
    connectionDistance: number,
    border: LogicalElement,
    padding: MindmapPadding = { top: 0, left: 0, bottom: 0, right: 0 },
): ParsedMindmap {
    const borderIds = new Set(border?.elements.map((element) => element.id));
    const scene = ea.getViewElements().filter((element) => {
        const data = customData(element);
        return data.isMindmapTemporary !== true && data.isMindmapBorder !== true && !borderIds.has(element.id);
    });
    const space = coordinateSpace(border, padding);
    const graph = new TreeGraph("Mindmap", root.anchor.id, space.width, space.height);
    const queue: LogicalElement[] = [root];
    const nodes: LogicalElement[] = [root];
    const queued = new Set([root.anchor.id]);
    const parentById = new Map<string, string | undefined>([[root.anchor.id, undefined]]);
    graph.addNode(nodeFor(root, undefined, space));
    const candidates = nodeCandidates(scene, ea);

    for (let readIndex = 0; readIndex < queue.length; readIndex++) {
        const parent = queue[readIndex];
        for (const line of scene) {
            const endpoints = linePoints(line);
            if (!endpoints) continue;
            const nearStart = distanceToBoundary(endpoints[0], parent) <= connectionDistance;
            const nearEnd = distanceToBoundary(endpoints[1], parent) <= connectionDistance;
            if (!nearStart && !nearEnd) continue;
            const endpoint = nearStart ? endpoints[1] : endpoints[0];
            const candidate = nearestCandidate(endpoint, candidates, connectionDistance);
            if (!candidate || queued.has(candidate.anchor.id)) continue;
            if (isLoop(candidate.anchor.id, parent.anchor.id, parentById)) continue;
            queued.add(candidate.anchor.id);
            parentById.set(candidate.anchor.id, parent.anchor.id);
            queue.push(candidate);
            nodes.push(candidate);
            graph.addNode(nodeFor(candidate, parent.anchor.id, space));
        }
    }

    console.log(`Parsed ${nodes.length} nodes from mindmap. Serialized graph:`);
    console.log(graph.serialize());
    return { graph, nodes, coordinateSpace: space };
}
