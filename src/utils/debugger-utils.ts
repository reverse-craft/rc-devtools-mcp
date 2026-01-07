/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from './logger.js';
import type {CDPSession, Page} from '../third-party/index.js';
import {clearParseResultCache} from '../tools/analysis.js';

import {getCdpSession, enableDebuggerPausedTracking} from './cdp.js';
import {cacheScript, clearScriptCache} from './smart-breakpoint-utils.js';

// Store active breakpoints per page
export interface BreakpointInfo {
  breakpointId: string;
  urlPattern: string;
  lineNumber: number;           // Requested line (1-based)
  columnNumber?: number;        // Requested column (0-based)
  resolvedLineNumber: number;   // Actual line (1-based)
  resolvedColumnNumber: number; // Actual column (0-based)
  condition?: string;
  wasSnapped: boolean;          // True if position was adjusted
}

/**
 * CDP breakpoint info returned by Debugger.getBreakpointLocations or stored internally
 */
export interface CdpBreakpointLocation {
  scriptId: string;
  lineNumber: number;
  columnNumber: number;
  url?: string;
}

export interface CallFrame {
  callFrameId: string;
  functionName: string;
  location: {
    scriptId: string;
    lineNumber: number;
    columnNumber?: number;
  };
  url: string;
  scopeChain: ScopeInfo[];
}

export interface ScopeInfo {
  type: string;
  object: {
    type: string;
    objectId?: string;
  };
  name?: string;
}

/**
 * Stored breakpoint information including condition and original line number.
 */
export interface StoredBreakpointInfo {
  /** The original requested line number (1-based) */
  lineNumber: number;
  /** The original requested column number (0-based) */
  columnNumber?: number;
  /** The condition expression, if any */
  condition?: string;
}

export interface DebuggerState {
  enabled: boolean;
  isPaused: boolean;
  pausedCallFrames?: CallFrame[];
  /** 
   * Tracks CDP breakpoint IDs that are currently active.
   * This is used to sync with CDP's actual state.
   * Key: CDP breakpoint ID, Value: stored breakpoint info
   */
  activeBreakpoints: Map<string, StoredBreakpointInfo>;
  /**
   * Tracks whether the user has explicitly disabled the debugger.
   * When true, the debugger should NOT be re-enabled after page refresh.
   */
  userDisabled: boolean;
}

const debuggerStates = new WeakMap<Page, DebuggerState>();

export function getDebuggerState(page: Page): DebuggerState {
  let state = debuggerStates.get(page);
  if (!state) {
    state = {
      enabled: false,
      isPaused: false,
      activeBreakpoints: new Map(),
      userDisabled: false,
    };
    debuggerStates.set(page, state);
  }
  return state;
}

/**
 * Information about an active breakpoint from CDP
 */
export interface ActiveBreakpointInfo {
  breakpointId: string;
  url: string;
  lineNumber: number;    // 1-based
  columnNumber: number;  // 0-based
  condition?: string;
}

/**
 * Get all active breakpoints from CDP.
 * Since CDP doesn't have a direct "list all breakpoints" API, we track them
 * when they are set and verify they still exist.
 * 
 * @param page - The page to get breakpoints for
 * @returns Array of active breakpoint information
 */
export async function getActiveBreakpoints(page: Page): Promise<ActiveBreakpointInfo[]> {
  const state = getDebuggerState(page);
  const activeBreakpoints: ActiveBreakpointInfo[] = [];
  
  for (const [bpId, storedInfo] of state.activeBreakpoints) {
    // Parse the breakpoint ID to extract URL pattern
    // CDP breakpoint IDs from setBreakpointByUrl have format like: "1:14:0:.*app\\.js.*"
    // Format: lineNumber:columnNumber:scriptHash:urlRegex
    const parts = bpId.split(':');
    let urlRegex = '(unknown)';
    
    if (parts.length >= 4) {
      urlRegex = parts.slice(3).join(':'); // URL regex might contain colons
    }
    
    activeBreakpoints.push({
      breakpointId: bpId,
      url: urlRegex,
      lineNumber: storedInfo.lineNumber,
      columnNumber: storedInfo.columnNumber ?? 0,
      condition: storedInfo.condition,
    });
  }
  
  return activeBreakpoints;
}

/**
 * Track a newly set breakpoint with its metadata.
 * 
 * @param page - The page the breakpoint is set on
 * @param breakpointId - The CDP breakpoint ID
 * @param info - The breakpoint metadata (line number, column, condition)
 */
export function trackBreakpoint(page: Page, breakpointId: string, info: StoredBreakpointInfo): void {
  const state = getDebuggerState(page);
  state.activeBreakpoints.set(breakpointId, info);
}

/**
 * Untrack a removed breakpoint
 */
export function untrackBreakpoint(page: Page, breakpointId: string): void {
  const state = getDebuggerState(page);
  state.activeBreakpoints.delete(breakpointId);
}

/**
 * Get count of tracked breakpoints
 */
export function getBreakpointCount(page: Page): number {
  const state = getDebuggerState(page);
  return state.activeBreakpoints.size;
}

/**
 * Clear all tracked breakpoints (used after clear_all_breakpoints)
 */
export function clearTrackedBreakpoints(page: Page): void {
  const state = getDebuggerState(page);
  state.activeBreakpoints.clear();
}

// Track whether we've set up navigation listeners per page
const navigationListenerSetup = new WeakSet<Page>();

/**
 * Re-enable debugger after navigation.
 * Note: CDP breakpoints set via setBreakpointByUrl persist across navigations automatically,
 * so we don't need to manually restore them. We just need to ensure the debugger is enabled.
 * 
 * Respects user's explicit disable_debugger call - if userDisabled is true, 
 * the debugger will NOT be re-enabled after navigation.
 */
export async function restoreBreakpointsAfterNavigation(page: Page, session: CDPSession): Promise<void> {
  const state = getDebuggerState(page);
  
  // Respect user's explicit disable_debugger call
  if (state.userDisabled) {
    logger('[debugger] Debugger was explicitly disabled by user, skipping re-enable after navigation');
    return;
  }
  
  // Re-enable debugger after navigation
  try {
    await session.send('Debugger.enable');
    state.enabled = true;
    logger('[debugger] Debugger re-enabled after navigation');
  } catch {
    // Debugger might already be enabled, ignore
  }
  
  // CDP breakpoints set via setBreakpointByUrl are URL-based and persist across navigations.
  // They will automatically resolve to new script locations when matching scripts are loaded.
  // No manual restoration needed.
}

/**
 * Initialize the debugger for a page proactively.
 * This should be called when a page is created or selected to ensure
 * that the debugger is enabled before scripts load.
 * 
 * @param page - The page to initialize debugger for
 * @param options - Optional configuration
 * @param options.forceEnable - When true, resets userDisabled flag to allow re-enabling
 *                              the debugger even if it was previously disabled by the user.
 *                              Use this for explicit user actions like set_breakpoint.
 */
export async function initializeDebuggerForPage(
  page: Page,
  options?: { forceEnable?: boolean }
): Promise<CDPSession> {
  const session = await getCdpSession(page);
  const state = getDebuggerState(page);

  // Only reset userDisabled flag when explicitly requested (e.g., by set_breakpoint)
  // This preserves the user's choice to disable debugger via navigate_page or disable_debugger
  if (options?.forceEnable) {
    state.userDisabled = false;
  }

  // Respect user's explicit disable_debugger call
  if (state.userDisabled) {
    return session;
  }

  if (!state.enabled) {
    await session.send('Debugger.enable');
    state.enabled = true;
    
    // Enable debugger paused state tracking
    enableDebuggerPausedTracking(page, session);

    // Listen for script parsed events to populate the script cache
    session.on('Debugger.scriptParsed', async (params: any) => {
      const scriptId = params.scriptId;
      const url = params.url || '';

      // Cache script metadata for breakpoint utilities
      cacheScript(session, {
        scriptId,
        url,
        startLine: params.startLine,
        startColumn: params.startColumn,
        endLine: params.endLine,
        endColumn: params.endColumn,
      });

      logger(`[debugger] Script parsed: ${url || scriptId}`);
    });

    // Listen for debugger paused events
    session.on('Debugger.paused', (params: any) => {
      state.isPaused = true;
      state.pausedCallFrames = params.callFrames?.map((frame: any) => ({
        callFrameId: frame.callFrameId,
        functionName: frame.functionName || '(anonymous)',
        location: {
          scriptId: frame.location.scriptId,
          lineNumber: frame.location.lineNumber,
          columnNumber: frame.location.columnNumber,
        },
        url: frame.url || '',
        scopeChain: frame.scopeChain?.map((scope: any) => ({
          type: scope.type,
          object: {
            type: scope.object?.type,
            objectId: scope.object?.objectId,
          },
          name: scope.name,
        })) || [],
      }));
      logger('[debugger] Execution paused at breakpoint');
    });

    session.on('Debugger.resumed', () => {
      state.isPaused = false;
      state.pausedCallFrames = undefined;
      logger('[debugger] Execution resumed');
    });
  }

  // Set up navigation listener once per page to restore breakpoints after page refresh
  if (!navigationListenerSetup.has(page)) {
    navigationListenerSetup.add(page);

    // Get the main frame ID via CDP for accurate comparison
    let mainFrameId: string | undefined;
    try {
      const frameTree = await session.send('Page.getFrameTree');
      mainFrameId = (frameTree as any).frameTree?.frame?.id;
    } catch {
      // Fallback: will restore breakpoints for all frame loads
    }

    // Listen for frame STARTED loading events
    session.on('Page.frameStartedLoading', async (params: any) => {
      let isMainFrame = !mainFrameId || params.frameId === mainFrameId;
      
      if (!isMainFrame) {
        try {
          const frameTree = await session.send('Page.getFrameTree');
          const currentMainFrameId = (frameTree as any).frameTree?.frame?.id;
          if (params.frameId === currentMainFrameId) {
            isMainFrame = true;
            mainFrameId = currentMainFrameId;
          }
        } catch {
          isMainFrame = true;
        }
      }
      
      if (isMainFrame) {
        // Clear caches on navigation
        clearScriptCache(session);
        clearParseResultCache(session);
        logger('[debugger] Script cache and parse result cache cleared on navigation');

        // Always restore breakpoints (even if empty to ensure debugger is enabled and ready)
        logger('[debugger] Main frame started loading, initializing debugger/breakpoints...');
        try {
          await restoreBreakpointsAfterNavigation(page, session);
        } catch (err) {
          logger(`[debugger] Error restoring breakpoints: ${err}`);
        }
        
        // Update main frame ID
        try {
          const newFrameTree = await session.send('Page.getFrameTree');
          mainFrameId = (newFrameTree as any).frameTree?.frame?.id;
        } catch {
          // Ignore
        }
      }
    });

    // Enable Page domain to receive frameStartedLoading events
    try {
      await session.send('Page.enable');
    } catch {
      // Ignore
    }
  }

  return session;
}

/**
 * Get a summary of active breakpoints for a page.
 * This is useful for displaying breakpoint info in list_pages, new_page, navigate_page responses.
 * 
 * @param page - The page to get breakpoint summary for
 * @returns Array of formatted breakpoint summary strings, or empty array if no breakpoints
 */
export async function getBreakpointSummary(page: Page): Promise<string[]> {
  const breakpoints = await getActiveBreakpoints(page);
  const lines: string[] = [];
  
  if (breakpoints.length === 0) {
    return lines;
  }
  
  lines.push(`🔴 Active breakpoints (${breakpoints.length}):`);
  
  for (const bp of breakpoints) {
    const location = `line ${bp.lineNumber}, col ${bp.columnNumber}`;
    const condition = bp.condition ? ` [condition: ${bp.condition}]` : '';
    lines.push(`   • ${bp.breakpointId}: ${bp.url} @ ${location}${condition}`);
  }
  
  return lines;
}

// ============================================================================
// XHR Breakpoint Tracking
// ============================================================================

// Store XHR breakpoint URL patterns per page
// CDP does not provide a way to list XHR breakpoints, so we track them ourselves
const xhrBreakpointsByPage = new WeakMap<Page, Set<string>>();

/**
 * Track an XHR breakpoint URL pattern for a page.
 * 
 * @param page - The page the breakpoint is set on
 * @param urlPattern - The URL substring pattern for the breakpoint
 */
export function trackXhrBreakpoint(page: Page, urlPattern: string): void {
  let patterns = xhrBreakpointsByPage.get(page);
  if (!patterns) {
    patterns = new Set<string>();
    xhrBreakpointsByPage.set(page, patterns);
  }
  patterns.add(urlPattern);
}

/**
 * Untrack an XHR breakpoint URL pattern for a page.
 * 
 * @param page - The page the breakpoint was set on
 * @param urlPattern - The URL substring pattern to remove
 * @returns true if the pattern was found and removed, false otherwise
 */
export function untrackXhrBreakpoint(page: Page, urlPattern: string): boolean {
  const patterns = xhrBreakpointsByPage.get(page);
  if (!patterns) {
    return false;
  }
  return patterns.delete(urlPattern);
}

/**
 * Get all tracked XHR breakpoint URL patterns for a page.
 * 
 * @param page - The page to get breakpoints for
 * @returns Array of URL substring patterns
 */
export function getTrackedXhrBreakpoints(page: Page): string[] {
  const patterns = xhrBreakpointsByPage.get(page);
  if (!patterns) {
    return [];
  }
  return Array.from(patterns);
}

/**
 * Clear all tracked XHR breakpoints for a page.
 * 
 * @param page - The page to clear breakpoints for
 */
export function clearTrackedXhrBreakpoints(page: Page): void {
  const patterns = xhrBreakpointsByPage.get(page);
  if (patterns) {
    patterns.clear();
  }
}
