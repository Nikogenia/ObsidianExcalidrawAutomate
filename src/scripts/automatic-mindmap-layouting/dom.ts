/** Small DOM builders for the workbench modals. All use the parent's document (popout windows). */

/** Appends a paragraph with trusted HTML (fixed labels and generated statistics only). */
export function addText(parent: HTMLElement, html: string): HTMLParagraphElement {
    const element = parent.ownerDocument.createElement("p");
    element.innerHTML = html;
    element.style.margin = "0";
    parent.appendChild(element);
    return element;
}

/** Appends a paragraph with untrusted text (file names, element IDs). */
export function addPlainText(parent: HTMLElement, text: string): HTMLParagraphElement {
    const element = parent.ownerDocument.createElement("p");
    element.textContent = text;
    element.style.margin = "0";
    parent.appendChild(element);
    return element;
}

export function addButton(parent: HTMLElement, label: string): HTMLButtonElement {
    const button = parent.ownerDocument.createElement("button");
    button.type = "button";
    button.textContent = label;
    parent.appendChild(button);
    return button;
}

export function addSpacer(parent: HTMLElement, height: string): void {
    const spacer = parent.ownerDocument.createElement("div");
    spacer.style.height = height;
    parent.appendChild(spacer);
}

export function addSection(parent: HTMLElement, title: string): HTMLElement {
    const section = parent.ownerDocument.createElement("section");
    const heading = parent.ownerDocument.createElement("h3");
    heading.textContent = title;
    section.appendChild(heading);
    section.style.display = "flex";
    section.style.flexDirection = "column";
    section.style.gap = "0.45em";
    section.style.margin = "0 0 0.8em";
    parent.appendChild(section);
    return section;
}

export function addRow(parent: HTMLElement, columns: string): HTMLDivElement {
    const row = parent.ownerDocument.createElement("div");
    row.style.display = "grid";
    row.style.gap = "0.5em";
    row.style.gridTemplateColumns = columns;
    parent.appendChild(row);
    return row;
}

export function addActions(parent: HTMLElement): HTMLDivElement {
    const actions = parent.ownerDocument.createElement("div");
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "0.5em";
    actions.style.marginTop = "0.5em";
    parent.appendChild(actions);
    return actions;
}

function decimalsOf(step: number): number {
    const text = String(step);
    const dot = text.indexOf(".");
    return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * Clamps a numeric input into a range and rounds it to the step's decimals.
 *
 * @returns The clamped value, or `fallback` for malformed input.
 */
export function clampToStep(value: unknown, minimum: number, maximum: number, step: number, fallback: number): number {
    const numeric = typeof value === "number" ? value : Number(value);
    if (typeof value === "string" && value.trim() === "") return fallback;
    if (!Number.isFinite(numeric)) return fallback;
    const clamped = Math.min(maximum, Math.max(minimum, numeric));
    return Number(clamped.toFixed(decimalsOf(step)));
}

export interface RangeOptions {
    step?: number;
    minLabelWidth?: string;
    /** Label of the slider's maximum position; the number field is then empty and shows it as placeholder. */
    maximumLabel?: string;
}

/**
 * Appends a label with a synchronized range slider and number field.
 *
 * With `maximumLabel`, the slider's last position is a special value (for
 * example "Finished"): the number field accepts only values below it and is
 * cleared, showing the label, while the slider is at the maximum.
 */
export function addRangePair(
    parent: HTMLElement,
    label: string,
    minimum: number,
    maximum: number,
    initial: number,
    onChange: (value: number) => void,
    options: RangeOptions = {},
): HTMLDivElement {
    const step = options.step ?? 1;
    const doc = parent.ownerDocument;
    const row = doc.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "0.5em";
    const labelEl = doc.createElement("label");
    labelEl.textContent = label;
    if (options.minLabelWidth) labelEl.style.minWidth = options.minLabelWidth;
    const range = doc.createElement("input");
    range.type = "range";
    range.min = String(minimum);
    range.max = String(maximum);
    range.step = String(step);
    const number = doc.createElement("input");
    number.type = "number";
    number.min = String(minimum);
    number.max = String(options.maximumLabel ? maximum - step : maximum);
    number.step = String(step);
    if (options.maximumLabel) number.placeholder = options.maximumLabel;
    range.style.flex = "1 1 auto";
    number.style.width = "5.5em";
    let current = initial;
    const show = (value: number): void => {
        range.value = String(value);
        number.value = options.maximumLabel && value >= maximum ? "" : String(value);
    };
    show(initial);
    const update = (source: HTMLInputElement): void => {
        // An emptied number field keeps the special maximum ("Finished") or the last value.
        const fallback = source === number && options.maximumLabel ? maximum : current;
        const value = clampToStep(source.value, minimum, maximum, step, fallback);
        current = value;
        if (source === range) number.value = options.maximumLabel && value >= maximum ? "" : String(value);
        else range.value = String(value);
        onChange(value);
    };
    range.addEventListener("input", () => update(range));
    number.addEventListener("input", () => update(number));
    number.addEventListener("change", () => show(current));
    row.append(labelEl, range, number);
    parent.appendChild(row);
    return row;
}

export function addCheckbox(parent: HTMLElement, label: string, initial: boolean, onChange: (value: boolean) => void): HTMLInputElement {
    const doc = parent.ownerDocument;
    const row = doc.createElement("label");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "0.5em";
    const checkbox = doc.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = initial;
    checkbox.addEventListener("change", () => onChange(checkbox.checked));
    row.append(checkbox, doc.createTextNode(label));
    parent.appendChild(row);
    return checkbox;
}

export function addSelect(parent: HTMLElement, options: readonly { value: string; label: string }[], initial?: string): HTMLSelectElement {
    const select = parent.ownerDocument.createElement("select");
    for (const { value, label } of options) {
        const option = parent.ownerDocument.createElement("option");
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
    }
    if (initial !== undefined) select.value = initial;
    parent.appendChild(select);
    return select;
}

/** Disables every button, input, and select below `root` except `keep`. */
export function disableControls(root: HTMLElement, keep: readonly HTMLElement[] = []): void {
    root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button, input, select").forEach((control) => {
        if (!keep.includes(control)) control.disabled = true;
    });
}
