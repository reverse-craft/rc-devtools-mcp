/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Debugger tools for rc-devtools-mcp.
 * Provides JavaScript debugging capabilities including breakpoints, stepping, and variable inspection.
 */

import {logger} from '../utils/logger.js';
import type {CDPSession, Page} from '../third-party/index.js';
import {zod} from '../third-party/index.js';
import {getCdpSession} from '../utils/cdp.js';
import {getConfig} from '../utils/config.js';
import {
  extractContextCode,
  formatContextCodeOutput,
} from '../utils/context-code-utils.js';
import type {
  DebuggerState,
  CallFrame,
  ScopeInfo} from '../utils/debugger-utils.js';
import {
  getDebuggerState,
  initializeDebuggerForPage,
  getActiveBreakpoints,
  trackBreakpoint,
  untrackBreakpoint,
  clearTrackedBreakpoints,
  trackXhrBreakpoint,
  untrackXhrBreakpoint,
  getTrackedXhrBreakpoints,
  clearTrackedXhrBreakpoints,
  getIRBreakpointMetadata,
} from '../utils/debugger-utils.js';
import {paginate} from '../utils/pagination.js';
import {
  findMatchingScripts,
  findNearestBreakpointLocation,
  queryPossibleBreakpoints,
  cacheScript,
  clearScriptCache,
  getScriptCache,
  getScriptSource,
  type BreakpointLocation,
} from '../utils/smart-breakpoint-utils.js';

import {clearParseResultCache} from './analysis.js';
import {ToolCategory} from './categories.js';
import {defineTool} from './tool-definition.js';
import {findSourceMapByUrl} from '../utils/ir-session-manager.js';
import {extractState, formatState} from '../utils/ir-state-extractor.js';


/**
 * Format a runtime value for display, with truncation for long values.
 */
function formatValue(
  value: any,
  maxLength = getConfig().maxInlineStringLength,
): {formatted: string; truncated: boolean} {
  if (value === undefined) return {formatted: 'undefined', truncated: false};
  if (value === null) return {formatted: 'null', truncated: false};

  let str: string;
  if (typeof value === 'string') {
    str = JSON.stringify(value);
  } else if (typeof value === 'object') {
    try {
      str = JSON.stringify(value);
    } catch {
      str = String(value);
    }
  } else {
    str = String(value);
  }

  if (str.length > maxLength) {
    return {
      formatted: str.substring(0, maxLength) + '...',
      truncated: true,
    };
  }
  return {formatted: str, truncated: false};
}

/**
 * Format a VM value for display in IR context, with truncation for long values.
 */
function formatVMValue(value: unknown, maxLength: number): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';

  let str: string;
  if (typeof value === 'string') {
    str = JSON.stringify(value);
  } else if (typeof value === 'object') {
    try {
      str = JSON.stringify(value);
    } catch {
      str = String(value);
    }
  } else {
    str = String(value);
  }

  if (str.length > maxLength) {
    return str.substring(0, maxLength) + ' [truncated]';
  }
  return str;
}

/**
 * Format a remote object preview for display.
 */
function formatRemoteObject(obj: any, maxLength = getConfig().maxInlineStringLength): {
  formatted: string;
  truncated: boolean;
  type: string;
} {
  const type = obj.type || 'unknown';
  const subtype = obj.subtype;

  // Handle primitive values
  if (obj.value !== undefined) {
    const result = formatValue(obj.value, maxLength);
    return {...result, type};
  }

  // Handle unserializable values
  if (obj.unserializableValue) {
    return {formatted: obj.unserializableValue, truncated: false, type};
  }

  // Handle preview for objects
  if (obj.preview) {
    const preview = obj.preview;
    if (preview.overflow) {
      const properties = preview.properties || [];
      const propStrs = properties
        .slice(0, 5)
        .map((p: any) => `${p.name}: ${p.value ?? p.type}`)
        .join(', ');
      return {
        formatted: `{${propStrs}, ...}`,
        truncated: true,
        type: subtype || type,
      };
    }
    if (preview.properties) {
      const propStrs = preview.properties.map(
        (p: any) => `${p.name}: ${p.value ?? p.type}`,
      );
      const full = `{${propStrs.join(', ')}}`;
      if (full.length > maxLength) {
        return {formatted: full.substring(0, maxLength) + '...', truncated: true, type: subtype || type};
      }
      return {formatted: full, truncated: false, type: subtype || type};
    }
  }

  // Handle description for complex objects
  if (obj.description) {
    const desc = obj.description;
    if (desc.length > maxLength) {
      return {formatted: desc.substring(0, maxLength) + '...', truncated: true, type: subtype || type};
    }
    return {formatted: desc, truncated: false, type: subtype || type};
  }

  return {formatted: `[${subtype || type}]`, truncated: false, type: subtype || type};
}

/**
 * Configuration for optimized scope variable inspection.
 */
export interface DebuggerStatusConfig {
  /** Maximum properties to show per scope (default: 10) */
  maxPropertiesPerScope: number;
  /** Whether to skip scope variable inspection entirely (default: false) */
  skipScopeVariables: boolean;
  /** Whether to use object previews instead of full property retrieval (default: true) */
  useObjectPreviews: boolean;
  /** Maximum depth for nested object inspection (default: 1) */
  maxObjectDepth: number;
  /** Maximum length of a single value string (default: 200) */
  maxLineLength?: number;
}

/**
 * Configuration for compact debug status display after step commands.
 */
export interface CompactDebugStatusConfig {
  /** Maximum call stack frames to display (default: 4) */
  maxCallStackDepth: number;
  /** Lines of code context before/after current line (default: 2) */
  contextLines: number;
  /** Maximum local variables to display (default: 5) */
  maxLocalVariables: number;
  /** Maximum characters per variable value (default: 100) */
  maxValueLength: number;
  /** Whether to show status at all (default: true) */
  showStatus: boolean;
}

/** Default configuration for compact debug status */
export const DEFAULT_COMPACT_DEBUG_CONFIG: CompactDebugStatusConfig = {
  maxCallStackDepth: 4,
  contextLines: 2,
  maxLocalVariables: 5,
  maxValueLength: 100,
  showStatus: true,
};


/**
 * Get a compact call stack representation.
 */
export function getCompactCallStack(
  callFrames: CallFrame[],
  maxCallStackDepth: number,
  scriptCache?: Map<string, {url: string}>
): string[] {
  const output: string[] = [];

  if (!callFrames || callFrames.length === 0) {
    output.push('📚 Call Stack: (empty)');
    return output;
  }

  const totalFrames = callFrames.length;
  const framesToShow = Math.min(totalFrames, maxCallStackDepth);
  const hasMoreFrames = totalFrames > maxCallStackDepth;

  output.push(`📚 Call Stack (${framesToShow}/${totalFrames}):`);

  for (let i = 0; i < framesToShow; i++) {
    const frame = callFrames[i];
    const functionName = frame.functionName || '(anonymous)';
    let url = frame.url;
    if (!url && scriptCache) {
      const scriptInfo = scriptCache.get(frame.location.scriptId);
      url = scriptInfo?.url || `VM${frame.location.scriptId}`;
    } else if (!url) {
      url = `VM${frame.location.scriptId}`;
    }
    const lineNumber = frame.location.lineNumber + 1;
    output.push(`   ${i}: ${functionName} at ${url}:${lineNumber}`);
  }

  if (hasMoreFrames) {
    output.push(`   ... ${totalFrames - maxCallStackDepth} more frames`);
  }

  return output;
}

/**
 * Get compact local variables from a call frame's scope chain.
 */
export async function getCompactLocalVariables(
  session: CDPSession,
  scopeChain: ScopeInfo[],
  maxLocalVariables: number,
  maxValueLength: number
): Promise<{lines: string[]; totalCount: number}> {
  const output: string[] = [];
  let totalCount = 0;
  const displayedVariables: Array<{name: string; type: string; value: string}> = [];

  const localScopes = scopeChain.filter((scope) => scope.type === 'local');

  for (const scope of localScopes) {
    if (!scope.object.objectId) {
      continue;
    }

    try {
      const propsResult = await session.send('Runtime.getProperties', {
        objectId: scope.object.objectId,
        ownProperties: true,
        generatePreview: true,
      });

      const properties = (propsResult as any).result || [];
      totalCount += properties.length;

      for (const prop of properties) {
        if (displayedVariables.length >= maxLocalVariables) {
          break;
        }

        if (prop.value) {
          const {formatted, type} = formatRemoteObject(prop.value, maxValueLength);
          displayedVariables.push({
            name: prop.name,
            type,
            value: formatted,
          });
        } else if (prop.get) {
          displayedVariables.push({
            name: prop.name,
            type: 'getter',
            value: '[getter]',
          });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger(`[debugger] Failed to retrieve local variables: ${errorMessage}`);
    }
  }

  if (displayedVariables.length === 0 && totalCount === 0) {
    output.push('📦 Local Variables: (none)');
  } else {
    output.push(`📦 Local Variables (${displayedVariables.length}/${totalCount}):`);
    for (const variable of displayedVariables) {
      output.push(`   ${variable.name}: (${variable.type}) ${variable.value}`);
    }
  }

  return {lines: output, totalCount};
}

/**
 * Get compact code context around the current execution location.
 */
export async function getCompactCodeContext(
  session: CDPSession,
  scriptId: string,
  lineNumber: number,
  columnNumber: number,
  contextLines: number,
  url: string
): Promise<string[]> {
  const output: string[] = [];

  if (contextLines === 0) {
    return output;
  }

  try {
    const scriptSource = await getScriptSource(session, scriptId);

    if (scriptSource === null) {
      output.push('📄 Code: (source unavailable)');
      return output;
    }

    const contextResult = extractContextCode(scriptSource, {
      lineNumber: lineNumber + 1,
      columnNumber: columnNumber,
      contextLines,
      formatMinified: false,
      maxLineLength: 200,
    });

    if (contextResult.lines.length === 0) {
      output.push('📄 Code: (no context available)');
      return output;
    }

    output.push('📄 Code:');

    for (const line of contextResult.lines) {
      const marker = line.isCurrentLine ? ' ▶' : '  ';
      const lineNum = String(line.displayLineNumber).padStart(4, ' ');
      output.push(`${marker}${lineNum} | ${line.content}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    output.push(`📄 Code: (error: ${errorMessage})`);
    logger(`[debugger] Failed to get code context: ${errorMessage}`);
  }

  return output;
}

/**
 * Get compact debug status combining call stack, code context, and local variables.
 */
export async function getCompactDebugStatus(
  session: CDPSession,
  state: DebuggerState,
  config: CompactDebugStatusConfig,
  frameIndex = 0
): Promise<string[]> {
  const output: string[] = [];

  if (!config.showStatus) {
    return output;
  }

  if (!state.isPaused || !state.pausedCallFrames || state.pausedCallFrames.length === 0) {
    output.push('⚠️ Debugger is not currently paused.');
    return output;
  }

  const callFrames = state.pausedCallFrames;
  const frame = callFrames[frameIndex];

  if (!frame) {
    output.push(`⚠️ Invalid frame index: ${frameIndex}`);
    return output;
  }

  const scriptCache = getScriptCache(session);

  const functionName = frame.functionName || '(anonymous)';
  let url = frame.url;
  if (!url) {
    const scriptInfo = scriptCache.get(frame.location.scriptId);
    url = scriptInfo?.url || `VM${frame.location.scriptId}`;
  }
  const lineNumber = frame.location.lineNumber + 1;
  const columnNumber = frame.location.columnNumber ?? 0;
  output.push(`📍 Location: ${functionName} at ${url}:${lineNumber}:${columnNumber}`);

  const callStackLines = getCompactCallStack(callFrames, config.maxCallStackDepth, scriptCache);
  output.push(...callStackLines);

  output.push('');
  const codeContextLines = await getCompactCodeContext(
    session,
    frame.location.scriptId,
    frame.location.lineNumber,
    frame.location.columnNumber ?? 0,
    config.contextLines,
    frame.url
  );
  output.push(...codeContextLines);

  output.push('');
  const {lines: variableLines} = await getCompactLocalVariables(
    session,
    frame.scopeChain,
    config.maxLocalVariables,
    config.maxValueLength
  );
  output.push(...variableLines);

  output.push('');
  output.push('ℹ️ Use get_debugger_status or get_scope_variables for full details.');

  return output;
}

/**
 * Result from waiting for the debugger to pause after a step command.
 */
export interface WaitForPausedResult {
  paused: boolean;
  reason?: string;
}

/**
 * Wait for the debugger to pause after a step command.
 */
export async function waitForPausedEvent(
  session: CDPSession,
  state: DebuggerState,
  timeoutMs = 5000
): Promise<WaitForPausedResult> {
  return new Promise((resolve) => {
    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const onPaused = (params: any) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      cleanup();
      const pauseReason = params.reason || 'step';
      resolve({paused: true, reason: pauseReason});
    };

    const onResumed = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      cleanup();
      resolve({paused: false, reason: 'resumed'});
    };

    const cleanup = () => {
      session.off('Debugger.paused', onPaused);
      session.off('Debugger.resumed', onResumed);
    };

    timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({paused: false, reason: 'timeout'});
    }, timeoutMs);

    session.on('Debugger.paused', onPaused);
    session.on('Debugger.resumed', onResumed);
  });
}

/**
 * Format a CDP preview object for display.
 */
export function formatPreview(preview: any): string {
  if (!preview) {
    return '[no preview]';
  }

  if (preview.type === 'object') {
    const props = preview.properties || [];
    if (props.length === 0) {
      return preview.subtype === 'array' ? '[]' : '{}';
    }

    const propStrs = props
      .slice(0, 3)
      .map((p: any) => `${p.name}: ${p.value ?? p.type}`)
      .join(', ');

    if (preview.subtype === 'array') {
      return preview.overflow ? `[${propStrs}, ...]` : `[${propStrs}]`;
    }
    return preview.overflow ? `{${propStrs}, ...}` : `{${propStrs}}`;
  }

  return preview.description || String(preview.value ?? '[unknown]');
}

interface ScopeInspectionResult {
  scopeName: string;
  lines: string[];
  hasTruncatedValues: boolean;
}

/**
 * Optimized scope variable inspection with parallel processing.
 */
export async function inspectScopeVariablesOptimized(
  session: CDPSession,
  scopeChain: ScopeInfo[],
  config: DebuggerStatusConfig
): Promise<{lines: string[]; hasTruncatedValues: boolean}> {
  const output: string[] = [];
  let hasTruncatedValues = false;

  if (config.skipScopeVariables) {
    output.push('   [Scope inspection skipped - use get_scope_variables for details]');
    return {lines: output, hasTruncatedValues: false};
  }

  const scopePromises = scopeChain.map(async (scope): Promise<ScopeInspectionResult> => {
    if (scope.type === 'global') {
      return {
        scopeName: 'global',
        lines: ['   [global] (use get_scope_variables to inspect)'],
        hasTruncatedValues: false,
      };
    }

    const scopeName = scope.name ? `${scope.type}: ${scope.name}` : scope.type;
    const lines: string[] = [`   [${scopeName}]`];
    let scopeHasTruncatedValues = false;

    if (!scope.object.objectId) {
      lines.push('      (no properties)');
      return {scopeName, lines, hasTruncatedValues: false};
    }

    try {
      const propsResult = await session.send('Runtime.getProperties', {
        objectId: scope.object.objectId,
        ownProperties: true,
        generatePreview: true,
      });

      const properties = (propsResult as any).result || [];
      const displayProps = properties.slice(0, config.maxPropertiesPerScope);
      const hasMore = properties.length > config.maxPropertiesPerScope;

      for (const prop of displayProps) {
        if (prop.value) {
          if (config.useObjectPreviews && prop.value.preview) {
            const preview = formatPreview(prop.value.preview);
            const type = prop.value.subtype || prop.value.type;
            lines.push(`      ${prop.name}: (${type}) ${preview}`);
            if (prop.value.preview.overflow) {
              scopeHasTruncatedValues = true;
            }
          } else {
            const {formatted, truncated, type} = formatRemoteObject(prop.value, config.maxLineLength);
            scopeHasTruncatedValues = scopeHasTruncatedValues || truncated;
            const truncMark = truncated ? ' [truncated]' : '';
            lines.push(`      ${prop.name}: (${type}) ${formatted}${truncMark}`);
          }
        } else if (prop.get) {
          lines.push(`      ${prop.name}: [getter]`);
        }
      }

      if (hasMore) {
        lines.push(`      ... and ${properties.length - config.maxPropertiesPerScope} more properties`);
        scopeHasTruncatedValues = true;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      lines.push(`      (unable to retrieve properties: ${errorMessage})`);
      logger(`[debugger] Failed to retrieve properties for scope ${scopeName}: ${error}`);
    }

    return {scopeName, lines, hasTruncatedValues: scopeHasTruncatedValues};
  });

  const results = await Promise.all(scopePromises);

  for (const result of results) {
    output.push(...result.lines);
    hasTruncatedValues = hasTruncatedValues || result.hasTruncatedValues;
  }

  return {lines: output, hasTruncatedValues};
}


export const setBreakpoint = defineTool({
  name: 'set_breakpoint',
  description: `Set a JavaScript breakpoint at a specific line in a file matching a URL pattern. Supports smart snapping for minified code. Returns the CDP breakpoint ID which can be used to remove the breakpoint later.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    urlRegex: zod
      .string()
      .describe(
        'Regular expression to match the URL of the script file. Use ".*filename\\.js.*" pattern.',
      ),
    lineNumber: zod
      .number()
      .int()
      .positive()
      .describe(
        'The line number to set the breakpoint at (1-based, as shown in editors).',
      ),
    columnNumber: zod
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Optional target column number (0-based) for smart snapping.',
      ),
    snapRange: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Search range around the target column for finding valid breakpoint positions. Defaults to 100.',
      ),
    condition: zod
      .string()
      .optional()
      .describe(
        'Optional JavaScript expression. The breakpoint only triggers when this evaluates to true.',
      ),
  },
  handler: async (request, response, context) => {
    const {urlRegex, lineNumber, columnNumber, snapRange = 100, condition} =
      request.params;
    const page = context.getSelectedPage();
    const session = await initializeDebuggerForPage(page, { forceEnable: true });

    if (columnNumber !== undefined && columnNumber < 0) {
      response.appendResponseLine(`❌ Invalid column number: ${columnNumber}`);
      response.appendResponseLine('   Column numbers must be non-negative (0 or greater).');
      return;
    }

    const cdpLineNumber = lineNumber - 1;
    const targetColumn = columnNumber ?? 0;
    let snappedColumn = targetColumn;
    let wasSnapped = false;

    if (columnNumber !== undefined) {
      const matchingScripts = await findMatchingScripts(session, urlRegex);

      if (matchingScripts.length === 0) {
        response.appendResponseLine(`❌ Failed to set breakpoint: No scripts found matching pattern "${urlRegex}"`);
        return;
      }

      const startColumn = Math.max(0, targetColumn - snapRange);
      const endColumn = targetColumn + snapRange;

      let allLocations: BreakpointLocation[] = [];
      for (const script of matchingScripts) {
        const locations = await queryPossibleBreakpoints(
          session,
          script.scriptId,
          cdpLineNumber,
          startColumn,
          cdpLineNumber,
          endColumn,
          script.url
        );
        allLocations = allLocations.concat(locations);
      }

      if (allLocations.length === 0) {
        response.appendResponseLine(`❌ Failed to set breakpoint: No valid breakpoint positions found`);
        return;
      }

      const nearest = findNearestBreakpointLocation(allLocations, targetColumn);
      if (nearest) {
        snappedColumn = nearest.columnNumber;
        wasSnapped = snappedColumn !== targetColumn;
      }
    }

    const params: any = {
      lineNumber: cdpLineNumber,
      urlRegex,
      columnNumber: snappedColumn,
    };

    if (condition) {
      params.condition = condition;
    }

    try {
      const result = await session.send('Debugger.setBreakpointByUrl', params);
      const cdpBreakpointId = (result as any).breakpointId;

      const locations = (result as any).locations;
      if (locations && locations.length > 0) {
        trackBreakpoint(page, cdpBreakpointId);
        
        const firstLoc = locations[0];
        const resolvedLine = firstLoc.lineNumber + 1;
        const resolvedColumn = firstLoc.columnNumber;

        const actuallySnapped = wasSnapped || 
          resolvedLine !== lineNumber || 
          resolvedColumn !== snappedColumn;

        response.appendResponseLine(`✅ Breakpoint set successfully`);
        response.appendResponseLine(`   Breakpoint ID: ${cdpBreakpointId}`);
        
        if (actuallySnapped) {
          response.appendResponseLine('⚡ Snapped to nearest valid position');
        }
        
        response.appendResponseLine(`   URL pattern: ${urlRegex}`);
        
        if (columnNumber !== undefined) {
          response.appendResponseLine(`   Requested: line ${lineNumber}, column ${columnNumber}`);
          response.appendResponseLine(`   Resolved:  line ${resolvedLine}, column ${resolvedColumn}`);
        } else {
          response.appendResponseLine(`   Line: ${lineNumber}`);
          if (resolvedLine !== lineNumber) {
            response.appendResponseLine(`   Resolved line: ${resolvedLine}`);
          }
        }
        
        if (condition) {
          response.appendResponseLine(`   Condition: ${condition}`);
        }
        response.appendResponseLine('');
        response.appendResponseLine('📍 Resolved locations:');
        for (const loc of locations) {
          const scriptCache = getScriptCache(session);
          const scriptInfo = scriptCache.get(loc.scriptId);
          const scriptUrl = scriptInfo?.url || `Script ${loc.scriptId}`;
          response.appendResponseLine(
            `   ${scriptUrl}:${loc.lineNumber + 1}:${loc.columnNumber}`,
          );
        }
      } else {
        await session.send('Debugger.removeBreakpoint', {
          breakpointId: cdpBreakpointId,
        });
        response.appendResponseLine(`❌ Failed to set breakpoint: No matching scripts found`);
      }
    } catch (error) {
      response.appendResponseLine(`❌ Failed to set breakpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

export const removeBreakpoint = defineTool({
  name: 'remove_breakpoint',
  description: `Remove a previously set JavaScript breakpoint by its CDP breakpoint ID.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    breakpointId: zod
      .string()
      .describe('The CDP breakpoint ID to remove (returned by set_breakpoint or list_breakpoints).'),
  },
  handler: async (request, response, context) => {
    const {breakpointId} = request.params;
    const page = context.getSelectedPage();
    const session = await getCdpSession(page);

    try {
      await session.send('Debugger.removeBreakpoint', {
        breakpointId,
      });

      untrackBreakpoint(page, breakpointId);
      response.appendResponseLine(`✅ Removed breakpoint "${breakpointId}"`);
    } catch (error) {
      untrackBreakpoint(page, breakpointId);
      response.appendResponseLine(
        `⚠️ Breakpoint "${breakpointId}" not found or already removed.`,
      );
    }
  },
});

export const listBreakpoints = defineTool({
  name: 'list_breakpoints',
  description: `List all active JavaScript breakpoints on the current page.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    searchTerm: zod
      .string()
      .optional()
      .describe('Search term to filter breakpoints by ID or URL pattern.'),
    pageSize: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum number of breakpoints to return per page.'),
    pageIdx: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Page number to return (0-based).'),
  },
  handler: async (request, response, context) => {
    const {searchTerm, pageSize, pageIdx} = request.params;
    const page = context.getSelectedPage();
    
    let breakpoints = await getActiveBreakpoints(page);

    if (breakpoints.length === 0) {
      response.appendResponseLine('No active breakpoints.');
      return;
    }

    if (searchTerm) {
      const lowerSearchTerm = searchTerm.toLowerCase();
      breakpoints = breakpoints.filter(bp =>
        bp.breakpointId.toLowerCase().includes(lowerSearchTerm) ||
        bp.url.toLowerCase().includes(lowerSearchTerm)
      );
      if (breakpoints.length === 0) {
        response.appendResponseLine(`No breakpoints matching "${searchTerm}" found.`);
        return;
      }
    }

    const paginationResult = paginate(breakpoints, {pageSize, pageIdx});

    response.appendResponseLine(`Active breakpoints (${breakpoints.length} total):`);
    
    if (paginationResult.totalPages > 1) {
      response.appendResponseLine(
        `Showing ${paginationResult.startIndex + 1}-${paginationResult.endIndex} (Page ${paginationResult.currentPage + 1} of ${paginationResult.totalPages})`
      );
    }
    response.appendResponseLine('');

    for (const bp of paginationResult.items) {
      response.appendResponseLine(`📍 ${bp.breakpointId}`);
      response.appendResponseLine(`   URL pattern: ${bp.url}`);
      response.appendResponseLine(`   Line: ${bp.lineNumber}, Column: ${bp.columnNumber}`);
      
      // Check if this is an IR breakpoint and display IR information
      const irMetadata = getIRBreakpointMetadata(bp.breakpointId);
      if (irMetadata) {
        response.appendResponseLine(`   🔧 IR: ID=${irMetadata.irId}, Line=${irMetadata.irLine}, Opcode=${irMetadata.opcodeName}`);
      }
      
      if (bp.condition) {
        response.appendResponseLine(`   Condition: ${bp.condition}`);
      }
      response.appendResponseLine('');
    }
  },
});

export const clearAllBreakpoints = defineTool({
  name: 'clear_all_breakpoints',
  description: `Remove all active JavaScript breakpoints on the current page.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {},
  handler: async (_request, response, context) => {
    const page = context.getSelectedPage();
    const state = getDebuggerState(page);
    const session = await getCdpSession(page);

    if (state.isPaused) {
      try {
        await session.send('Debugger.resume');
        state.isPaused = false;
        state.pausedCallFrames = undefined;
        response.appendResponseLine('▶️ Resumed paused execution.');
      } catch (error) {
        response.appendResponseLine(
          `⚠️ Failed to resume execution: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const breakpoints = await getActiveBreakpoints(page);
    const count = breakpoints.length;
    const errors: string[] = [];

    for (const bp of breakpoints) {
      try {
        await session.send('Debugger.removeBreakpoint', {
          breakpointId: bp.breakpointId,
        });
      } catch (error) {
        errors.push(`${bp.breakpointId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    clearTrackedBreakpoints(page);

    if (errors.length > 0) {
      response.appendResponseLine(`⚠️ Cleared ${count - errors.length}/${count} breakpoints.`);
    } else {
      response.appendResponseLine(`✅ Cleared ${count} breakpoint(s).`);
    }
  },
});

export const resumeExecution = defineTool({
  name: 'resume_execution',
  description: `Resume JavaScript execution after hitting a breakpoint.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {},
  handler: async (_request, response, context) => {
    const page = context.getSelectedPage();
    const state = getDebuggerState(page);

    if (!state.isPaused) {
      response.appendResponseLine('⚠️ Debugger is not currently paused.');
      return;
    }

    const session = await getCdpSession(page);

    try {
      await session.send('Debugger.resume');
      state.isPaused = false;
      state.pausedCallFrames = undefined;
      response.appendResponseLine('✅ Execution resumed.');
    } catch (error) {
      response.appendResponseLine(
        `❌ Failed to resume: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});


export const stepOver = defineTool({
  name: 'step_over',
  description: `Step over to the next line of code without stepping into function calls.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    maxCallStackDepth: zod.number().int().positive().default(4).optional(),
    contextLines: zod.number().int().nonnegative().default(2).optional(),
    maxLocalVariables: zod.number().int().positive().default(5).optional(),
    showStatus: zod.boolean().default(true).optional(),
  },
  handler: async (request, response, context) => {
    const {
      maxCallStackDepth = DEFAULT_COMPACT_DEBUG_CONFIG.maxCallStackDepth,
      contextLines = DEFAULT_COMPACT_DEBUG_CONFIG.contextLines,
      maxLocalVariables = DEFAULT_COMPACT_DEBUG_CONFIG.maxLocalVariables,
      showStatus = DEFAULT_COMPACT_DEBUG_CONFIG.showStatus,
    } = request.params;

    const page = context.getSelectedPage();
    const state = getDebuggerState(page);

    if (!state.isPaused) {
      response.appendResponseLine('⚠️ Debugger is not currently paused.');
      return;
    }

    const session = await getCdpSession(page);

    try {
      await session.send('Debugger.stepOver');
      response.appendResponseLine('✅ Stepped over to next line.');

      const pauseResult = await waitForPausedEvent(session, state);

      if (pauseResult.paused && showStatus) {
        response.appendResponseLine('');
        const config: CompactDebugStatusConfig = {
          maxCallStackDepth,
          contextLines,
          maxLocalVariables,
          maxValueLength: DEFAULT_COMPACT_DEBUG_CONFIG.maxValueLength,
          showStatus,
        };
        const statusLines = await getCompactDebugStatus(session, state, config);
        for (const line of statusLines) {
          response.appendResponseLine(line);
        }
      } else if (!pauseResult.paused) {
        if (pauseResult.reason === 'resumed') {
          response.appendResponseLine('');
          response.appendResponseLine('ℹ️ Execution has finished.');
        }
      }
    } catch (error) {
      response.appendResponseLine(
        `❌ Failed to step over: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

export const stepInto = defineTool({
  name: 'step_into',
  description: `Step into a function call at the current line.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    maxCallStackDepth: zod.number().int().positive().default(4).optional(),
    contextLines: zod.number().int().nonnegative().default(2).optional(),
    maxLocalVariables: zod.number().int().positive().default(5).optional(),
    showStatus: zod.boolean().default(true).optional(),
  },
  handler: async (request, response, context) => {
    const {
      maxCallStackDepth = DEFAULT_COMPACT_DEBUG_CONFIG.maxCallStackDepth,
      contextLines = DEFAULT_COMPACT_DEBUG_CONFIG.contextLines,
      maxLocalVariables = DEFAULT_COMPACT_DEBUG_CONFIG.maxLocalVariables,
      showStatus = DEFAULT_COMPACT_DEBUG_CONFIG.showStatus,
    } = request.params;

    const page = context.getSelectedPage();
    const state = getDebuggerState(page);

    if (!state.isPaused) {
      response.appendResponseLine('⚠️ Debugger is not currently paused.');
      return;
    }

    const session = await getCdpSession(page);

    try {
      await session.send('Debugger.stepInto');
      response.appendResponseLine('✅ Stepped into function.');

      const pauseResult = await waitForPausedEvent(session, state);

      if (pauseResult.paused && showStatus) {
        response.appendResponseLine('');
        const config: CompactDebugStatusConfig = {
          maxCallStackDepth,
          contextLines,
          maxLocalVariables,
          maxValueLength: DEFAULT_COMPACT_DEBUG_CONFIG.maxValueLength,
          showStatus,
        };
        const statusLines = await getCompactDebugStatus(session, state, config);
        for (const line of statusLines) {
          response.appendResponseLine(line);
        }
      } else if (!pauseResult.paused) {
        if (pauseResult.reason === 'resumed') {
          response.appendResponseLine('');
          response.appendResponseLine('ℹ️ Execution has finished.');
        }
      }
    } catch (error) {
      response.appendResponseLine(
        `❌ Failed to step into: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

export const stepOut = defineTool({
  name: 'step_out',
  description: `Step out of the current function to return to the caller.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    maxCallStackDepth: zod.number().int().positive().default(4).optional(),
    contextLines: zod.number().int().nonnegative().default(2).optional(),
    maxLocalVariables: zod.number().int().positive().default(5).optional(),
    showStatus: zod.boolean().default(true).optional(),
  },
  handler: async (request, response, context) => {
    const {
      maxCallStackDepth = DEFAULT_COMPACT_DEBUG_CONFIG.maxCallStackDepth,
      contextLines = DEFAULT_COMPACT_DEBUG_CONFIG.contextLines,
      maxLocalVariables = DEFAULT_COMPACT_DEBUG_CONFIG.maxLocalVariables,
      showStatus = DEFAULT_COMPACT_DEBUG_CONFIG.showStatus,
    } = request.params;

    const page = context.getSelectedPage();
    const state = getDebuggerState(page);

    if (!state.isPaused) {
      response.appendResponseLine('⚠️ Debugger is not currently paused.');
      return;
    }

    const session = await getCdpSession(page);

    try {
      await session.send('Debugger.stepOut');
      response.appendResponseLine('✅ Stepped out of function.');

      const pauseResult = await waitForPausedEvent(session, state);

      if (pauseResult.paused && showStatus) {
        response.appendResponseLine('');
        const config: CompactDebugStatusConfig = {
          maxCallStackDepth,
          contextLines,
          maxLocalVariables,
          maxValueLength: DEFAULT_COMPACT_DEBUG_CONFIG.maxValueLength,
          showStatus,
        };
        const statusLines = await getCompactDebugStatus(session, state, config);
        for (const line of statusLines) {
          response.appendResponseLine(line);
        }
      } else if (!pauseResult.paused) {
        if (pauseResult.reason === 'resumed') {
          response.appendResponseLine('');
          response.appendResponseLine('ℹ️ Execution has finished.');
        }
      }
    } catch (error) {
      response.appendResponseLine(
        `❌ Failed to step out: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

const DEFAULT_MAX_OUTPUT_LINES = 100;
const DEFAULT_MAX_CALL_STACK_FRAMES = 20;

export const getDebuggerStatus = defineTool({
  name: 'get_debugger_status',
  description: `Get the current status of the JavaScript debugger including call stack, code context, and scope variables.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    frameIndex: zod.number().int().nonnegative().default(0).optional(),
    contextLines: zod.number().int().nonnegative().default(5).optional(),
    maxPropertiesPerScope: zod.number().int().positive().optional(),
    skipScopeVariables: zod.boolean().optional(),
    useObjectPreviews: zod.boolean().optional(),
    maxOutputLines: zod.number().int().positive().default(DEFAULT_MAX_OUTPUT_LINES).optional(),
    maxCallStackFrames: zod.number().int().positive().default(DEFAULT_MAX_CALL_STACK_FRAMES).optional(),
    maxLineLength: zod.number().int().positive().default(500).optional(),
    showIRContext: zod.boolean().default(true).optional().describe('Whether to show IR context if available when paused in JSVMP code (default: true).'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const state = getDebuggerState(page);
    const frameIndex = request.params.frameIndex ?? 0;
    const contextLines = request.params.contextLines ?? 5;
    const maxOutputLines = request.params.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES;
    const maxCallStackFrames = request.params.maxCallStackFrames ?? DEFAULT_MAX_CALL_STACK_FRAMES;
    const maxLineLength = request.params.maxLineLength ?? 500;
    const maxTotalChars = getConfig().maxBodySize;

    const debuggerConfig: DebuggerStatusConfig = {
      maxPropertiesPerScope: request.params.maxPropertiesPerScope ?? getConfig().debugger.maxPropertiesPerScope,
      skipScopeVariables: request.params.skipScopeVariables ?? getConfig().debugger.skipScopeVariables,
      useObjectPreviews: request.params.useObjectPreviews ?? getConfig().debugger.useObjectPreviews,
      maxObjectDepth: getConfig().debugger.maxObjectDepth,
      maxLineLength: maxLineLength,
    };

    const outputLines: string[] = [];
    let isTruncated = false;
    let totalChars = 0;

    const addLine = (line: string): boolean => {
      if (isTruncated) return false;

      if (outputLines.length >= maxOutputLines || totalChars >= maxTotalChars) {
        isTruncated = true;
        return false;
      }

      let processedLine = line;
      if (line.length > maxLineLength) {
        processedLine = line.substring(0, maxLineLength) + '... [line truncated]';
      }

      if (totalChars + processedLine.length > maxTotalChars) {
        processedLine = processedLine.substring(0, maxTotalChars - totalChars) + '... [total size truncated]';
        isTruncated = true;
      }

      outputLines.push(processedLine);
      totalChars += processedLine.length + 1;
      return !isTruncated;
    };

    const addLines = (lines: string[]): boolean => {
      for (const line of lines) {
        if (!addLine(line)) return false;
      }
      return true;
    };

    const breakpointCount = state.activeBreakpointIds.size;
    
    addLine('🔍 Debugger Status:');
    addLine(`   Enabled: ${state.enabled ? 'Yes' : 'No'}`);
    addLine(`   Paused: ${state.isPaused ? 'Yes' : 'No'}`);
    addLine(`   Active breakpoints: ${breakpointCount}`);

    if (state.isPaused && state.pausedCallFrames) {
      if (frameIndex >= state.pausedCallFrames.length) {
        addLine('');
        addLine(`❌ Invalid frame index: ${frameIndex}`);
        addLine(`   Valid range: 0-${state.pausedCallFrames.length - 1}`);
        for (const line of outputLines) {
          response.appendResponseLine(line);
        }
        return;
      }

      const session = await getCdpSession(page);
      const scriptCache = getScriptCache(session);

      addLine('');
      addLine('📚 Call Stack:');
      
      const totalFrames = state.pausedCallFrames.length;
      const framesToShow = Math.min(totalFrames, maxCallStackFrames);
      const hasMoreFrames = totalFrames > maxCallStackFrames;

      for (let i = 0; i < framesToShow && !isTruncated; i++) {
        const frame = state.pausedCallFrames[i];
        const marker = i === frameIndex ? ' ▶' : '';
        let scriptUrl = frame.url;
        if (!scriptUrl) {
          const scriptInfo = scriptCache.get(frame.location.scriptId);
          scriptUrl = scriptInfo?.url || `VM${frame.location.scriptId}`;
        }
        addLine(
          `   ${i}: ${frame.functionName} at ${scriptUrl}:${frame.location.lineNumber + 1}:${frame.location.columnNumber ?? 0}${marker}`,
        );
      }

      if (hasMoreFrames && !isTruncated) {
        addLine(`   ... and ${totalFrames - maxCallStackFrames} more frames`);
      }

      const frame = state.pausedCallFrames[frameIndex];

      if (contextLines > 0 && !isTruncated) {
        addLine('');

        try {
          const scriptSource = await getScriptSource(session, frame.location.scriptId);

          if (scriptSource === null) {
            addLine(`⚠️ Source unavailable for script ${frame.location.scriptId}`);
          } else {
            const contextResult = extractContextCode(scriptSource, {
              lineNumber: frame.location.lineNumber + 1,
              columnNumber: frame.location.columnNumber ?? 0,
              contextLines,
              formatMinified: false,
              maxLineLength,
            });

            const contextOutput = formatContextCodeOutput(
              contextResult,
              frame.location.lineNumber + 1,
              frame.location.columnNumber ?? 0,
              frame.url,
              frame.functionName
            );

            const contextOutputLines = contextOutput.split('\n');
            addLines(contextOutputLines);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          addLine(`⚠️ Failed to retrieve code context: ${errorMessage}`);
          logger(`[debugger] Error retrieving code context for script ${frame.location.scriptId}: ${error}`);
        }
      }

      if (!isTruncated) {
        addLine('');
        addLine(`📦 Scope Variables (frame ${frameIndex}: ${frame.functionName}):`);

        try {
          const {lines: scopeLines, hasTruncatedValues} = await inspectScopeVariablesOptimized(
            session,
            frame.scopeChain,
            debuggerConfig
          );

          addLines(scopeLines);

          if (hasTruncatedValues && !isTruncated) {
            addLine('');
            addLine(
              'ℹ️  Some values are truncated. Use get_scope_variables for full details.',
            );
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          addLine(`   ⚠️ Failed to inspect scope variables: ${errorMessage}`);
          logger(`[debugger] Error inspecting scope variables: ${error}`);
        }
      }

      // IR Context Detection and Display (Requirements 7.1-7.5)
      const showIRContext = request.params.showIRContext ?? true;
      if (showIRContext && !isTruncated) {
        // Get the paused URL from the current frame
        let pausedUrl = frame.url;
        if (!pausedUrl) {
          const scriptInfo = scriptCache.get(frame.location.scriptId);
          pausedUrl = scriptInfo?.url || '';
        }

        // Check if there's a matching IR source map
        if (pausedUrl) {
          const findResult = findSourceMapByUrl(pausedUrl);
          if (findResult.success) {
            const irSession = findResult.session;
            
            // Extract IR state
            const extractResult = await extractState(
              session,
              irSession,
              state,
              { frameIndex, contextLines: 5, maxValueLength: maxLineLength }
            );

            if (extractResult.success) {
              addLine('');
              addLine('🔧 IR Context:');
              
              const irState = extractResult.state;
              
              // Display current IR location info (Requirement 7.2)
              addLine(`   IR Line: ${irState.irLine}, PC: ${irState.irAddr}`);
              addLine(`   Opcode: ${irState.opcodeName} (${irState.opcode})`);
              addLine(`   Semantic: ${irState.semantic}`);
              
              // Display IR code context (Requirement 7.3)
              if (irState.codeContext && irState.codeContext.lines.length > 0) {
                addLine('');
                addLine('   📜 IR Code:');
                for (const line of irState.codeContext.lines) {
                  const marker = line.isCurrent ? '→' : ' ';
                  const lineNumStr = String(line.lineNumber).padStart(6, ' ');
                  addLine(`   ${marker} ${lineNumStr}: ${line.text}`);
                }
              }
              
              // Display VM register values (Requirement 7.4)
              const variables = irState.variables;
              const registerNames = ['$pc', '$sp', '$opcode'];
              const registers: Array<{name: string; value: unknown}> = [];
              const stackVars: Array<{name: string; value: unknown}> = [];
              const scopeVars: Array<{name: string; value: unknown}> = [];
              
              for (const [name, value] of Object.entries(variables)) {
                if (registerNames.includes(name)) {
                  registers.push({name, value});
                } else if (name.startsWith('$stack[')) {
                  stackVars.push({name, value});
                } else if (name.startsWith('$scope[')) {
                  scopeVars.push({name, value});
                }
              }
              
              // Sort stack and scope by index
              const extractIndex = (name: string): number => {
                const match = name.match(/\[(\d+)\]/);
                return match ? parseInt(match[1], 10) : 0;
              };
              stackVars.sort((a, b) => extractIndex(a.name) - extractIndex(b.name));
              scopeVars.sort((a, b) => extractIndex(a.name) - extractIndex(b.name));
              
              if (registers.length > 0 || stackVars.length > 0 || scopeVars.length > 0) {
                addLine('');
                addLine('   📊 VM State:');
                
                // Display registers
                for (const {name, value} of registers) {
                  const formattedValue = formatVMValue(value, maxLineLength);
                  addLine(`      ${name}: ${formattedValue}`);
                }
                
                // Display stack (limit to first 5 entries)
                if (stackVars.length > 0) {
                  const displayStack = stackVars.slice(0, 5);
                  for (const {name, value} of displayStack) {
                    const formattedValue = formatVMValue(value, maxLineLength);
                    addLine(`      ${name}: ${formattedValue}`);
                  }
                  if (stackVars.length > 5) {
                    addLine(`      ... and ${stackVars.length - 5} more stack entries`);
                  }
                }
                
                // Display scope (limit to first 5 entries)
                if (scopeVars.length > 0) {
                  const displayScope = scopeVars.slice(0, 5);
                  for (const {name, value} of displayScope) {
                    const formattedValue = formatVMValue(value, maxLineLength);
                    addLine(`      ${name}: ${formattedValue}`);
                  }
                  if (scopeVars.length > 5) {
                    addLine(`      ... and ${scopeVars.length - 5} more scope entries`);
                  }
                }
              }
              
              addLine('');
              addLine('   ℹ️ Use ir_get_state for full IR details.');
            }
          }
        }
      }
    }

    for (const line of outputLines) {
      response.appendResponseLine(line);
    }

    if (isTruncated) {
      response.appendResponseLine('');
      response.appendResponseLine(`⚠️ Output truncated: showing ${maxOutputLines} lines.`);
    }
  },
});


export const evaluateOnCallFrame = defineTool({
  name: 'evaluate_on_call_frame',
  description: `Evaluate a JavaScript expression in the context of a specific call frame when paused.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    expression: zod.string().describe('The JavaScript expression to evaluate.'),
    frameIndex: zod.number().int().nonnegative().default(0),
    maxOutputChars: zod.number().int().positive().default(10000).optional(),
    filepath: zod.string().optional(),
  },
  handler: async (request, response, context) => {
    const {expression, frameIndex, maxOutputChars = 10000, filepath} = request.params;
    const page = context.getSelectedPage();
    const state = getDebuggerState(page);

    if (!state.isPaused) {
      response.appendResponseLine('⚠️ Debugger is not currently paused.');
      return;
    }

    if (!state.pausedCallFrames || frameIndex >= state.pausedCallFrames.length) {
      response.appendResponseLine(
        `⚠️ Invalid frame index. Available frames: 0-${(state.pausedCallFrames?.length ?? 1) - 1}`,
      );
      return;
    }

    const frame = state.pausedCallFrames[frameIndex];
    const session = await getCdpSession(page);

    try {
      const result = await session.send('Debugger.evaluateOnCallFrame', {
        callFrameId: frame.callFrameId,
        expression,
        returnByValue: true,
      });

      const evalResult = result as any;

      if (evalResult.exceptionDetails) {
        response.appendResponseLine('❌ Evaluation error:');
        response.appendResponseLine(
          `   ${evalResult.exceptionDetails.exception?.description || evalResult.exceptionDetails.text}`,
        );
        return;
      }

      const resultValue = evalResult.result?.value ?? evalResult.result;
      const fullOutput = JSON.stringify(resultValue, null, 2);
      const outputLength = fullOutput.length;

      if (filepath) {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const fullPath = path.resolve(filepath);
        await fs.mkdir(path.dirname(fullPath), {recursive: true});
        await fs.writeFile(fullPath, fullOutput, 'utf-8');
        
        response.appendResponseLine(`✅ Result saved to file (frame ${frameIndex}: ${frame.functionName}):`);
        response.appendResponseLine(`   File: ${fullPath}`);
        response.appendResponseLine(`   Size: ${outputLength} characters`);
        return;
      }

      response.appendResponseLine(`✅ Result (frame ${frameIndex}: ${frame.functionName}):`);
      
      if (outputLength > maxOutputChars) {
        const truncatedOutput = fullOutput.substring(0, maxOutputChars);
        response.appendResponseLine('```json');
        response.appendResponseLine(truncatedOutput + '\n... <truncated>');
        response.appendResponseLine('```');
        response.appendResponseLine('');
        response.appendResponseLine(`⚠️ Output truncated: ${outputLength} chars → ${maxOutputChars} chars`);
      } else {
        response.appendResponseLine('```json');
        response.appendResponseLine(fullOutput);
        response.appendResponseLine('```');
      }
    } catch (error) {
      response.appendResponseLine(
        `❌ Failed to evaluate: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

export const getScopeVariables = defineTool({
  name: 'get_scope_variables',
  description: `Get detailed variable information from a specific scope when paused at a breakpoint.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    frameIndex: zod.number().int().nonnegative().default(0),
    scopeType: zod.enum(['local', 'closure', 'block', 'script', 'global', 'catch', 'with', 'module', 'wasm-expression-stack']).optional(),
    variableName: zod.string().optional(),
    searchTerm: zod.string().optional(),
    pageSize: zod.number().int().positive().optional(),
    pageIdx: zod.number().int().min(0).optional(),
    maxDepth: zod.number().int().positive().default(3).optional(),
    maxOutputLines: zod.number().int().positive().default(100).optional(),
    saveToFile: zod.string().optional(),
    maxLineLength: zod.number().int().positive().default(1000).optional(),
  },
  handler: async (request, response, context) => {
    const {frameIndex, scopeType, variableName, searchTerm, pageSize, pageIdx, maxDepth, maxOutputLines, saveToFile, maxLineLength = 1000} = request.params;
    const page = context.getSelectedPage();
    const state = getDebuggerState(page);
    const maxTotalChars = getConfig().maxBodySize;

    if (!state.isPaused) {
      response.appendResponseLine('⚠️ Debugger is not currently paused.');
      return;
    }

    if (!state.pausedCallFrames || frameIndex >= state.pausedCallFrames.length) {
      response.appendResponseLine(
        `⚠️ Invalid frame index. Available frames: 0-${(state.pausedCallFrames?.length ?? 1) - 1}`,
      );
      return;
    }

    const frame = state.pausedCallFrames[frameIndex];
    const session = await getCdpSession(page);

    const outputLines: string[] = [];
    const maxLines = maxOutputLines ?? 100;
    let totalChars = 0;

    const addToOutput = (line: string) => {
      outputLines.push(line);
      totalChars += line.length + 1;
    };

    addToOutput(`📦 Scope Variables (frame ${frameIndex}: ${frame.functionName}):`);
    addToOutput('');

    async function getObjectProperties(
      objectId: string,
      depth: number,
      indent: string,
    ): Promise<string[]> {
      const lines: string[] = [];
      if (depth <= 0) {
        lines.push(`${indent}[max depth reached]`);
        return lines;
      }

      try {
        const propsResult = await session.send('Runtime.getProperties', {
          objectId,
          ownProperties: true,
          generatePreview: true,
        });

        const properties = (propsResult as any).result || [];

        for (const prop of properties) {
          if (prop.value) {
            const val = prop.value;
            if (val.type === 'object' && val.objectId && val.subtype !== 'null') {
              lines.push(`${indent}${prop.name}: (${val.subtype || val.type}) ${val.description || ''}`);
              const nested = await getObjectProperties(val.objectId, depth - 1, indent + '  ');
              lines.push(...nested);
            } else {
              const {formatted, type} = formatRemoteObject(val, maxLineLength);
              lines.push(`${indent}${prop.name}: (${type}) ${formatted}`);
            }
          } else if (prop.get) {
            lines.push(`${indent}${prop.name}: [getter]`);
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        lines.push(`${indent}(unable to retrieve properties: ${errorMessage})`);
      }

      return lines;
    }

    for (const scope of frame.scopeChain) {
      if (scopeType && scope.type !== scopeType) {
        continue;
      }

      const scopeName = scope.name ? `${scope.type}: ${scope.name}` : scope.type;
      addToOutput(`=== [${scopeName}] ===`);

      if (!scope.object.objectId) {
        addToOutput('   (no properties)');
        addToOutput('');
        continue;
      }

      try {
        const propsResult = await session.send('Runtime.getProperties', {
          objectId: scope.object.objectId,
          ownProperties: true,
          generatePreview: true,
        });

        let properties = (propsResult as any).result || [];

        if (variableName) {
          const prop = properties.find((p: any) => p.name === variableName);
          if (prop) {
            addToOutput(`Variable: ${variableName}`);
            if (prop.value) {
              const val = prop.value;
              if (val.type === 'object' && val.objectId && val.subtype !== 'null') {
                addToOutput(`Type: ${val.subtype || val.type}`);
                addToOutput(`Description: ${val.description || 'N/A'}`);
                addToOutput('Properties:');
                const nested = await getObjectProperties(val.objectId, maxDepth ?? 3, '   ');
                for (const l of nested) addToOutput(l);
              } else {
                const {formatted, type} = formatRemoteObject(val, maxLineLength);
                addToOutput(`Type: ${type}`);
                addToOutput(`Value: ${formatted}`);
              }
            }
          } else {
            addToOutput(`   Variable "${variableName}" not found in this scope.`);
          }
        } else {
          if (searchTerm) {
            const lowerSearchTerm = searchTerm.toLowerCase();
            properties = properties.filter((p: any) =>
              p.name.toLowerCase().includes(lowerSearchTerm)
            );
            if (properties.length === 0) {
              addToOutput(`   No variables matching "${searchTerm}" found.`);
              addToOutput('');
              continue;
            }
          }

          const paginationResult = paginate(properties, {pageSize, pageIdx});

          if (paginationResult.totalPages > 1) {
            addToOutput(
              `Showing ${paginationResult.startIndex + 1}-${paginationResult.endIndex} of ${properties.length} variables`
            );
          }

          for (const prop of paginationResult.items as any[]) {
            if (prop.value) {
              const val = prop.value;
              if (val.type === 'object' && val.objectId && val.subtype !== 'null') {
                addToOutput(`${prop.name}: (${val.subtype || val.type}) ${val.description || ''}`);
                const nested = await getObjectProperties(val.objectId, (maxDepth ?? 3) - 1, '   ');
                for (const l of nested) addToOutput(l);
              } else {
                const {formatted, type} = formatRemoteObject(val, maxLineLength);
                addToOutput(`${prop.name}: (${type}) ${formatted}`);
              }
            } else if (prop.get) {
              addToOutput(`${prop.name}: [getter]`);
            }
          }
        }
      } catch (error) {
        addToOutput(
          `   (error retrieving properties: ${error instanceof Error ? error.message : String(error)})`,
        );
      }

      addToOutput('');
      
      if (totalChars >= maxTotalChars && !saveToFile) {
        break;
      }
    }

    if (saveToFile) {
      const fullContent = outputLines.join('\n');
      await context.saveFile(new TextEncoder().encode(fullContent), saveToFile);
      response.appendResponseLine(`✅ Full output saved to ${saveToFile} (${outputLines.length} lines)`);
      response.appendResponseLine('');
    }

    let currentResponseChars = 0;
    let isTruncated = false;

    for (let i = 0; i < outputLines.length; i++) {
      const line = outputLines[i];
      if (i >= maxLines || currentResponseChars + line.length > maxTotalChars) {
        isTruncated = true;
        break;
      }

      let processedLine = line;
      if (line.length > maxLineLength) {
        processedLine = line.substring(0, maxLineLength) + '... [line truncated]';
      }
      
      response.appendResponseLine(processedLine);
      currentResponseChars += processedLine.length + 1;
    }

    if (isTruncated) {
      response.appendResponseLine('');
      response.appendResponseLine(`⚠️ Output truncated. Use saveToFile parameter to save full output.`);
    }
  },
});

export const saveScopeVariables = defineTool({
  name: 'save_scope_variables',
  description: `Save all scope variables from the current debug context to a JSON file.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    filePath: zod.string(),
    frameIndex: zod.number().int().nonnegative().default(0),
    includeGlobal: zod.boolean().default(false).optional(),
  },
  handler: async (request, response, context) => {
    const {filePath, frameIndex, includeGlobal} = request.params;
    const page = context.getSelectedPage();
    const state = getDebuggerState(page);

    if (!state.isPaused) {
      response.appendResponseLine('⚠️ Debugger is not currently paused.');
      return;
    }

    if (!state.pausedCallFrames || frameIndex >= state.pausedCallFrames.length) {
      response.appendResponseLine(
        `⚠️ Invalid frame index. Available frames: 0-${(state.pausedCallFrames?.length ?? 1) - 1}`,
      );
      return;
    }

    const frame = state.pausedCallFrames[frameIndex];
    const session = await getCdpSession(page);

    async function serializeObject(objectId: string): Promise<any> {
      try {
        const result = await session.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function() {
            try {
              const seen = new WeakSet();
              return JSON.stringify(this, (key, value) => {
                if (typeof value === 'object' && value !== null) {
                  if (seen.has(value)) return '[circular reference]';
                  seen.add(value);
                }
                return value;
              });
            } catch (e) {
              return JSON.stringify({ error: e.message });
            }
          }`,
          returnByValue: true,
        });
        const jsonStr = (result as any).result?.value;
        return jsonStr ? JSON.parse(jsonStr) : '[unable to serialize]';
      } catch {
        return '[error serializing]';
      }
    }

    const output: Record<string, any> = {
      frame: {
        index: frameIndex,
        functionName: frame.functionName,
        url: frame.url,
        location: {
          lineNumber: frame.location.lineNumber + 1,
          columnNumber: frame.location.columnNumber ?? 0,
        },
      },
      scopes: {},
    };

    for (const scope of frame.scopeChain) {
      if (scope.type === 'global' && !includeGlobal) {
        output.scopes[scope.type] = '[skipped - use includeGlobal:true to include]';
        continue;
      }

      const scopeKey = scope.name ? `${scope.type}:${scope.name}` : scope.type;

      if (scope.object.objectId) {
        output.scopes[scopeKey] = await serializeObject(scope.object.objectId);
      } else {
        output.scopes[scopeKey] = {};
      }
    }

    const jsonContent = JSON.stringify(output, null, 2);
    await context.saveFile(new TextEncoder().encode(jsonContent), filePath);

    response.appendResponseLine(`✅ Saved scope variables to ${filePath}`);
    response.appendResponseLine(`   Frame: ${frame.functionName}`);
    response.appendResponseLine(`   Scopes saved: ${Object.keys(output.scopes).join(', ')}`);
  },
});

export const disableDebugger = defineTool({
  name: 'disable_debugger',
  description: `Disable the JavaScript debugger on the current page and remove all breakpoints.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {},
  handler: async (_request, response, context) => {
    const page = context.getSelectedPage();
    const state = getDebuggerState(page);

    if (!state.enabled) {
      state.userDisabled = true;
      response.appendResponseLine('ℹ️ Debugger is already disabled.');
      return;
    }

    const session = await getCdpSession(page);

    try {
      await session.send('Debugger.disable');
      state.enabled = false;
      state.userDisabled = true;
      state.activeBreakpointIds.clear();
      state.isPaused = false;
      state.pausedCallFrames = undefined;

      response.appendResponseLine('✅ Debugger disabled.');
      response.appendResponseLine('   All breakpoints have been removed.');
    } catch (error) {
      response.appendResponseLine(
        `❌ Failed to disable debugger: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});


export const getPossibleBreakpoints = defineTool({
  name: 'get_possible_breakpoints',
  description: `Discover all valid breakpoint locations in a script at a specific line. Useful for minified code.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    urlRegex: zod.string(),
    lineNumber: zod.number().int().positive(),
    startColumn: zod.number().int().nonnegative().optional(),
    endColumn: zod.number().int().nonnegative().optional(),
    maxCount: zod.number().int().positive().optional(),
  },
  handler: async (request, response, context) => {
    const {urlRegex, lineNumber, startColumn, endColumn, maxCount = 20} = request.params;
    const page = context.getSelectedPage();
    const session = await initializeDebuggerForPage(page, { forceEnable: true });

    const cdpLineNumber = lineNumber - 1;

    const matchingScripts = await findMatchingScripts(session, urlRegex);

    if (matchingScripts.length === 0) {
      response.appendResponseLine(`❌ No scripts found matching pattern: ${urlRegex}`);
      return;
    }

    let allLocations: BreakpointLocation[] = [];

    for (const script of matchingScripts) {
      const queryStartColumn = startColumn ?? 0;
      const queryEndColumn = endColumn ?? (queryStartColumn + 100);

      const locations = await queryPossibleBreakpoints(
        session,
        script.scriptId,
        cdpLineNumber,
        queryStartColumn,
        cdpLineNumber,
        queryEndColumn,
        script.url
      );

      const filteredLocations = locations.filter(loc => {
        if (startColumn !== undefined && loc.columnNumber < startColumn) {
          return false;
        }
        if (endColumn !== undefined && loc.columnNumber > endColumn) {
          return false;
        }
        return true;
      });

      allLocations = allLocations.concat(filteredLocations);
    }

    if (allLocations.length === 0) {
      response.appendResponseLine(`❌ No valid breakpoint locations found at line ${lineNumber}`);
      return;
    }

    allLocations.sort((a, b) => {
      const urlCompare = a.scriptUrl.localeCompare(b.scriptUrl);
      if (urlCompare !== 0) return urlCompare;
      return a.columnNumber - b.columnNumber;
    });

    const totalCount = allLocations.length;
    const truncated = totalCount > maxCount;
    const displayLocations = truncated ? allLocations.slice(0, maxCount) : allLocations;

    response.appendResponseLine(`📍 Possible breakpoint locations at line ${lineNumber}:`);
    response.appendResponseLine(`   URL pattern: ${urlRegex}`);
    response.appendResponseLine('');

    for (const loc of displayLocations) {
      response.appendResponseLine(`   ${loc.scriptUrl}:${loc.lineNumber}:${loc.columnNumber}`);
    }

    if (truncated) {
      response.appendResponseLine('');
      response.appendResponseLine(`⚠️ Results truncated: showing ${maxCount} of ${totalCount} locations`);
    } else {
      response.appendResponseLine('');
      response.appendResponseLine(`Found ${totalCount} valid breakpoint location(s).`);
    }
  },
});

// XHR Breakpoint Tools

export const setXhrBreakpoint = defineTool({
  name: 'set_xhr_breakpoint',
  description: `Set an XHR/Fetch breakpoint that pauses execution when a request URL contains the specified substring.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    urlPattern: zod.string(),
  },
  handler: async (request, response, context) => {
    const {urlPattern} = request.params;
    const page = context.getSelectedPage();
    const session = await initializeDebuggerForPage(page, {forceEnable: true});

    try {
      await session.send('DOMDebugger.setXHRBreakpoint', {
        url: urlPattern,
      });

      trackXhrBreakpoint(page, urlPattern);

      response.appendResponseLine('✅ XHR breakpoint set successfully');
      if (urlPattern === '') {
        response.appendResponseLine('   URL pattern: (all requests)');
      } else {
        response.appendResponseLine(`   URL pattern: "${urlPattern}"`);
      }
    } catch (error) {
      response.appendResponseLine(
        `❌ Failed to set XHR breakpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

export const removeXhrBreakpoint = defineTool({
  name: 'remove_xhr_breakpoint',
  description: `Remove a previously set XHR/Fetch breakpoint by its URL pattern, or remove all XHR breakpoints.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    urlPattern: zod.string().optional(),
  },
  handler: async (request, response, context) => {
    const {urlPattern} = request.params;
    const page = context.getSelectedPage();
    const session = await initializeDebuggerForPage(page, {forceEnable: true});

    if (urlPattern !== undefined) {
      try {
        await session.send('DOMDebugger.removeXHRBreakpoint', {
          url: urlPattern,
        });

        untrackXhrBreakpoint(page, urlPattern);

        if (urlPattern === '') {
          response.appendResponseLine('✅ Removed XHR breakpoint for pattern (all requests)');
        } else {
          response.appendResponseLine(`✅ Removed XHR breakpoint for pattern "${urlPattern}"`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('not found') || errorMessage.includes('does not exist')) {
          response.appendResponseLine(`⚠️ XHR breakpoint not found or already removed.`);
          untrackXhrBreakpoint(page, urlPattern);
        } else {
          response.appendResponseLine(`❌ Failed to remove XHR breakpoint: ${errorMessage}`);
        }
      }
    } else {
      const trackedPatterns = getTrackedXhrBreakpoints(page);

      if (trackedPatterns.length === 0) {
        response.appendResponseLine('ℹ️ No XHR breakpoints to remove.');
        return;
      }

      let removedCount = 0;

      for (const pattern of trackedPatterns) {
        try {
          await session.send('DOMDebugger.removeXHRBreakpoint', {
            url: pattern,
          });
          removedCount++;
        } catch {
          removedCount++;
        }
      }

      clearTrackedXhrBreakpoints(page);

      response.appendResponseLine(`✅ Cleared ${removedCount} XHR breakpoint(s).`);
    }
  },
});

export const listXhrBreakpoints = defineTool({
  name: 'list_xhr_breakpoints',
  description: `List all active XHR/Fetch breakpoints.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const trackedPatterns = getTrackedXhrBreakpoints(page);

    if (trackedPatterns.length === 0) {
      response.appendResponseLine('No active XHR breakpoints.');
      return;
    }

    response.appendResponseLine(`Active XHR breakpoints (${trackedPatterns.length} total):`);
    response.appendResponseLine('');

    for (const pattern of trackedPatterns) {
      if (pattern === '') {
        response.appendResponseLine('📍 (all requests)');
      } else {
        response.appendResponseLine(`📍 "${pattern}"`);
      }
    }
  },
});

export async function ensureDebuggerEnabledForPage(page: Page): Promise<void> {
  await initializeDebuggerForPage(page, { forceEnable: true });
}
