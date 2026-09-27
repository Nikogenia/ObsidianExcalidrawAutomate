/**
 * @file main.ts
 * @overview
 *   Automatic Mindmap Layouting script entrypoint.
 *
 *   Folder: src/scripts/automatic-mindmap-layouting
 *   Build output: build/automatic-mindmap-layouting/automatic-mindmap-layouting.md
 *
 * @author  Nikogenia
 * @version 1.0.0
 * @created 2026-09-26
 */

import { showNotice } from "../../sharedUtils/notice";
import { openMindmapWorkbench } from "./ui";

/**
 * Runs the Automatic Mindmap Layouting script.
 *
 * @param ea   The ExcalidrawAutomate instance.
 * @param _api The live Excalidraw React API.
 * @returns    Promise resolving when execution completes.
 */
export async function runAutomaticMindmapLayouting(
  ea: ExcalidrawAutomate,
  _api: ExcalidrawAPI,
): Promise<void> {
  openMindmapWorkbench(ea);
}

/**
 * Script-engine entrypoint.
 */
async function main(): Promise<void> {
  if (!ea.verifyMinimumPluginVersion("2.0.0")) {
    new ea.obsidian.Notice("This script requires Excalidraw 2.0.0 or newer.");
    return;
  }

  const api = ea.getExcalidrawAPI();
  if (!api) {
    showNotice("Could not obtain Excalidraw API.");
    return;
  }

  await runAutomaticMindmapLayouting(ea, api);
}

void main();
