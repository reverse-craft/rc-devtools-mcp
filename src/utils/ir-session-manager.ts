/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IR Session Manager
 * Manages IR debugging sessions, including creation, retrieval, listing, and removal.
 */

import type {
  IRSessionConfig,
  IRSessionInfo,
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
 * Result type for session creation operations.
 */
export type CreateSessionResult =
  | { success: true; sessionId: string; session: IRSession }
  | { success: false; error: IRDebuggerError };

/**
 * Result type for session retrieval operations.
 */
export type GetSessionResult =
  | { success: true; session: IRSession }
  | { success: false; error: IRDebuggerError };

/**
 * Result type for session removal operations.
 */
export type RemoveSessionResult =
  | { success: true; removedBreakpointIds: string[] }
  | { success: false; error: IRDebuggerError };

/**
 * Represents a single IR debugging session.
 */
export class IRSession {
  readonly sessionId: string;
  readonly config: IRSessionConfig;
  readonly sourceMap: ParsedSourceMap;
  readonly breakpoints: Map<string, IRBreakpointInfo>;

  constructor(sessionId: string, config: IRSessionConfig, sourceMap: ParsedSourceMap) {
    this.sessionId = sessionId;
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
 * Generates a unique session ID.
 */
function generateSessionId(): string {
  return `ir_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
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
 * Creates a new IR debugging session.
 * @param config Session configuration
 * @returns CreateSessionResult with either the session or an error
 */
export function createSession(config: IRSessionConfig): CreateSessionResult {
  // Parse the source map
  const parseResult = parseSourceMap(config.sourceMapPath);
  if (parseResult.success === false) {
    return { success: false, error: parseResult.error };
  }

  const sourceMap = parseResult.sourceMap;

  // Derive asmPath if not provided
  const asmPath = config.asmPath ?? deriveAsmPath(config.sourceMapPath);

  // Create session with derived asmPath
  const sessionConfig: IRSessionConfig = {
    ...config,
    asmPath,
  };

  // Generate unique session ID
  const sessionId = generateSessionId();

  // Create session instance
  const session = new IRSession(sessionId, sessionConfig, sourceMap);

  // Store session
  irSessions.set(sessionId, session);

  return { success: true, sessionId, session };
}

/**
 * Gets an IR session by ID.
 * @param sessionId Session ID
 * @returns GetSessionResult with either the session or an error
 */
export function getSession(sessionId: string): GetSessionResult {
  const session = irSessions.get(sessionId);
  if (!session) {
    return {
      success: false,
      error: {
        code: ErrorCodes.SESSION_NOT_FOUND,
        message: `IR session not found: ${sessionId}`,
        details: { sessionId },
      },
    };
  }
  return { success: true, session };
}

/**
 * Lists all active IR sessions.
 * @returns Array of session information
 */
export function listSessions(): IRSessionInfo[] {
  const sessions: IRSessionInfo[] = [];
  irSessions.forEach((session) => {
    sessions.push({
      sessionId: session.sessionId,
      sourceMapPath: session.config.sourceMapPath,
      urlPattern: session.config.urlPattern,
      asmPath: session.config.asmPath!,
      breakpointCount: session.getBreakpointCount(),
    });
  });
  return sessions;
}

/**
 * Removes an IR session.
 * @param sessionId Session ID to remove
 * @returns RemoveSessionResult with either success info or an error
 */
export function removeSession(sessionId: string): RemoveSessionResult {
  const session = irSessions.get(sessionId);
  if (!session) {
    return {
      success: false,
      error: {
        code: ErrorCodes.SESSION_NOT_FOUND,
        message: `IR session not found: ${sessionId}`,
        details: { sessionId },
      },
    };
  }

  // Get all CDP breakpoint IDs before clearing
  const removedBreakpointIds = session.clearBreakpoints();

  // Remove session from storage
  irSessions.delete(sessionId);

  return { success: true, removedBreakpointIds };
}

/**
 * Clears all sessions (useful for testing).
 */
export function clearAllSessions(): void {
  irSessions.clear();
}

/**
 * Gets the count of active sessions (useful for testing).
 */
export function getSessionCount(): number {
  return irSessions.size;
}
