/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool registry for rc-devtools-mcp.
 * Aggregates and exports all available MCP tools.
 */

import * as analysisTools from './analysis.js';
import * as consoleTools from './console.js';
import * as debuggerTools from './debugger.js';
import * as inputTools from './input.js';
import * as interceptTools from './intercept.js';
import * as networkTools from './network.js';
import * as pagesTools from './pages.js';
import * as persistentTools from './persistent.js';
import * as screenshotTools from './screenshot.js';
import * as scriptTools from './script.js';
import * as snapshotTools from './snapshot.js';
import * as vmasmTools from './vmasm.js';
import type {ToolDefinition} from './tool-definition.js';

const tools = [
  ...Object.values(analysisTools),
  ...Object.values(consoleTools),
  ...Object.values(debuggerTools),
  ...Object.values(inputTools),
  ...Object.values(interceptTools),
  ...Object.values(networkTools),
  ...Object.values(pagesTools),
  ...Object.values(persistentTools),
  ...Object.values(screenshotTools),
  ...Object.values(scriptTools),
  ...Object.values(snapshotTools),
  ...Object.values(vmasmTools),
].filter((item): item is ToolDefinition => 
  typeof item === 'object' && item !== null && 'schema' in item
);

tools.sort((a, b) => {
  return a.name.localeCompare(b.name);
});

export {tools};

// Re-export tool definition types and utilities
export {
  defineTool,
  CLOSE_PAGE_ERROR,
  timeoutSchema,
  type ToolDefinition,
  type Request,
  type Response,
  type Context,
  type ImageContentData,
  type SnapshotParams,
  type DevToolsData,
  type NetworkRequestFilter,
} from './tool-definition.js';

// Re-export categories
export {ToolCategory, labels} from './categories.js';
