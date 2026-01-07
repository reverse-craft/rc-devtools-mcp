/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import type {CDPSession, Page} from '../third-party/index.js';

import {clearScriptCache} from './smart-breakpoint-utils.js';

/**
 * Shared CDP session management utilities.
 * Used by debugger tools and network initiator tracking.
 */

const cdpSessions = new WeakMap<Page, CDPSession>();

/**
 * Track debugger paused state per page.
 */
const debuggerPausedState = new WeakMap<Page, boolean>();

/**
 * Get or create a CDP session for a page.
 */
export async function getCdpSession(page: Page): Promise<CDPSession> {
  let session = cdpSessions.get(page);
  if (!session) {
    session = await page.createCDPSession();
    cdpSessions.set(page, session);
  }
  return session;
}

/**
 * Enable debugger paused state tracking for a page.
 * Should be called when Debugger domain is enabled.
 */
export function enableDebuggerPausedTracking(page: Page, session: CDPSession): void {
  // Listen for debugger paused/resumed events
  session.on('Debugger.paused', () => {
    debuggerPausedState.set(page, true);
  });
  
  session.on('Debugger.resumed', () => {
    debuggerPausedState.set(page, false);
  });
}

/**
 * Check if the debugger is currently paused for a page.
 * Returns true if paused, false otherwise.
 */
export function isDebuggerPaused(page: Page): boolean {
  return debuggerPausedState.get(page) ?? false;
}

/**
 * Dispose CDP session for a page.
 * Cleans up associated script caches and temporary files.
 */
export async function disposeCdpSession(page: Page): Promise<void> {
  const session = cdpSessions.get(page);
  if (session) {
    // Clear in-memory script cache
    clearScriptCache(session);
    
    // Detach the CDP session
    session.detach().catch(() => {
      // Ignore detach errors
    });
    cdpSessions.delete(page);
    debuggerPausedState.delete(page);
  }
}

/**
 * Check if a CDP session exists for a page.
 */
export function hasCdpSession(page: Page): boolean {
  return cdpSessions.has(page);
}

/**
 * Network request initiator types from CDP.
 */
export type InitiatorType = 'parser' | 'script' | 'preload' | 'SignedExchange' | 'preflight' | 'other' | 'FedCM';

/**
 * A single frame in a call stack.
 */
export interface CallFrameInfo {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

/**
 * Stack trace information from CDP.
 */
export interface StackTraceInfo {
  description?: string;
  callFrames: CallFrameInfo[];
  parent?: StackTraceInfo;
  parentId?: {
    id: string;
    debuggerId?: string;
  };
}

/**
 * Network request initiator information from CDP Network.requestWillBeSent.
 */
export interface NetworkInitiator {
  type: InitiatorType;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stack?: StackTraceInfo;
}

/**
 * Format a stack trace for human-readable output.
 */
export function formatStackTrace(stack: StackTraceInfo, indent = ''): string[] {
  const lines: string[] = [];

  if (stack.description) {
    lines.push(`${indent}${stack.description}`);
  }

  for (const frame of stack.callFrames) {
    const funcName = frame.functionName || '(anonymous)';
    const location = `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber}`;
    lines.push(`${indent}  at ${funcName} (${location})`);
  }

  if (stack.parent) {
    lines.push(`${indent}--- async ---`);
    lines.push(...formatStackTrace(stack.parent, indent));
  }

  return lines;
}

/**
 * Format initiator information for human-readable output.
 */
export function formatInitiator(initiator: NetworkInitiator): string[] {
  const lines: string[] = [];

  lines.push(`Type: ${initiator.type}`);

  if (initiator.url) {
    const location = initiator.lineNumber !== undefined
      ? `${initiator.url}:${initiator.lineNumber + 1}${initiator.columnNumber !== undefined ? `:${initiator.columnNumber}` : ''}`
      : initiator.url;
    lines.push(`URL: ${location}`);
  }

  if (initiator.stack) {
    lines.push('');
    lines.push('Call Stack:');
    lines.push(...formatStackTrace(initiator.stack, '  '));
  }

  return lines;
}

// ============================================================================
// Network Initiator Tracking
// ============================================================================

/**
 * Store requestId -> NetworkInitiator mapping per page.
 */
const networkInitiators = new WeakMap<Page, Map<string, NetworkInitiator>>();

/**
 * Track which pages have network initiator tracking enabled.
 */
const networkTrackingEnabled = new WeakSet<Page>();

/**
 * Enable network initiator tracking for a page.
 * This enables the CDP Network domain and listens for requestWillBeSent events
 * to capture the initiator (including call stack) for each request.
 */
export async function enableNetworkInitiatorTracking(page: Page): Promise<void> {
  if (networkTrackingEnabled.has(page)) {
    return;
  }

  const session = await getCdpSession(page);
  
  // Initialize the initiator map for this page
  networkInitiators.set(page, new Map());

  // Listen for Network.requestWillBeSent events
  session.on('Network.requestWillBeSent', (params: {
    requestId: string;
    initiator?: NetworkInitiator;
  }) => {
    if (params.initiator) {
      const initiatorMap = networkInitiators.get(page);
      if (initiatorMap) {
        initiatorMap.set(params.requestId, params.initiator as NetworkInitiator);
      }
    }
  });

  // Enable the Network domain to receive events
  await session.send('Network.enable');
  
  networkTrackingEnabled.add(page);
}

/**
 * Get the initiator information for a network request.
 * @param page The page the request belongs to
 * @param requestId The CDP request ID
 * @returns The initiator information, or undefined if not found
 */
export function getNetworkInitiator(page: Page, requestId: string): NetworkInitiator | undefined {
  const initiatorMap = networkInitiators.get(page);
  return initiatorMap?.get(requestId);
}

/**
 * Clear all stored initiator data for a page.
 * Call this on navigation to free memory from old requests.
 */
export function clearNetworkInitiators(page: Page): void {
  const initiatorMap = networkInitiators.get(page);
  if (initiatorMap) {
    initiatorMap.clear();
  }
}

/**
 * Check if network initiator tracking is enabled for a page.
 */
export function isNetworkTrackingEnabled(page: Page): boolean {
  return networkTrackingEnabled.has(page);
}
