/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type definitions for IR Debugger components.
 * Provides types for JSVMP IR-level debugging capabilities.
 */

// ============================================================================
// Error Codes
// ============================================================================

/**
 * Error codes for IR Debugger operations.
 */
export const ErrorCodes = {
  FILE_NOT_FOUND: 'IR_FILE_NOT_FOUND',
  INVALID_JSON: 'IR_INVALID_JSON',
  INVALID_SOURCE_MAP: 'IR_INVALID_SOURCE_MAP',
  SESSION_NOT_FOUND: 'IR_SESSION_NOT_FOUND',
  MAPPING_NOT_FOUND: 'IR_MAPPING_NOT_FOUND',
  NOT_PAUSED: 'IR_NOT_PAUSED',
  CDP_ERROR: 'IR_CDP_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// ============================================================================
// Session Configuration
// ============================================================================

/**
 * Configuration for creating an IR debugging session.
 */
export interface IRSessionConfig {
  /** Path to the source map JSON file */
  sourceMapPath: string;
  /** URL pattern to match the original JS file (derived from sourceFileUrl in source map) */
  urlPattern: string;
  /** Path to the ASM file (derived from sourceMapPath) */
  asmPath: string;
}

/**
 * Information about an IR debugging session.
 */
export interface IRSessionInfo {
  /** Unique session identifier */
  sessionId: string;
  /** Path to the source map file */
  sourceMapPath: string;
  /** URL pattern for the original JS file */
  urlPattern: string;
  /** Path to the ASM file */
  asmPath: string;
  /** Number of active breakpoints in this session */
  breakpointCount: number;
}

// ============================================================================
// VM Registers
// ============================================================================

/**
 * Information about a single VM register.
 */
export interface VMRegisterInfo {
  /** Variable name in the original JS code */
  name: string;
  /** Human-readable description */
  description: string;
}

/**
 * VM register definitions from the source map.
 */
export interface VMRegisters {
  /** Instruction Pointer register */
  ip: VMRegisterInfo;
  /** Stack Pointer register */
  sp: VMRegisterInfo;
  /** Virtual Stack register */
  stack: VMRegisterInfo;
  /** Bytecode Array register */
  bytecode: VMRegisterInfo;
  /** Scope Chain Array register */
  scope: VMRegisterInfo;
  /** Constants Pool register */
  constants: VMRegisterInfo;
}

// ============================================================================
// VM Info
// ============================================================================

/**
 * VM dispatcher information.
 */
export interface VMDispatcher {
  /** Function name containing the dispatcher */
  function: string;
  /** Line number in the original JS file */
  line: number;
  /** Column number in the original JS file */
  column: number;
  /** Human-readable description */
  description: string;
}

/**
 * VM entry point information.
 */
export interface VMEntryPoint {
  /** Line number in the original JS file */
  line: number;
  /** Column number in the original JS file */
  column: number;
  /** Human-readable description */
  description: string;
}

/**
 * Complete VM information from the source map.
 */
export interface VMInfo {
  /** Dispatcher information */
  dispatcher: VMDispatcher;
  /** Register definitions */
  registers: VMRegisters;
  /** Entry point information */
  entryPoint: VMEntryPoint;
}

// ============================================================================
// Function Info
// ============================================================================

/**
 * Information about a function in the IR code.
 */
export interface IRFunctionInfo {
  /** Function ID */
  id: number;
  /** Function name */
  name: string;
  /** Bytecode address range [start, end] */
  bytecodeRange: [number, number];
  /** IR line range [start, end] */
  irLineRange: [number, number];
  /** Number of parameters */
  params: number;
  /** Whether the function is in strict mode */
  strict: boolean;
}

// ============================================================================
// Watch Expressions
// ============================================================================

/**
 * A watch expression for extracting VM state.
 */
export interface WatchExpression {
  /** IR variable name (e.g., "$stack[0]", "$pc") */
  name: string;
  /** VM expression to evaluate (e.g., "v2[p2]", "a2") */
  expr: string;
}

// ============================================================================
// Breakpoint Info
// ============================================================================

/**
 * Breakpoint configuration from the source map.
 */
export interface BreakpointConfig {
  /** Condition expression for the breakpoint */
  condition: string;
  /** Log message when breakpoint is hit */
  logMessage: string;
  /** Watch expressions to evaluate when paused */
  watchExpressions: WatchExpression[];
}

/**
 * Source location in the original JS file.
 */
export interface SourceLocation {
  /** Line number (1-based) */
  line: number;
  /** Column number (0-based) */
  column: number;
}

// ============================================================================
// IR Mapping
// ============================================================================

/**
 * Mapping between IR code and original JS code.
 */
export interface IRMapping {
  /** IR line number */
  irLine: number;
  /** IR address (PC value) */
  irAddr: number;
  /** Opcode number */
  opcode: number;
  /** Opcode name */
  opcodeName: string;
  /** Source location in the original JS file */
  source: SourceLocation;
  /** Breakpoint configuration */
  breakpoint: BreakpointConfig;
  /** Semantic description of the instruction */
  semantic: string;
}

// ============================================================================
// Parsed Source Map
// ============================================================================

/**
 * Parsed and indexed source map.
 */
export interface ParsedSourceMap {
  /** Source map version */
  version: number;
  /** IR file name */
  file: string;
  /** Original JS file relative path */
  sourceFile: string;
  /** Original JS file URL */
  sourceFileUrl: string;
  /** VM information */
  vm: VMInfo;
  /** Function definitions */
  functions: IRFunctionInfo[];
  /** IR mappings */
  mappings: IRMapping[];
  /** Index: irLine → mapping */
  lineIndex: Map<number, IRMapping>;
  /** Index: irAddr → mapping */
  addrIndex: Map<number, IRMapping>;
  /** Index: opcodeName → mappings */
  opcodeIndex: Map<string, IRMapping[]>;
}

// ============================================================================
// IR Breakpoint Info
// ============================================================================

/**
 * Information about an IR breakpoint.
 */
export interface IRBreakpointInfo {
  /** IR line number (if set by line) */
  irLine?: number;
  /** IR address (if set by address) */
  irAddr?: number;
  /** CDP breakpoint ID */
  cdpBreakpointId: string;
  /** Combined condition expression */
  condition: string;
}

// ============================================================================
// IR State
// ============================================================================

/**
 * A single line of IR code context.
 */
export interface IRCodeLine {
  /** Line number in the ASM file */
  lineNumber: number;
  /** The IR code text */
  text: string;
  /** Whether this is the current execution line */
  isCurrent: boolean;
}

/**
 * IR code context around the current execution point.
 */
export interface IRCodeContext {
  /** Lines of IR code with context */
  lines: IRCodeLine[];
  /** Total number of lines in the ASM file */
  totalLines: number;
}

/**
 * IR state extracted when paused at a breakpoint.
 */
export interface IRState {
  /** Current IR line number */
  irLine: number;
  /** Current IR address (PC value) */
  irAddr: number;
  /** Current opcode number */
  opcode: number;
  /** Current opcode name */
  opcodeName: string;
  /** Semantic description of the current instruction */
  semantic: string;
  /** IR variables and their values */
  variables: Record<string, unknown>;
  /** IR code context (optional, only when ASM file is available) */
  codeContext?: IRCodeContext;
}

// ============================================================================
// IR Debugger Error
// ============================================================================

/**
 * Error response from IR Debugger operations.
 */
export interface IRDebuggerError {
  /** Error code */
  code: ErrorCode;
  /** Human-readable error message */
  message: string;
  /** Additional error details */
  details?: Record<string, unknown>;
}

// ============================================================================
// Source Map File (Raw JSON structure)
// ============================================================================

/**
 * Raw source map file structure (before parsing).
 */
export interface SourceMapFile {
  version: number;
  file: string;
  sourceFile: string;
  sourceFileUrl: string;
  vm: {
    dispatcher: {
      function: string;
      line: number;
      column: number;
      description?: string;
    };
    registers: {
      ip: { name: string; description: string };
      sp: { name: string; description: string };
      stack: { name: string; description: string };
      bytecode: { name: string; description: string };
      scope: { name: string; description: string };
      constants: { name: string; description: string };
    };
    entryPoint?: {
      line: number;
      column: number;
      description?: string;
    };
  };
  functions: Array<{
    id: number;
    name: string;
    bytecodeRange: [number, number];
    irLineRange: [number, number];
    params: number;
    strict: boolean;
  }>;
  mappings: Array<{
    irLine: number;
    irAddr: number;
    opcode: number;
    opcodeName: string;
    source: { line: number; column: number };
    breakpoint: {
      condition: string;
      logMessage: string;
      watchExpressions: Array<{ name: string; expr: string }>;
    };
    semantic: string;
  }>;
}
