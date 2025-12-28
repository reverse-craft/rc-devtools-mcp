/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IR Debugger tools for rc-devtools-mcp.
 * Provides JSVMP IR-level debugging capabilities including session management,
 * breakpoint setting, and state extraction.
 */

import {zod} from '../third-party/index.js';
import {
  loadSourceMap,
  listSourceMaps,
  unloadSourceMap,
  getSourceMap,
  findSourceMapByUrl,
} from '../utils/ir-session-manager.js';
import {ErrorCodes} from '../utils/ir-debugger-types.js';
import {getCdpSession} from '../utils/cdp.js';
import {
  trackBreakpoint,
  untrackBreakpoint,
  initializeDebuggerForPage,
  getDebuggerState,
  removeIRBreakpointMetadata,
  clearIRBreakpointMetadataByIrId,
  setIRBreakpointMetadata,
} from '../utils/debugger-utils.js';
import {fromMapping} from '../utils/ir-condition-builder.js';
import {
  extractState,
  formatState,
} from '../utils/ir-state-extractor.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './tool-definition.js';

/**
 * Load an IR source map file for JSVMP debugging.
 * Parses the source map and builds indexes for efficient lookups.
 * Note: Does not require the target script to be loaded - breakpoints can be set
 * before the script loads and will be resolved when the script is parsed.
 */
export const loadIrSourceMap = defineTool({
  name: 'load_ir_source_map',
  description: `Load an IR source map file for JSVMP debugging. Returns a unique IR ID for subsequent operations. Parses the source map file and builds indexes for IR line, PC address, and opcode lookups.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    sourceMapPath: zod
      .string()
      .describe('Path to the source map JSON file that maps IR code to original JS.'),
  },
  handler: async (request, response, _context) => {
    const {sourceMapPath} = request.params;

    // Load the source map
    const result = loadSourceMap({sourceMapPath});

    if (!result.success) {
      const error = result.error;
      response.appendResponseLine(`❌ Failed to load IR source map`);
      response.appendResponseLine(`   Error: ${error.message}`);
      if (error.code === ErrorCodes.FILE_NOT_FOUND) {
        response.appendResponseLine(`   File: ${sourceMapPath}`);
      } else if (error.code === ErrorCodes.INVALID_JSON) {
        response.appendResponseLine(`   The source map file contains invalid JSON.`);
      } else if (error.code === ErrorCodes.INVALID_SOURCE_MAP) {
        response.appendResponseLine(`   The source map file is missing required fields.`);
      }
      return;
    }

    const {irId, session} = result;
    const sourceMap = session.sourceMap;
    const urlPattern = session.config.urlPattern;

    response.appendResponseLine(`✅ IR source map loaded: ${irId}`);
    response.appendResponseLine(`   Source: ${sourceMap.sourceFile} (${sourceMap.mappings.length} mappings)`);
    response.appendResponseLine(`   URL pattern: ${urlPattern}`);
    response.appendResponseLine(`   Breakpoints will be resolved when the matching script loads.`);
  },
});

/**
 * List all loaded IR source maps.
 */
export const listIrSourceMaps = defineTool({
  name: 'list_ir_source_maps',
  description: `List all loaded IR source maps with their IR IDs, paths, URL patterns, and breakpoint counts.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (_request, response, _context) => {
    const sourceMaps = listSourceMaps();

    if (sourceMaps.length === 0) {
      response.appendResponseLine('No IR source maps loaded.');
      return;
    }

    response.appendResponseLine(`Loaded IR source maps (${sourceMaps.length}):`);
    response.appendResponseLine('');

    for (const sourceMap of sourceMaps) {
      response.appendResponseLine(`📍 ${sourceMap.irId}`);
      response.appendResponseLine(`   Source Map: ${sourceMap.sourceMapPath}`);
      response.appendResponseLine(`   URL: ${sourceMap.urlPattern}`);
      response.appendResponseLine(`   ASM Path: ${sourceMap.asmPath}`);
      response.appendResponseLine(`   Breakpoints: ${sourceMap.breakpointCount}`);
      response.appendResponseLine('');
    }
  },
});

/**
 * Unload an IR source map.
 * Clears all breakpoints associated with the source map before removal.
 */
export const unloadIrSourceMap = defineTool({
  name: 'unload_ir_source_map',
  description: `Unload an IR source map and clear all its associated breakpoints. The IR ID is returned by load_ir_source_map or list_ir_source_maps.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    irId: zod
      .string()
      .describe('The IR ID to unload (returned by load_ir_source_map or list_ir_source_maps).'),
  },
  handler: async (request, response, context) => {
    const {irId} = request.params;

    // First get the source map to access its breakpoints
    const getResult = getSourceMap(irId);
    if (!getResult.success) {
      response.appendResponseLine(`❌ Failed to unload IR source map`);
      response.appendResponseLine(`   Error: ${getResult.error.message}`);
      return;
    }

    const session = getResult.session;
    const breakpointCount = session.getBreakpointCount();

    // Remove CDP breakpoints if there are any
    if (breakpointCount > 0) {
      try {
        const page = context.getSelectedPage();
        const cdpSession = await getCdpSession(page);

        // Get all CDP breakpoint IDs before clearing
        const cdpBreakpointIds = Array.from(session.breakpoints.values()).map(
          (bp) => bp.cdpBreakpointId
        );

        // Remove each CDP breakpoint and its IR metadata
        for (const cdpBreakpointId of cdpBreakpointIds) {
          try {
            await cdpSession.send('Debugger.removeBreakpoint', {
              breakpointId: cdpBreakpointId,
            });
            untrackBreakpoint(page, cdpBreakpointId);
            removeIRBreakpointMetadata(cdpBreakpointId);
          } catch {
            // Breakpoint may already be removed, still clean up metadata
            removeIRBreakpointMetadata(cdpBreakpointId);
          }
        }
      } catch {
        // If we can't get CDP session, just proceed with source map removal
        // Still clear all IR breakpoint metadata for this irId
        clearIRBreakpointMetadataByIrId(irId);
      }
    }

    // Unload the source map
    const result = unloadSourceMap(irId);

    if (!result.success) {
      response.appendResponseLine(`❌ Failed to unload IR source map`);
      response.appendResponseLine(`   Error: ${result.error.message}`);
      return;
    }

    response.appendResponseLine(`✅ IR source map unloaded`);
    response.appendResponseLine(`   IR ID: ${irId}`);
    response.appendResponseLine(`   Breakpoints cleared: ${breakpointCount}`);
  },
});

/**
 * Set an IR breakpoint at a specific IR line.
 */
export const irSetBreakpoint = defineTool({
  name: 'ir_set_breakpoint',
  description: `Set a breakpoint at a specific IR line. The breakpoint will be set on the corresponding location in the original JS file with the appropriate condition from the source map.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    irId: zod
      .string()
      .describe('The IR ID from load_ir_source_map.'),
    irLine: zod
      .number()
      .int()
      .positive()
      .describe('The IR line number to set the breakpoint at.'),
  },
  handler: async (request, response, context) => {
    const {irId, irLine} = request.params;

    // Get the IR session
    const getResult = getSourceMap(irId);
    if (!getResult.success) {
      response.appendResponseLine(`❌ Failed to set IR breakpoint`);
      response.appendResponseLine(`   Error: ${getResult.error.message}`);
      return;
    }

    const irSession = getResult.session;

    // Look up the mapping
    const mapping = irSession.getMappingByLine(irLine);
    const breakpointKey = `line:${irLine}`;

    if (!mapping) {
      response.appendResponseLine(`❌ No mapping found for IR line ${irLine}`);
      response.appendResponseLine(`   The specified IR line is not mapped to any source location.`);
      return;
    }

    // Get base condition from mapping
    const baseCondition = fromMapping(mapping);

    // Set the CDP breakpoint
    const page = context.getSelectedPage();
    const cdpSession = await initializeDebuggerForPage(page, {forceEnable: true});

    const cdpParams: any = {
      lineNumber: mapping.source.line - 1, // CDP uses 0-based line numbers
      urlRegex: irSession.config.urlPattern,
      columnNumber: mapping.source.column,
    };

    if (baseCondition) {
      cdpParams.condition = baseCondition;
    }

    try {
      const result = await cdpSession.send('Debugger.setBreakpointByUrl', cdpParams);
      const cdpBreakpointId = (result as any).breakpointId;
      const locations = (result as any).locations || [];

      // Track the breakpoint (will resolve when script loads if not already)
      trackBreakpoint(page, cdpBreakpointId);

      // Store IR breakpoint metadata for list_breakpoints integration
      setIRBreakpointMetadata(cdpBreakpointId, {
        irId,
        irLine,
        irAddr: mapping.irAddr,
        opcodeName: mapping.opcodeName,
      });

      // Store in IR session
      irSession.addBreakpoint(breakpointKey, {
        irLine: irLine,
        irAddr: mapping.irAddr,
        cdpBreakpointId,
        condition: baseCondition,
      });

      if (locations.length > 0) {
        response.appendResponseLine(`✅ Breakpoint set at IR line ${irLine} (addr: ${mapping.irAddr}, ${mapping.opcodeName})`);
      } else {
        response.appendResponseLine(`✅ Breakpoint set at IR line ${irLine} (addr: ${mapping.irAddr}, ${mapping.opcodeName}) - pending script load`);
      }
    } catch (error) {
      response.appendResponseLine(`❌ Failed to set IR breakpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});


/**
 * Remove an IR breakpoint at a specific IR line.
 */
export const irRemoveBreakpoint = defineTool({
  name: 'ir_remove_breakpoint',
  description: `Remove a breakpoint at a specific IR line. The breakpoint must have been set using ir_set_breakpoint.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    irId: zod
      .string()
      .describe('The IR ID from load_ir_source_map.'),
    irLine: zod
      .number()
      .int()
      .positive()
      .describe('The IR line number of the breakpoint to remove.'),
  },
  handler: async (request, response, context) => {
    const {irId, irLine} = request.params;

    // Get the IR session
    const getResult = getSourceMap(irId);
    if (!getResult.success) {
      response.appendResponseLine(`❌ Failed to remove IR breakpoint`);
      response.appendResponseLine(`   Error: ${getResult.error.message}`);
      return;
    }

    const irSession = getResult.session;
    const breakpointKey = `line:${irLine}`;

    // Get the breakpoint info
    const breakpointInfo = irSession.getBreakpoint(breakpointKey);

    if (!breakpointInfo) {
      response.appendResponseLine(`⚠️ No breakpoint found at IR line ${irLine}`);
      return;
    }

    // Remove the CDP breakpoint
    const page = context.getSelectedPage();
    const cdpSession = await getCdpSession(page);

    try {
      await cdpSession.send('Debugger.removeBreakpoint', {
        breakpointId: breakpointInfo.cdpBreakpointId,
      });
      untrackBreakpoint(page, breakpointInfo.cdpBreakpointId);
      removeIRBreakpointMetadata(breakpointInfo.cdpBreakpointId);
      irSession.removeBreakpoint(breakpointKey);

      response.appendResponseLine(`✅ IR breakpoint removed`);
      response.appendResponseLine(`   IR line: ${irLine}`);
      response.appendResponseLine(`   CDP Breakpoint ID: ${breakpointInfo.cdpBreakpointId}`);
    } catch (error) {
      // Breakpoint may already be removed, clean up tracking
      untrackBreakpoint(page, breakpointInfo.cdpBreakpointId);
      removeIRBreakpointMetadata(breakpointInfo.cdpBreakpointId);
      irSession.removeBreakpoint(breakpointKey);
      response.appendResponseLine(`⚠️ Breakpoint "${breakpointInfo.cdpBreakpointId}" not found or already removed.`);
    }
  },
});


/**
 * Clear all breakpoints for a specific IR source map.
 */
export const irClearBreakpoints = defineTool({
  name: 'ir_clear_breakpoints',
  description: `Clear all breakpoints for a specific IR source map. The source map itself is preserved, allowing you to set new breakpoints without reloading it.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    irId: zod
      .string()
      .describe('The IR ID from load_ir_source_map.'),
  },
  handler: async (request, response, context) => {
    const {irId} = request.params;

    // Get the IR session
    const getResult = getSourceMap(irId);
    if (!getResult.success) {
      response.appendResponseLine(`❌ Failed to clear IR breakpoints`);
      response.appendResponseLine(`   Error: ${getResult.error.message}`);
      return;
    }

    const irSession = getResult.session;
    const breakpointCount = irSession.getBreakpointCount();

    if (breakpointCount === 0) {
      response.appendResponseLine(`ℹ️ No breakpoints to clear for IR ID ${irId}`);
      return;
    }

    // Get all CDP breakpoint IDs before clearing
    const cdpBreakpointIds = Array.from(irSession.breakpoints.values()).map(
      (bp) => bp.cdpBreakpointId
    );

    // Remove CDP breakpoints
    const page = context.getSelectedPage();
    const cdpSession = await getCdpSession(page);

    let removedCount = 0;

    for (const cdpBreakpointId of cdpBreakpointIds) {
      try {
        await cdpSession.send('Debugger.removeBreakpoint', {
          breakpointId: cdpBreakpointId,
        });
        untrackBreakpoint(page, cdpBreakpointId);
        removeIRBreakpointMetadata(cdpBreakpointId);
        removedCount++;
      } catch (error) {
        // Breakpoint may already be removed, still count it and clean up metadata
        untrackBreakpoint(page, cdpBreakpointId);
        removeIRBreakpointMetadata(cdpBreakpointId);
        removedCount++;
      }
    }

    // Clear the session's breakpoint tracking
    irSession.clearBreakpoints();

    response.appendResponseLine(`✅ Cleared ${removedCount} breakpoint(s) for IR ID ${irId}`);
  },
});


/**
 * Get the current IR state when paused at a breakpoint.
 * Extracts VM state and displays it in IR form with variables like $stack[0], $scope[0].
 */
export const irGetState = defineTool({
  name: 'ir_get_state',
  description: `Get the current IR state when paused at a breakpoint. Extracts VM state and displays it in IR form with variables like $pc, $sp, $stack[n], $scope[n]. The debugger must be paused for this to work. IR ID is optional - if not provided, it will be auto-detected from the paused location.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    irId: zod
      .string()
      .optional()
      .describe('The IR ID from load_ir_source_map. Optional - auto-detected from paused location if not provided.'),
    frameIndex: zod
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('The call frame index to extract state from (default: 0, the topmost frame).'),
    maxValueLength: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum length for displayed values before truncation (default: 300).'),
    contextLines: zod
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Number of IR code lines to show before and after the current line (default: 5, set to 0 to disable).'),
  },
  handler: async (request, response, context) => {
    const {irId: providedIrId, frameIndex = 0, maxValueLength = 300, contextLines = 5} = request.params;

    // Get the page and debugger state first
    const page = context.getSelectedPage();
    const debuggerState = getDebuggerState(page);

    // Check if debugger is paused
    if (!debuggerState.isPaused) {
      response.appendResponseLine(`❌ Debugger is not paused`);
      response.appendResponseLine(`   The debugger must be paused at a breakpoint to extract IR state.`);
      response.appendResponseLine(`   Use ir_set_breakpoint to set a breakpoint and wait for execution to pause.`);
      return;
    }

    // Get the IR session - either from provided ID or auto-detect from paused location
    let irSession;
    if (providedIrId) {
      const getResult = getSourceMap(providedIrId);
      if (!getResult.success) {
        response.appendResponseLine(`❌ Failed to get IR state`);
        response.appendResponseLine(`   Error: ${getResult.error.message}`);
        return;
      }
      irSession = getResult.session;
    } else {
      // Auto-detect session from paused call frame URL
      const callFrames = debuggerState.pausedCallFrames;
      if (!callFrames || callFrames.length === 0) {
        response.appendResponseLine(`❌ No call frames available`);
        response.appendResponseLine(`   Cannot auto-detect IR source map without call frame information.`);
        return;
      }

      const pausedUrl = callFrames[frameIndex]?.url || callFrames[0]?.url;
      if (!pausedUrl) {
        response.appendResponseLine(`❌ Cannot determine paused URL`);
        response.appendResponseLine(`   Please provide an irId explicitly.`);
        return;
      }

      const findResult = findSourceMapByUrl(pausedUrl);
      if (!findResult.success) {
        response.appendResponseLine(`❌ No IR source map found for paused URL`);
        response.appendResponseLine(`   URL: ${pausedUrl}`);
        response.appendResponseLine(`   Please load an IR source map first with load_ir_source_map.`);
        return;
      }
      irSession = findResult.session;
    }

    // Get CDP session
    const cdpSession = await getCdpSession(page);

    // Extract IR state
    const extractResult = await extractState(
      cdpSession,
      irSession,
      debuggerState,
      { frameIndex, maxValueLength, contextLines }
    );

    if (!extractResult.success) {
      response.appendResponseLine(`❌ Failed to extract IR state`);
      response.appendResponseLine(`   Error: ${extractResult.error.message}`);
      if (extractResult.error.details) {
        for (const [key, value] of Object.entries(extractResult.error.details)) {
          response.appendResponseLine(`   ${key}: ${value}`);
        }
      }
      return;
    }

    // Format and output the state
    const formattedLines = formatState(extractResult.state, { maxValueLength });
    
    response.appendResponseLine(`✅ IR State extracted successfully`);
    response.appendResponseLine('');
    
    for (const line of formattedLines) {
      response.appendResponseLine(line);
    }
  },
});
