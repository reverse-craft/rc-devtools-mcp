/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IR Source Map Manager
 * Manages IR source maps for debugging, including loading, retrieval, listing, and unloading.
 */

import type {
  IRSessionConfig,
  ParsedSourceMap,
  IRBreakpointInfo,
  VMRegisters,
  IRMapping,
  IRFunctionInfo,
  IRDebuggerError,
} from './ir-debugger-types.js';
import { ErrorCodes } from './ir-debugger-types.js';
import {
  parseSourceMap,
  getMappingByLine,
  getMappingByAddr,
  getMappingsByOpcode,
  getFunction,
} from './ir-source-map-parser.js';

/**
 * Result type for source map loading operations.
 */
export type LoadSourceMapResult =
  | { success: true; irId: string; session: IRSession; isReload: boolean }
  | { success: false; error: IRDebuggerError };

/**
 * Result type for source map retrieval operations.
 */
export type GetSourceMapResult =
  | { success: true; session: IRSession }
  | { success: false; error: IRDebuggerError };

/**
 * Result type for source map unloading operations.
 */
export type UnloadSourceMapResult =
  | { success: true; removedBreakpointIds: string[] }
  | { success: false; error: IRDebuggerError };

/**
 * Information about a loaded IR source map.
 */
export interface IRSourceMapInfo {
  /** Unique IR identifier */
  irId: string;
  /** Path to the source map file */
  sourceMapPath: string;
  /** URL pattern for the original JS file */
  urlPattern: string;
  /** Path to the ASM file */
  asmPath: string;
  /** Number of active breakpoints */
  breakpointCount: number;
}

/**
 * Represents a single IR debugging session.
 */
export class IRSession {
  readonly irId: string;
  readonly config: IRSessionConfig;
  readonly sourceMap: ParsedSourceMap;
  readonly breakpoints: Map<string, IRBreakpointInfo>;

  constructor(irId: string, config: IRSessionConfig, sourceMap: ParsedSourceMap) {
    this.irId = irId;
    this.config = config;
    this.sourceMap = sourceMap;
    this.breakpoints = new Map();
  }

  /**
   * Gets the VM register definitions.
   */
  getVMRegisters(): VMRegisters {
    return this.sourceMap.vm.registers;
  }

  /**
   * Gets a mapping by IR line number.
   */
  getMappingByLine(irLine: number): IRMapping | undefined {
    return getMappingByLine(this.sourceMap, irLine);
  }

  /**
   * Gets a mapping by IR address (PC value).
   */
  getMappingByAddr(irAddr: number): IRMapping | undefined {
    return getMappingByAddr(this.sourceMap, irAddr);
  }

  /**
   * Gets all mappings for a specific opcode name.
   */
  getMappingsByOpcode(opcodeName: string): IRMapping[] {
    return getMappingsByOpcode(this.sourceMap, opcodeName);
  }

  /**
   * Gets function information by function ID.
   */
  getFunction(functionId: number): IRFunctionInfo | undefined {
    return getFunction(this.sourceMap, functionId);
  }

  /**
   * Adds a breakpoint to the session's tracking.
   */
  addBreakpoint(key: string, info: IRBreakpointInfo): void {
    this.breakpoints.set(key, info);
  }

  /**
   * Removes a breakpoint from the session's tracking.
   */
  removeBreakpoint(key: string): IRBreakpointInfo | undefined {
    const info = this.breakpoints.get(key);
    if (info) {
      this.breakpoints.delete(key);
    }
    return info;
  }

  /**
   * Gets a breakpoint by its key.
   */
  getBreakpoint(key: string): IRBreakpointInfo | undefined {
    return this.breakpoints.get(key);
  }

  /**
   * Clears all breakpoints and returns their CDP IDs.
   */
  clearBreakpoints(): string[] {
    const cdpIds = Array.from(this.breakpoints.values()).map((bp) => bp.cdpBreakpointId);
    this.breakpoints.clear();
    return cdpIds;
  }

  /**
   * Gets the count of active breakpoints.
   */
  getBreakpointCount(): number {
    return this.breakpoints.size;
  }
}

/**
 * Counter for generating incremental IR IDs.
 */
let irIdCounter = 0;

/**
 * Generates a unique IR ID using an incrementing counter.
 */
function generateIrId(): string {
  irIdCounter++;
  return String(irIdCounter);
}

/**
 * Derives the ASM path from the source map path.
 * Removes the .map extension if present.
 */
export function deriveAsmPath(sourceMapPath: string): string {
  if (sourceMapPath.endsWith('.map')) {
    return sourceMapPath.slice(0, -4);
  }
  return sourceMapPath;
}

/**
 * Global storage for IR sessions.
 */
const irSessions = new Map<string, IRSession>();

/**
 * Input for loading an IR source map.
 */
export interface LoadSourceMapInput {
  /** Path to the source map JSON file */
  sourceMapPath: string;
}

/**
 * Finds an existing session by source map path.
 * @param sourceMapPath Path to the source map file
 * @returns The existing session or undefined
 */
function findSessionBySourceMapPath(sourceMapPath: string): IRSession | undefined {
  for (const session of irSessions.values()) {
    if (session.config.sourceMapPath === sourceMapPath) {
      return session;
    }
  }
  return undefined;
}

/**
 * Loads an IR source map for debugging.
 * If the same sourceMapPath was already loaded, it will be reloaded (updated)
 * while preserving the existing irId.
 * @param input Source map loading input (only sourceMapPath is required)
 * @returns LoadSourceMapResult with either the session or an error
 */
export function loadSourceMap(input: LoadSourceMapInput): LoadSourceMapResult {
  // Check if this source map is already loaded
  const existingSession = findSessionBySourceMapPath(input.sourceMapPath);

  // Parse the source map
  const parseResult = parseSourceMap(input.sourceMapPath);
  if (parseResult.success === false) {
    return { success: false, error: parseResult.error };
  }

  const sourceMap = parseResult.sourceMap;

  // Derive asmPath from sourceMapPath
  const asmPath = deriveAsmPath(input.sourceMapPath);

  // Use sourceFileUrl from source map as the URL pattern
  const urlPattern = sourceMap.sourceFileUrl;

  // Create session config
  const sessionConfig: IRSessionConfig = {
    sourceMapPath: input.sourceMapPath,
    urlPattern,
    asmPath,
  };

  // Reuse existing irId if reloading, otherwise generate new one
  const irId = existingSession ? existingSession.irId : generateIrId();
  const isReload = !!existingSession;

  // If reloading, remove the old session first
  if (existingSession) {
    irSessions.delete(existingSession.irId);
  }

  // Create session instance
  const session = new IRSession(irId, sessionConfig, sourceMap);

  // Store session
  irSessions.set(irId, session);

  return { success: true, irId, session, isReload };
}

/**
 * Gets an IR source map by ID.
 * @param irId IR ID
 * @returns GetSourceMapResult with either the session or an error
 */
export function getSourceMap(irId: string): GetSourceMapResult {
  const session = irSessions.get(irId);
  if (!session) {
    return {
      success: false,
      error: {
        code: ErrorCodes.SESSION_NOT_FOUND,
        message: `IR source map not found: ${irId}`,
        details: { irId },
      },
    };
  }
  return { success: true, session };
}

/**
 * Lists all loaded IR source maps.
 * @returns Array of source map information
 */
export function listSourceMaps(): IRSourceMapInfo[] {
  const sourceMaps: IRSourceMapInfo[] = [];
  irSessions.forEach((session) => {
    sourceMaps.push({
      irId: session.irId,
      sourceMapPath: session.config.sourceMapPath,
      urlPattern: session.config.urlPattern,
      asmPath: session.config.asmPath!,
      breakpointCount: session.getBreakpointCount(),
    });
  });
  return sourceMaps;
}

/**
 * Unloads an IR source map.
 * @param irId IR ID to unload
 * @returns UnloadSourceMapResult with either success info or an error
 */
export function unloadSourceMap(irId: string): UnloadSourceMapResult {
  const session = irSessions.get(irId);
  if (!session) {
    return {
      success: false,
      error: {
        code: ErrorCodes.SESSION_NOT_FOUND,
        message: `IR source map not found: ${irId}`,
        details: { irId },
      },
    };
  }

  // Get all CDP breakpoint IDs before clearing
  const removedBreakpointIds = session.clearBreakpoints();

  // Remove session from storage
  irSessions.delete(irId);

  return { success: true, removedBreakpointIds };
}

/**
 * Clears all source maps (useful for testing).
 * Also resets the IR ID counter.
 */
export function clearAllSourceMaps(): void {
  irSessions.clear();
  irIdCounter = 0;
}

/**
 * Gets the count of loaded source maps (useful for testing).
 */
export function getSourceMapCount(): number {
  return irSessions.size;
}

/**
 * Finds a source map by matching a URL against source map URL patterns.
 * @param url The URL to match (e.g., from a paused call frame)
 * @returns GetSourceMapResult with either the matching session or an error
 */
export function findSourceMapByUrl(url: string): GetSourceMapResult {
  for (const session of irSessions.values()) {
    const pattern = session.config.urlPattern;
    try {
      const regex = new RegExp(pattern);
      if (regex.test(url)) {
        return { success: true, session };
      }
    } catch {
      // If pattern is not a valid regex, try exact match
      if (url.includes(pattern)) {
        return { success: true, session };
      }
    }
  }

  return {
    success: false,
    error: {
      code: ErrorCodes.SESSION_NOT_FOUND,
      message: `No IR source map found matching URL: ${url}`,
      details: { url },
    },
  };
}
