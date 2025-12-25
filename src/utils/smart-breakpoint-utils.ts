/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from './logger.js';
import type {CDPSession} from '../third-party/index.js';

/**
 * Represents a valid breakpoint location returned by V8.
 */
export interface BreakpointLocation {
  scriptId: string;
  scriptUrl: string;
  lineNumber: number;    // 1-based for display
  columnNumber: number;  // 0-based
}

/**
 * Information about a parsed script.
 */
export interface ScriptInfo {
  scriptId: string;
  url: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  /** Cached source code (loaded on demand) */
  source?: string;
}

/**
 * Find the nearest valid breakpoint position to a target column.
 * Returns the location with minimum absolute distance to target.
 * If two locations are equidistant, returns the one with the smaller column number.
 * 
 * @param locations - Array of valid breakpoint locations
 * @param targetColumn - The target column number (0-based)
 * @returns The nearest location, or null if the list is empty
 */
export function findNearestBreakpointLocation(
  locations: BreakpointLocation[],
  targetColumn: number
): BreakpointLocation | null {
  if (locations.length === 0) {
    return null;
  }

  let nearest = locations[0];
  let minDistance = Math.abs(nearest.columnNumber - targetColumn);

  for (let i = 1; i < locations.length; i++) {
    const loc = locations[i];
    const distance = Math.abs(loc.columnNumber - targetColumn);
    
    if (distance < minDistance || 
        (distance === minDistance && loc.columnNumber < nearest.columnNumber)) {
      nearest = loc;
      minDistance = distance;
    }
  }

  return nearest;
}


/**
 * Query V8 for possible breakpoint locations in a range.
 * 
 * @param session - CDP session
 * @param scriptId - The script ID to query
 * @param startLine - Start line (0-based for CDP)
 * @param startColumn - Start column (0-based)
 * @param endLine - End line (0-based for CDP)
 * @param endColumn - End column (0-based)
 * @param scriptUrl - The URL of the script (for the returned locations)
 * @returns Array of breakpoint locations
 */
export async function queryPossibleBreakpoints(
  session: CDPSession,
  scriptId: string,
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
  scriptUrl: string
): Promise<BreakpointLocation[]> {
  try {
    const params = {
      start: {
        scriptId,
        lineNumber: startLine,
        columnNumber: startColumn,
      },
      end: {
        scriptId,
        lineNumber: endLine,
        columnNumber: endColumn,
      },
    };
    const result = await session.send('Debugger.getPossibleBreakpoints', params);
    const locations = (result as any).locations || [];
    return locations.map((loc: any) => ({
      scriptId: loc.scriptId,
      scriptUrl,
      lineNumber: loc.lineNumber + 1, // Convert to 1-based for display
      columnNumber: loc.columnNumber,
    }));
  } catch (error) {
    logger(`[debugger] Failed to get possible breakpoints: ${error}`);
    return [];
  }
}

// Script cache per CDP session
const scriptCaches = new WeakMap<CDPSession, Map<string, ScriptInfo>>();

/**
 * Get or create the script cache for a CDP session.
 */
export function getScriptCache(session: CDPSession): Map<string, ScriptInfo> {
  let cache = scriptCaches.get(session);
  if (!cache) {
    cache = new Map();
    scriptCaches.set(session, cache);
  }
  return cache;
}

/**
 * Add a script to the cache (called from scriptParsed event handler).
 */
export function cacheScript(session: CDPSession, script: ScriptInfo): void {
  const cache = getScriptCache(session);
  cache.set(script.scriptId, script);
}

/**
 * Clear the script cache for a session (called on navigation).
 */
export function clearScriptCache(session: CDPSession): void {
  const cache = scriptCaches.get(session);
  if (cache) {
    cache.clear();
  }
}

/**
 * Find scripts matching a URL regex pattern.
 * Uses the script cache if available, otherwise queries CDP.
 * 
 * @param session - CDP session
 * @param urlRegex - Regular expression pattern to match script URLs
 * @returns Array of matching script info objects
 */
export async function findMatchingScripts(
  session: CDPSession,
  urlRegex: string
): Promise<ScriptInfo[]> {
  const cache = getScriptCache(session);
  const regex = new RegExp(urlRegex);
  const matchingScripts: ScriptInfo[] = [];

  // First, try to find matches in the cache
  for (const script of cache.values()) {
    if (regex.test(script.url)) {
      matchingScripts.push(script);
    }
  }

  // If we found matches in cache, return them
  if (matchingScripts.length > 0) {
    return matchingScripts;
  }

  // If cache is empty or no matches, we need to rely on scripts being
  // populated via scriptParsed events. The cache should be populated
  // when the debugger is enabled.
  logger(`[debugger] No cached scripts matching pattern: ${urlRegex}`);
  return [];
}

/**
 * Fetch script source via CDP Debugger.getScriptSource.
 * Caches the source in the script info for subsequent calls.
 * 
 * @param session - CDP session
 * @param scriptId - The script ID to fetch source for
 * @returns The script source, or null if not found
 */
export async function getScriptSource(
  session: CDPSession,
  scriptId: string
): Promise<string | null> {
  const cache = getScriptCache(session);
  const scriptInfo = cache.get(scriptId);

  // Return cached source if available
  if (scriptInfo?.source !== undefined) {
    return scriptInfo.source;
  }

  try {
    const result = await session.send('Debugger.getScriptSource', {scriptId});
    const source = (result as any).scriptSource || null;

    // Cache the source in the script info
    if (scriptInfo && source !== null) {
      scriptInfo.source = source;
    }

    return source;
  } catch (error) {
    logger(`[debugger] Failed to get script source for ${scriptId}: ${error}`);
    return null;
  }
}

/**
 * Get all cached scripts with their sources.
 * Fetches sources for scripts that don't have them cached yet.
 * Uses parallel fetching with concurrency limit for better performance.
 * 
 * @param session - CDP session
 * @param urlPattern - Optional regex pattern to filter scripts by URL
 * @returns Map of scriptId to {url, source}
 */
export async function getAllScriptsWithSource(
  session: CDPSession,
  urlPattern?: string
): Promise<Map<string, {url: string; source: string}>> {
  const cache = getScriptCache(session);
  const result = new Map<string, {url: string; source: string}>();
  const regex = urlPattern ? new RegExp(urlPattern) : null;

  // Collect scripts that need source fetching
  const scriptsToFetch: Array<{scriptId: string; url: string}> = [];
  
  for (const [scriptId, scriptInfo] of cache) {
    // Filter by URL pattern if provided
    if (regex && !regex.test(scriptInfo.url)) {
      continue;
    }

    // Skip scripts without URLs (internal scripts)
    if (!scriptInfo.url) {
      continue;
    }

    // If source is already cached, add directly to result
    if (scriptInfo.source !== undefined) {
      result.set(scriptId, {url: scriptInfo.url, source: scriptInfo.source});
    } else {
      scriptsToFetch.push({scriptId, url: scriptInfo.url});
    }
  }

  // Fetch sources in parallel with concurrency limit
  const CONCURRENCY_LIMIT = 10;
  for (let i = 0; i < scriptsToFetch.length; i += CONCURRENCY_LIMIT) {
    const batch = scriptsToFetch.slice(i, i + CONCURRENCY_LIMIT);
    const sources = await Promise.all(
      batch.map(({scriptId}) => getScriptSource(session, scriptId))
    );
    
    for (let j = 0; j < batch.length; j++) {
      const source = sources[j];
      if (source !== null) {
        result.set(batch[j].scriptId, {url: batch[j].url, source});
      }
    }
  }

  return result;
}
