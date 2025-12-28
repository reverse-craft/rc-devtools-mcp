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
  createSession,
  listSessions,
  removeSession,
  getSession,
} from '../utils/ir-session-manager.js';
import {ErrorCodes} from '../utils/ir-debugger-types.js';
import {getCdpSession} from '../utils/cdp.js';
import {
  trackBreakpoint,
  untrackBreakpoint,
  initializeDebuggerForPage,
  getDebuggerState,
} from '../utils/debugger-utils.js';
import {fromMapping} from '../utils/ir-condition-builder.js';
import {
  extractState,
  formatState,
} from '../utils/ir-state-extractor.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './tool-definition.js';

/**
 * Create a new IR debugging session.
 * Parses the source map and builds indexes for efficient lookups.
 * Note: Does not require the target script to be loaded - breakpoints can be set
 * before the script loads and will be resolved when the script is parsed.
 */
export const createIrDebugger = defineTool({
  name: 'create_ir_debugger',
  description: `Create a new IR debugging session for JSVMP code. Parses the source map file and builds indexes for IR line, PC address, and opcode lookups. Returns a unique session ID for subsequent operations.`,
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

    // Create the session by parsing the source map
    const result = createSession({sourceMapPath});

    if (!result.success) {
      const error = result.error;
      response.appendResponseLine(`❌ Failed to create IR debugger session`);
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

    const {sessionId, session} = result;
    const sourceMap = session.sourceMap;
    const urlPattern = session.config.urlPattern;

    response.appendResponseLine(`✅ Session created: ${sessionId}`);
    response.appendResponseLine(`   Source: ${sourceMap.sourceFile} (${sourceMap.mappings.length} mappings)`);
    response.appendResponseLine(`   URL pattern: ${urlPattern}`);
    response.appendResponseLine(`   Breakpoints will be resolved when the matching script loads.`);
  },
});

/**
 * List all active IR debugging sessions.
 */
export const listIrDebuggers = defineTool({
  name: 'list_ir_debuggers',
  description: `List all active IR debugging sessions with their source map paths, URL patterns, and breakpoint counts.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (_request, response, _context) => {
    const sessions = listSessions();

    if (sessions.length === 0) {
      response.appendResponseLine('No active IR debugger sessions.');
      return;
    }

    response.appendResponseLine(`Active IR debugger sessions (${sessions.length}):`);
    response.appendResponseLine('');

    for (const session of sessions) {
      response.appendResponseLine(`📍 ${session.sessionId}`);
      response.appendResponseLine(`   Source Map: ${session.sourceMapPath}`);
      response.appendResponseLine(`   URL: ${session.urlPattern}`);
      response.appendResponseLine(`   ASM Path: ${session.asmPath}`);
      response.appendResponseLine(`   Breakpoints: ${session.breakpointCount}`);
      response.appendResponseLine('');
    }
  },
});

/**
 * Remove an IR debugging session.
 * Clears all breakpoints associated with the session before removal.
 */
export const removeIrDebugger = defineTool({
  name: 'remove_ir_debugger',
  description: `Remove an IR debugging session and clear all its associated breakpoints. The session ID is returned by create_ir_debugger or list_ir_debuggers.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    sessionId: zod
      .string()
      .describe('The session ID to remove (returned by create_ir_debugger or list_ir_debuggers).'),
  },
  handler: async (request, response, context) => {
    const {sessionId} = request.params;

    // First get the session to access its breakpoints
    const getResult = getSession(sessionId);
    if (!getResult.success) {
      response.appendResponseLine(`❌ Failed to remove IR debugger session`);
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

        // Remove each CDP breakpoint
        for (const cdpBreakpointId of cdpBreakpointIds) {
          try {
            await cdpSession.send('Debugger.removeBreakpoint', {
              breakpointId: cdpBreakpointId,
            });
            untrackBreakpoint(page, cdpBreakpointId);
          } catch {
            // Breakpoint may already be removed, continue
          }
        }
      } catch {
        // If we can't get CDP session, just proceed with session removal
      }
    }

    // Remove the session
    const result = removeSession(sessionId);

    if (!result.success) {
      response.appendResponseLine(`❌ Failed to remove IR debugger session`);
      response.appendResponseLine(`   Error: ${result.error.message}`);
      return;
    }

    response.appendResponseLine(`✅ IR debugger session removed`);
    response.appendResponseLine(`   Session ID: ${sessionId}`);
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
    sessionId: zod
      .string()
      .describe('The IR debugger session ID.'),
    irLine: zod
      .number()
      .int()
      .positive()
      .describe('The IR line number to set the breakpoint at.'),
  },
  handler: async (request, response, context) => {
    const {sessionId, irLine} = request.params;

    // Get the IR session
    const getResult = getSession(sessionId);
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
    sessionId: zod
      .string()
      .describe('The IR debugger session ID.'),
    irLine: zod
      .number()
      .int()
      .positive()
      .describe('The IR line number of the breakpoint to remove.'),
  },
  handler: async (request, response, context) => {
    const {sessionId, irLine} = request.params;

    // Get the IR session
    const getResult = getSession(sessionId);
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
      irSession.removeBreakpoint(breakpointKey);

      response.appendResponseLine(`✅ IR breakpoint removed`);
      response.appendResponseLine(`   IR line: ${irLine}`);
      response.appendResponseLine(`   CDP Breakpoint ID: ${breakpointInfo.cdpBreakpointId}`);
    } catch (error) {
      // Breakpoint may already be removed, clean up tracking
      untrackBreakpoint(page, breakpointInfo.cdpBreakpointId);
      irSession.removeBreakpoint(breakpointKey);
      response.appendResponseLine(`⚠️ Breakpoint "${breakpointInfo.cdpBreakpointId}" not found or already removed.`);
    }
  },
});


/**
 * Clear all breakpoints in an IR debugging session.
 */
export const irClearBreakpoints = defineTool({
  name: 'ir_clear_breakpoints',
  description: `Clear all breakpoints in an IR debugging session. The session itself is preserved, allowing you to set new breakpoints without recreating the session.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    sessionId: zod
      .string()
      .describe('The IR debugger session ID.'),
  },
  handler: async (request, response, context) => {
    const {sessionId} = request.params;

    // Get the IR session
    const getResult = getSession(sessionId);
    if (!getResult.success) {
      response.appendResponseLine(`❌ Failed to clear IR breakpoints`);
      response.appendResponseLine(`   Error: ${getResult.error.message}`);
      return;
    }

    const irSession = getResult.session;
    const breakpointCount = irSession.getBreakpointCount();

    if (breakpointCount === 0) {
      response.appendResponseLine(`ℹ️ No breakpoints to clear in session ${sessionId}`);
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
        removedCount++;
      } catch (error) {
        // Breakpoint may already be removed, still count it
        untrackBreakpoint(page, cdpBreakpointId);
        removedCount++;
      }
    }

    // Clear the session's breakpoint tracking
    irSession.clearBreakpoints();

    response.appendResponseLine(`✅ Cleared ${removedCount} breakpoint(s) from session ${sessionId}`);
  },
});


/**
 * Get the current IR state when paused at a breakpoint.
 * Extracts VM state and displays it in IR form with variables like $stack[0], $scope[0].
 */
export const irGetState = defineTool({
  name: 'ir_get_state',
  description: `Get the current IR state when paused at a breakpoint. Extracts VM state and displays it in IR form with variables like $pc, $sp, $stack[n], $scope[n]. The debugger must be paused for this to work.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    sessionId: zod
      .string()
      .describe('The IR debugger session ID.'),
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
    const {sessionId, frameIndex = 0, maxValueLength = 300, contextLines = 5} = request.params;

    // Get the IR session
    const getResult = getSession(sessionId);
    if (!getResult.success) {
      response.appendResponseLine(`❌ Failed to get IR state`);
      response.appendResponseLine(`   Error: ${getResult.error.message}`);
      return;
    }

    const irSession = getResult.session;

    // Get the page and debugger state
    const page = context.getSelectedPage();
    const debuggerState = getDebuggerState(page);

    // Check if debugger is paused
    if (!debuggerState.isPaused) {
      response.appendResponseLine(`❌ Debugger is not paused`);
      response.appendResponseLine(`   The debugger must be paused at a breakpoint to extract IR state.`);
      response.appendResponseLine(`   Use ir_set_breakpoint to set a breakpoint and wait for execution to pause.`);
      return;
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
