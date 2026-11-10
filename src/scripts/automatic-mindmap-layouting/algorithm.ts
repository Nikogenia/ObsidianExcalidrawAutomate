import { NIKOGENIA1_PARAMETERS, NikogeniaAlgorithmV1 } from "./core/algorithms/nikogenia/NikogeniaAlgorithm1";
import { RADIAL_AREA_PARAMETERS, RadialAlgorithmArea } from "./core/algorithms/nikogenia/RadialAlgorithmArea";
import {
    parameterTooltip,
    parseParameterValue,
    type AlgorithmParameter,
    type BooleanParameter,
    type NumberParameter,
} from "./core/algorithms/parameters";
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

/** Workbench controls: sliders and checkboxes (the Nikogenia and radial area tables have no select parameters). */
export type Parameter = NumberParameter | BooleanParameter;

export function isBooleanParameter(parameter: Parameter): parameter is BooleanParameter {
    return parameter.type === "boolean";
}

function isControl<K extends string>(parameter: AlgorithmParameter<K>): parameter is NumberParameter<K> | BooleanParameter<K> {
    return parameter.type !== "select";
}

/** Always visible below the algorithm dropdown. */
const PRIMARY_KEYS: readonly string[] = ["gapConstant", "maxOffsetRatio"];
/** Not exposed: `borderPadding` is fixed to 1 px (`keepInitialLayout` is not in the core table, Start/Reset decide it). */
const HIDDEN_KEYS: readonly string[] = ["borderPadding"];
/** Parameters that only affect Reset (the structure preserving start of Nikogenia). */
const RESET_KEYS: readonly string[] = ["initialRotations", "fitToCanvas"];

/**
 * Parameter tables, derived from the core tables (`NIKOGENIA1_PARAMETERS`,
 * `RADIAL_AREA_PARAMETERS`): labels, descriptions (tooltips), ranges, and steps
 * are defined once in the algorithm files and shared with the research web UI.
 */
export const PRIMARY_PARAMETERS: Parameter[] = NIKOGENIA1_PARAMETERS
    .filter(isControl)
    .filter((parameter) => PRIMARY_KEYS.includes(parameter.key));

/** Collapsed by default; sliders first, then the checkboxes. */
export const ADVANCED_PARAMETERS: Parameter[] = NIKOGENIA1_PARAMETERS
    .filter(isControl)
    .filter((parameter) => !PRIMARY_KEYS.includes(parameter.key) && !HIDDEN_KEYS.includes(parameter.key))
    .map((parameter) => (RESET_KEYS.includes(parameter.key) ? { ...parameter, label: `${parameter.label} (Reset)` } : parameter))
    .sort((left, right) => Number(isBooleanParameter(left)) - Number(isBooleanParameter(right)));

/** Parameters of the initial layout run by Reset (`RadialAlgorithmArea`). */
const INITIAL_LAYOUT_KEYS: readonly string[] = ["levelGap", "areaExponent", "randomizeOrder"];
export const INITIAL_LAYOUT_PARAMETERS: Parameter[] = RADIAL_AREA_PARAMETERS
    .filter(isControl)
    .filter((parameter) => INITIAL_LAYOUT_KEYS.includes(parameter.key))
    .map((parameter) => ({ ...parameter, label: `Radial ${parameter.label} (Reset)` }));

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

let coreDefaults: ParameterValues | undefined;

/** Tooltip of a parameter control: the core description plus the core default value. */
export function parameterTooltipText(parameter: Parameter): string {
    coreDefaults ??= defaultAlgorithmSettings().values;
    return parameterTooltip(parameter, coreDefaults[parameter.key]);
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
        if (typeof value !== (isBooleanParameter(parameter) ? "boolean" : "number")) continue;
        // clamped to the range and rounded to the step of the core table
        const parsed = parseParameterValue(parameter, value, true);
        if (typeof parsed === "number" || typeof parsed === "boolean") result.parameters[parameter.key] = parsed;
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
    radial.randomizeOrder = Boolean(settings.values.randomizeOrder);
    radial.initialize(graph);
    configureNikogenia(settings, false).initialize(graph);
}
