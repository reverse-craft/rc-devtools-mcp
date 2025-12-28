/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IR State Extractor
 * Extracts and formats IR state when paused at a breakpoint.
 */

import * as fs from 'fs';
import type { CDPSession } from '../third-party/index.js';
import type {
  IRState,
  VMRegisters,
  WatchExpression,
  IRDebuggerError,
  IRCodeContext,
  IRCodeLine,
} from './ir-debugger-types.js';
import { ErrorCodes } from './ir-debugger-types.js';
import type { IRSession } from './ir-session-manager.js';
import type { DebuggerState } from './debugger-utils.js';

/**
 * Result type for state extraction operations.
 */
export type ExtractStateResult =
  | { success: true; state: IRState }
  | { success: false; error: IRDebuggerError };

/**
 * Options for state extraction.
 */
export interface ExtractStateOptions {
  /** Frame index to extract state from (default: 0) */
  frameIndex?: number;
  /** Maximum length for truncated values (default: from config) */
  maxValueLength?: number;
  /** Number of context lines before and after current line (default: 5) */
  contextLines?: number;
}

/**
 * Options for state formatting.
 */
export interface FormatStateOptions {
  /** Maximum length for truncated values (default: 300) */
  maxValueLength?: number;
  /** Whether to include the header line (default: true) */
  includeHeader?: boolean;
}

/**
 * Evaluates a JavaScript expression in the context of a call frame.
 * @param session CDP session
 * @param callFrameId Call frame ID
 * @param expression JavaScript expression to evaluate
 * @returns The evaluated value or undefined if evaluation failed
 */
async function evaluateExpression(
  session: CDPSession,
  callFrameId: string,
  expression: string
): Promise<unknown> {
  try {
    const result = await session.send('Debugger.evaluateOnCallFrame', {
      callFrameId,
      expression,
      returnByValue: true,
    });

    const evalResult = result as {
      result?: { value?: unknown };
      exceptionDetails?: unknown;
    };

    if (evalResult.exceptionDetails) {
      return undefined;
    }

    return evalResult.result?.value;
  } catch {
    return undefined;
  }
}

/**
 * Determines the current PC by evaluating the IP register expression.
 * @param session CDP session
 * @param callFrameId Call frame ID
 * @param registers VM register definitions
 * @returns The current PC value or undefined if evaluation failed
 */
async function getCurrentPC(
  session: CDPSession,
  callFrameId: string,
  registers: VMRegisters
): Promise<number | undefined> {
  const ipName = registers.ip.name;
  const value = await evaluateExpression(session, callFrameId, ipName);
  
  if (typeof value === 'number') {
    return value;
  }
  
  return undefined;
}

/**
 * Evaluates all watch expressions and returns the results.
 * @param session CDP session
 * @param callFrameId Call frame ID
 * @param watchExpressions Array of watch expressions to evaluate
 * @returns Record of IR variable names to their values
 */
async function evaluateWatchExpressions(
  session: CDPSession,
  callFrameId: string,
  watchExpressions: WatchExpression[]
): Promise<Record<string, unknown>> {
  const variables: Record<string, unknown> = {};

  // Evaluate all watch expressions in parallel for better performance
  const evaluationPromises = watchExpressions.map(async (watch) => {
    const value = await evaluateExpression(session, callFrameId, watch.expr);
    return { name: watch.name, value };
  });

  const results = await Promise.all(evaluationPromises);

  for (const { name, value } of results) {
    variables[name] = value;
  }

  return variables;
}

/** Cache for ASM file content to avoid repeated file reads */
const asmFileCache = new Map<string, string[]>();

/**
 * Reads and caches ASM file content.
 * @param asmPath Path to the ASM file
 * @returns Array of lines or undefined if file cannot be read
 */
function readAsmFile(asmPath: string): string[] | undefined {
  // Check cache first
  if (asmFileCache.has(asmPath)) {
    return asmFileCache.get(asmPath);
  }

  try {
    const content = fs.readFileSync(asmPath, 'utf-8');
    const lines = content.split('\n');
    asmFileCache.set(asmPath, lines);
    return lines;
  } catch {
    return undefined;
  }
}

/**
 * Gets IR code context around the current line.
 * @param asmPath Path to the ASM file
 * @param currentLine Current IR line number (1-based)
 * @param contextLines Number of lines before and after to include
 * @returns IRCodeContext or undefined if ASM file cannot be read
 */
function getIRCodeContext(
  asmPath: string,
  currentLine: number,
  contextLines: number
): IRCodeContext | undefined {
  const lines = readAsmFile(asmPath);
  if (!lines) {
    return undefined;
  }

  const totalLines = lines.length;
  const startLine = Math.max(1, currentLine - contextLines);
  const endLine = Math.min(totalLines, currentLine + contextLines);

  const contextCodeLines: IRCodeLine[] = [];
  for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
    const lineIndex = lineNum - 1; // Convert to 0-based index
    if (lineIndex >= 0 && lineIndex < lines.length) {
      contextCodeLines.push({
        lineNumber: lineNum,
        text: lines[lineIndex],
        isCurrent: lineNum === currentLine,
      });
    }
  }

  return {
    lines: contextCodeLines,
    totalLines,
  };
}

/**
 * Extracts the current IR state from a paused debugger.
 * @param session CDP session
 * @param irSession IR debugging session
 * @param debuggerState Current debugger state
 * @param options Extraction options
 * @returns ExtractStateResult with either the IR state or an error
 */
export async function extractState(
  session: CDPSession,
  irSession: IRSession,
  debuggerState: DebuggerState,
  options: ExtractStateOptions = {}
): Promise<ExtractStateResult> {
  const { frameIndex = 0, contextLines = 5 } = options;

  // Check if debugger is paused
  if (!debuggerState.isPaused) {
    return {
      success: false,
      error: {
        code: ErrorCodes.NOT_PAUSED,
        message: 'Debugger is not currently paused. Cannot extract IR state.',
      },
    };
  }

  // Check if we have call frames
  if (!debuggerState.pausedCallFrames || debuggerState.pausedCallFrames.length === 0) {
    return {
      success: false,
      error: {
        code: ErrorCodes.NOT_PAUSED,
        message: 'No call frames available. Cannot extract IR state.',
      },
    };
  }

  // Validate frame index
  if (frameIndex >= debuggerState.pausedCallFrames.length) {
    return {
      success: false,
      error: {
        code: ErrorCodes.CDP_ERROR,
        message: `Invalid frame index: ${frameIndex}. Available frames: 0-${debuggerState.pausedCallFrames.length - 1}`,
        details: { frameIndex, availableFrames: debuggerState.pausedCallFrames.length },
      },
    };
  }

  const frame = debuggerState.pausedCallFrames[frameIndex];
  const registers = irSession.getVMRegisters();

  // Get current PC
  const currentPC = await getCurrentPC(session, frame.callFrameId, registers);

  if (currentPC === undefined) {
    return {
      success: false,
      error: {
        code: ErrorCodes.CDP_ERROR,
        message: 'Failed to determine current PC. The IP register expression could not be evaluated.',
        details: { ipRegister: registers.ip.name },
      },
    };
  }

  // Look up mapping for current PC
  const mapping = irSession.getMappingByAddr(currentPC);

  if (!mapping) {
    return {
      success: false,
      error: {
        code: ErrorCodes.MAPPING_NOT_FOUND,
        message: `No mapping found for PC address: ${currentPC}`,
        details: { irAddr: currentPC },
      },
    };
  }

  // Evaluate watch expressions
  const variables = await evaluateWatchExpressions(
    session,
    frame.callFrameId,
    mapping.breakpoint.watchExpressions
  );

  // Get IR code context if ASM path is available
  let codeContext: IRCodeContext | undefined;
  const asmPath = irSession.config.asmPath;
  if (asmPath && contextLines > 0) {
    codeContext = getIRCodeContext(asmPath, mapping.irLine, contextLines);
  }

  // Build IR state
  const state: IRState = {
    irLine: mapping.irLine,
    irAddr: mapping.irAddr,
    opcode: mapping.opcode,
    opcodeName: mapping.opcodeName,
    semantic: mapping.semantic,
    variables,
    codeContext,
  };

  return { success: true, state };
}

/**
 * Truncates a value string if it exceeds the maximum length.
 * @param value Value to format
 * @param maxLength Maximum length before truncation
 * @returns Formatted string with truncation indicator if needed
 */
export function truncateValue(value: unknown, maxLength: number): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }

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
 * Categorizes IR variables by type.
 * @param variables Record of variable names to values
 * @returns Categorized variables
 */
function categorizeVariables(variables: Record<string, unknown>): {
  registers: Array<{ name: string; value: unknown }>;
  stack: Array<{ name: string; value: unknown }>;
  scope: Array<{ name: string; value: unknown }>;
  constants: Array<{ name: string; value: unknown }>;
  other: Array<{ name: string; value: unknown }>;
} {
  const result = {
    registers: [] as Array<{ name: string; value: unknown }>,
    stack: [] as Array<{ name: string; value: unknown }>,
    scope: [] as Array<{ name: string; value: unknown }>,
    constants: [] as Array<{ name: string; value: unknown }>,
    other: [] as Array<{ name: string; value: unknown }>,
  };

  for (const [name, value] of Object.entries(variables)) {
    const entry = { name, value };

    if (name === '$pc' || name === '$sp' || name === '$opcode') {
      result.registers.push(entry);
    } else if (name.startsWith('$stack[')) {
      result.stack.push(entry);
    } else if (name.startsWith('$scope[')) {
      result.scope.push(entry);
    } else if (name.startsWith('$const[')) {
      result.constants.push(entry);
    } else {
      result.other.push(entry);
    }
  }

  // Sort stack and scope by index
  const extractIndex = (name: string): number => {
    const match = name.match(/\[(\d+)\]/);
    return match ? parseInt(match[1], 10) : 0;
  };

  result.stack.sort((a, b) => extractIndex(a.name) - extractIndex(b.name));
  result.scope.sort((a, b) => extractIndex(a.name) - extractIndex(b.name));
  result.constants.sort((a, b) => extractIndex(a.name) - extractIndex(b.name));

  return result;
}

/**
 * Formats IR state for display.
 * @param state IR state to format
 * @param options Formatting options
 * @returns Array of formatted output lines
 */
export function formatState(
  state: IRState,
  options: FormatStateOptions = {}
): string[] {
  const { maxValueLength = 300, includeHeader = true } = options;
  const output: string[] = [];

  // Header with location info
  if (includeHeader) {
    output.push(`📍 IR Location:`);
    output.push(`   Line: ${state.irLine}, PC: ${state.irAddr}`);
    output.push(`   Opcode: ${state.opcodeName} (${state.opcode})`);
    output.push(`   Semantic: ${state.semantic}`);
    output.push('');
  }

  // Format code context if available
  if (state.codeContext && state.codeContext.lines.length > 0) {
    output.push('📜 IR Code Context:');
    for (const line of state.codeContext.lines) {
      const marker = line.isCurrent ? '→' : ' ';
      const lineNumStr = String(line.lineNumber).padStart(6, ' ');
      output.push(`${marker} ${lineNumStr}: ${line.text}`);
    }
    output.push('');
  }

  // Categorize variables
  const categorized = categorizeVariables(state.variables);

  // Format registers
  if (categorized.registers.length > 0) {
    output.push('📊 Registers:');
    for (const { name, value } of categorized.registers) {
      const formattedValue = truncateValue(value, maxValueLength);
      output.push(`   ${name}: ${formattedValue}`);
    }
    output.push('');
  }

  // Format stack
  if (categorized.stack.length > 0) {
    output.push('📚 Stack:');
    for (const { name, value } of categorized.stack) {
      const formattedValue = truncateValue(value, maxValueLength);
      output.push(`   ${name}: ${formattedValue}`);
    }
    output.push('');
  }

  // Format scope
  if (categorized.scope.length > 0) {
    output.push('🔗 Scope:');
    for (const { name, value } of categorized.scope) {
      const formattedValue = truncateValue(value, maxValueLength);
      output.push(`   ${name}: ${formattedValue}`);
    }
    output.push('');
  }

  // Format constants
  if (categorized.constants.length > 0) {
    output.push('📦 Constants:');
    for (const { name, value } of categorized.constants) {
      const formattedValue = truncateValue(value, maxValueLength);
      output.push(`   ${name}: ${formattedValue}`);
    }
    output.push('');
  }

  // Format other variables
  if (categorized.other.length > 0) {
    output.push('📋 Other:');
    for (const { name, value } of categorized.other) {
      const formattedValue = truncateValue(value, maxValueLength);
      output.push(`   ${name}: ${formattedValue}`);
    }
    output.push('');
  }

  return output;
}

/**
 * Extracts and formats IR state in one operation.
 * @param session CDP session
 * @param irSession IR debugging session
 * @param debuggerState Current debugger state
 * @param options Combined extraction and formatting options
 * @returns Array of formatted output lines or error lines
 */
export async function extractAndFormatState(
  session: CDPSession,
  irSession: IRSession,
  debuggerState: DebuggerState,
  options: ExtractStateOptions & FormatStateOptions = {}
): Promise<string[]> {
  const result = await extractState(session, irSession, debuggerState, options);

  if (!result.success) {
    return [
      `❌ Failed to extract IR state:`,
      `   Error: ${result.error.message}`,
      `   Code: ${result.error.code}`,
    ];
  }

  return formatState(result.state, options);
}
