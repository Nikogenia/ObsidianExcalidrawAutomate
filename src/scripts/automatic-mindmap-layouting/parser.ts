import p5 from "p5";
import { TreeGraph, type TreeNode } from "./core/graph/types";
import { normalizeShape, type MindmapShape } from "./metadata";
import { resolveAnchor, type LogicalElement } from "./groups";

export interface ParsedMindmap {
    graph: TreeGraph;
    nodes: LogicalElement[];
}

interface Point {
    x: number;
    y: number;
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
    if (logical.anchor.type === "ellipse") {
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

function nearestCandidate(
    endpoint: Point,
    scene: readonly ExcalidrawElement[],
    excludedIds: ReadonlySet<string>,
    connectionDistance: number,
    ea: ExcalidrawAutomate,
): LogicalElement | undefined {
    const candidates: { logical: LogicalElement; distance: number; order: number }[] = [];
    scene.forEach((element, order) => {
        if (excludedIds.has(element.id) || element.type === "line" || element.type === "arrow") return;
        const logical = resolveAnchor(ea, element, scene);
        if (!logical || logical.anchor.id !== element.id) return;
        const distance = distanceToBoundary(endpoint, logical);
        if (distance <= connectionDistance) candidates.push({ logical, distance, order });
    });
    candidates.sort((left, right) => left.distance - right.distance || left.order - right.order);
    return candidates[0]?.logical;
}

function nodeFor(logical: LogicalElement, parentId?: string): TreeNode {
    const point = center(logical);
    const shape = normalizeShape(customData(logical.anchor).mindmapShape) as MindmapShape;
    return {
        id: logical.anchor.id,
        ...(parentId ? { parentId } : {}),
        children: [],
        pos: new p5.Vector(point.x, point.y),
        shape,
        width: logical.bounds.width,
        height: logical.bounds.height,
    };
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
): ParsedMindmap {
    const borderIds = new Set(border?.elements.map((element) => element.id));
    const scene = ea.getViewElements().filter((element) => {
        const data = customData(element);
        return data.isMindmapTemporary !== true && data.isMindmapBorder !== true && !borderIds.has(element.id);
    });
    const graph = new TreeGraph("Mindmap", root.anchor.id, border.bounds.width, border.bounds.height);
    const queue: LogicalElement[] = [root];
    const nodes: LogicalElement[] = [root];
    const queued = new Set([root.anchor.id]);
    const parentById = new Map<string, string | undefined>([[root.anchor.id, undefined]]);
    graph.addNode(nodeFor(root));

    for (let readIndex = 0; readIndex < queue.length; readIndex++) {
        const parent = queue[readIndex];
        for (const line of scene) {
            const endpoints = linePoints(line);
            if (!endpoints) continue;
            const nearStart = distanceToBoundary(endpoints[0], parent) <= connectionDistance;
            const nearEnd = distanceToBoundary(endpoints[1], parent) <= connectionDistance;
            if (!nearStart && !nearEnd) continue;
            const endpoint = nearStart ? endpoints[1] : endpoints[0];
            const candidate = nearestCandidate(endpoint, scene, queued, connectionDistance, ea);
            if (!candidate || candidate.anchor.id === parent.anchor.id) continue;
            if (isLoop(candidate.anchor.id, parent.anchor.id, parentById)) continue;
            queued.add(candidate.anchor.id);
            parentById.set(candidate.anchor.id, parent.anchor.id);
            queue.push(candidate);
            nodes.push(candidate);
            graph.addNode(nodeFor(candidate, parent.anchor.id));
        }
    }

    console.log(`Parsed ${nodes.length} nodes from mindmap. Serialized graph:`);
    console.log(graph.serialize());
    return { graph, nodes };
}
