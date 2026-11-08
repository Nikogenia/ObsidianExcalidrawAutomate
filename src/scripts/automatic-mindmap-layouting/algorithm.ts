import { NikogeniaAlgorithmV1 } from "./core/algorithms/nikogenia/NikogeniaAlgorithm1";
import { RadialAlgorithmArea } from "./core/algorithms/nikogenia/RadialAlgorithmArea";
import type { TreeEdgeGraph } from "./core/graph/TreeEdgeGraph";

/** Algorithms selectable in the workbench (value -> dropdown label). */
export const ALGORITHM_OPTIONS = { nikogenia1: "Default (nikogenia v1)" } as const;
export type AlgorithmId = keyof typeof ALGORITHM_OPTIONS;

/** Largest finite Steps Per Render value; the slider position above it means "Finished". */
export const MAX_STEPS_PER_RENDER = 1000;
export const STEPS_FINISHED = MAX_STEPS_PER_RENDER + 1;
export const DEFAULT_STEPS_PER_RENDER = 50;

/**
 * The padded border already is the layout area, so the algorithm's own hard
 * border is only a 1 px safety margin (spec 7.1).
 */
const BORDER_PADDING = 1;

type NikogeniaKey = keyof NikogeniaAlgorithmV1 & string;
type RadialKey = "levelGap" | "areaExponent";

interface NumberParameter<K extends string> {
    key: K;
    label: string;
    min: number;
    max: number;
    step: number;
}

interface BooleanParameter<K extends string> {
    key: K;
    label: string;
    boolean: true;
}

export type Parameter<K extends string = string> = NumberParameter<K> | BooleanParameter<K>;

export function isBooleanParameter(parameter: Parameter): parameter is BooleanParameter<string> {
    return "boolean" in parameter;
}

/** Always visible below the algorithm dropdown. */
export const PRIMARY_PARAMETERS: Parameter<NikogeniaKey>[] = [
    { key: "gapConstant", label: "Gap Constant", min: 0.05, max: 2, step: 0.01 },
    { key: "maxOffsetRatio", label: "Max Anchor Offset Ratio", min: 0, max: 1, step: 0.01 },
];

/**
 * Collapsed by default. Same ranges as the research web UI (`Nikogenia1Sim.ts`).
 * Not exposed: `borderPadding` (fixed to 1 px) and `keepInitialLayout` (decided
 * by the Start/Reset semantics, see `createLayoutAlgorithm`).
 */
export const ADVANCED_PARAMETERS: Parameter<NikogeniaKey>[] = [
    { key: "iterations", label: "Iterations", min: 1, max: 5000, step: 1 },
    { key: "legalizationIterations", label: "Legalization Iterations", min: 0, max: 500, step: 1 },
    { key: "nodePadding", label: "Node Padding", min: 0, max: 30, step: 1 },
    { key: "springStrength", label: "Spring Strength", min: 0, max: 5, step: 0.01 },
    { key: "springRestFactor", label: "Spring Rest Factor", min: 0, max: 3, step: 0.01 },
    { key: "repulsionStrength", label: "Repulsion Strength", min: 0, max: 5, step: 0.01 },
    { key: "vertexEdgeStrength", label: "Vertex Edge Strength", min: 0, max: 3, step: 0.01 },
    { key: "densityStrength", label: "Density Strength", min: 0, max: 3, step: 0.01 },
    { key: "densityResolution", label: "Density Resolution", min: 4, max: 64, step: 1 },
    { key: "borderStrength", label: "Border Strength", min: 0, max: 5, step: 0.01 },
    { key: "anchorStiffness", label: "Anchor Stiffness", min: 0, max: 2, step: 0.01 },
    { key: "anchorSpringFactor", label: "Anchor Spring Factor", min: 0, max: 2, step: 0.01 },
    { key: "anchorOrdering", label: "Anchor Ordering", min: 0, max: 10, step: 0.1 },
    { key: "anchorSpacingFactor", label: "Anchor Spacing Factor", min: 0, max: 1, step: 0.01 },
    { key: "initialStepFactor", label: "Initial Step Factor", min: 0.01, max: 2, step: 0.01 },
    { key: "maxStepFactor", label: "Max Step Factor", min: 0.01, max: 3, step: 0.01 },
    { key: "minStepFactor", label: "Min Step Factor", min: 0, max: 0.5, step: 0.01 },
    { key: "stepDecay", label: "Step Decay", min: 0.5, max: 0.99, step: 0.01 },
    { key: "projectionPasses", label: "Projection Passes", min: 0, max: 20, step: 1 },
    { key: "subtreeForceFactor", label: "Subtree Force Factor", min: 0, max: 1, step: 0.01 },
    { key: "initialRotations", label: "Initial Rotations (Reset)", min: 1, max: 72, step: 1 },
    { key: "preserveCrossings", label: "Preserve Crossings", boolean: true },
    { key: "untangleAnchors", label: "Untangle Anchors", boolean: true },
    { key: "fitToCanvas", label: "Fit To Canvas (Reset)", boolean: true },
    { key: "massByArea", label: "Mass By Area", boolean: true },
];

/** Parameters of the initial layout run by Reset (`RadialAlgorithmArea`). */
export const INITIAL_LAYOUT_PARAMETERS: Parameter<RadialKey>[] = [
    { key: "levelGap", label: "Radial Level Gap (Reset)", min: 0, max: 200, step: 1 },
    { key: "areaExponent", label: "Radial Area Exponent (Reset)", min: 0, max: 2, step: 0.05 },
];

export type ParameterValues = Record<string, number | boolean>;

export interface AlgorithmSettings {
    algorithm: AlgorithmId;
    stepsPerRender: number;
    resetBeforeStart: boolean;
    showAdvanced: boolean;
    values: ParameterValues;
}

/** Default settings, read from fresh core instances so they follow core changes. */
export function defaultAlgorithmSettings(): AlgorithmSettings {
    const nikogenia = new NikogeniaAlgorithmV1() as unknown as Record<string, number | boolean>;
    const radial = new RadialAlgorithmArea() as unknown as Record<string, number | boolean>;
    const values: ParameterValues = {};
    for (const parameter of [...PRIMARY_PARAMETERS, ...ADVANCED_PARAMETERS]) values[parameter.key] = nikogenia[parameter.key];
    for (const parameter of INITIAL_LAYOUT_PARAMETERS) values[parameter.key] = radial[parameter.key];
    return {
        algorithm: "nikogenia1",
        stepsPerRender: DEFAULT_STEPS_PER_RENDER,
        resetBeforeStart: false,
        showAdvanced: false,
        values,
    };
}

/** Root `customData` key of the stored mindmap parameters. */
export const ALGORITHM_SETTINGS_KEY = "mindmapAlgorithmSettings";

/**
 * Algorithm settings as stored on the root (`mindmapAlgorithmSettings`).
 * Workbench-only state (Reset Before Start, the open Advanced section) is not
 * part of it. A type alias, so it is assignable to `customData`.
 */
export type StoredAlgorithmSettings = {
    algorithm: AlgorithmId;
    stepsPerRender: number;
    parameters: ParameterValues;
};

const ALL_PARAMETERS: Parameter[] = [...PRIMARY_PARAMETERS, ...ADVANCED_PARAMETERS, ...INITIAL_LAYOUT_PARAMETERS];

function decimalsOf(step: number): number {
    const text = String(step);
    const dot = text.indexOf(".");
    return dot < 0 ? 0 : text.length - dot - 1;
}

/** The storable part of the settings, with parameters in table order (stable for comparison). */
export function toStoredSettings(settings: AlgorithmSettings): StoredAlgorithmSettings {
    const parameters: ParameterValues = {};
    for (const parameter of ALL_PARAMETERS) parameters[parameter.key] = settings.values[parameter.key];
    return { algorithm: settings.algorithm, stepsPerRender: settings.stepsPerRender, parameters };
}

/**
 * Validates stored settings. Unknown algorithms and keys are ignored, missing or
 * malformed values fall back to the defaults, numbers are clamped to the
 * parameter ranges, so a stored value always yields a valid run.
 *
 * @param raw Value of `mindmapAlgorithmSettings`.
 * @returns Complete stored settings, or undefined when nothing usable is stored.
 */
export function readStoredSettings(raw: unknown): StoredAlgorithmSettings | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const candidate = raw as { algorithm?: unknown; stepsPerRender?: unknown; parameters?: unknown };
    const result = toStoredSettings(defaultAlgorithmSettings());
    if (typeof candidate.algorithm === "string" && candidate.algorithm in ALGORITHM_OPTIONS) {
        result.algorithm = candidate.algorithm as AlgorithmId;
    }
    if (typeof candidate.stepsPerRender === "number" && Number.isFinite(candidate.stepsPerRender)) {
        result.stepsPerRender = Math.min(STEPS_FINISHED, Math.max(1, Math.round(candidate.stepsPerRender)));
    }
    const stored = candidate.parameters && typeof candidate.parameters === "object"
        ? candidate.parameters as Record<string, unknown>
        : {};
    for (const parameter of ALL_PARAMETERS) {
        const value = stored[parameter.key];
        if (isBooleanParameter(parameter)) {
            if (typeof value === "boolean") result.parameters[parameter.key] = value;
        } else if (typeof value === "number" && Number.isFinite(value)) {
            const clamped = Math.min(parameter.max, Math.max(parameter.min, value));
            result.parameters[parameter.key] = Number(clamped.toFixed(decimalsOf(parameter.step)));
        }
    }
    return result;
}

/** Applies stored settings; workbench-only state is kept. */
export function applyStoredSettings(settings: AlgorithmSettings, stored: StoredAlgorithmSettings): AlgorithmSettings {
    return { ...settings, algorithm: stored.algorithm, stepsPerRender: stored.stepsPerRender, values: { ...stored.parameters } };
}

export function sameStoredSettings(left: StoredAlgorithmSettings, right: StoredAlgorithmSettings): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

/** Steps per render as a number of steps; Infinity renders only when the run finished. */
export function stepsPerRenderLimit(settings: AlgorithmSettings): number {
    return settings.stepsPerRender >= STEPS_FINISHED ? Infinity : settings.stepsPerRender;
}

function configureNikogenia(settings: AlgorithmSettings, keepInitialLayout: boolean): NikogeniaAlgorithmV1 {
    const algorithm = new NikogeniaAlgorithmV1();
    const target = algorithm as unknown as Record<string, number | boolean>;
    for (const parameter of [...PRIMARY_PARAMETERS, ...ADVANCED_PARAMETERS]) target[parameter.key] = settings.values[parameter.key];
    algorithm.borderPadding = BORDER_PADDING;
    algorithm.keepInitialLayout = keepInitialLayout;
    return algorithm;
}

/**
 * Creates and initializes the layout algorithm for Start on the current layout
 * (initiation mode "none" in the research web UI): no rotation search and no
 * canvas fit, the drawing is optimized as it is. Anchor offsets from the line
 * metadata are kept and re-projected for the configured ratio.
 *
 * @param graph Live graph of the run; mutated by every step.
 * @param settings Workbench algorithm settings.
 * @returns The initialized algorithm.
 */
export function createLayoutAlgorithm(graph: TreeEdgeGraph, settings: AlgorithmSettings): NikogeniaAlgorithmV1 {
    const algorithm = configureNikogenia(settings, true);
    algorithm.initialize(graph);
    return algorithm;
}

/**
 * Computes the initial layout for Reset (initiation mode "radial-area"):
 * anchors are centered, `RadialAlgorithmArea` places the tree around the canvas
 * center (fixed nodes keep their position), and Nikogenia's structure preserving
 * start rotates and fits it to the canvas when Fit To Canvas is enabled. This is
 * exactly what the web UI does before its first Nikogenia step; no layout step
 * runs here.
 *
 * @param graph Graph to lay out in place.
 * @param settings Workbench algorithm settings.
 */
export function applyInitialLayout(graph: TreeEdgeGraph, settings: AlgorithmSettings): void {
    graph.resetOffsets();
    const radial = new RadialAlgorithmArea();
    radial.levelGap = Number(settings.values.levelGap);
    radial.areaExponent = Number(settings.values.areaExponent);
    radial.initialize(graph);
    configureNikogenia(settings, false).initialize(graph);
}
