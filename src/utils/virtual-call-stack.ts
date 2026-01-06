/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Virtual Call Stack Constructor
 *
 * Detects JSVMP frames in the JavaScript call stack and constructs
 * a virtual call stack showing JSVMP function calls.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import type {CDPSession} from '../third-party/index.js';
import type {CallFrame, ScopeInfo} from './debugger-utils.js';
import type {VmasmContext} from './vmasm-context.js';
import type {RegisterMapping} from './vmasm-visitor.js';
import {formatHexDecimal} from './vm-state-utils.js';

// ==========================================
// Interfaces
// ==========================================

/**
 * Represents a detected JSVMP frame from the JavaScript call stack.
 *
 * Requirements: 3.3
 */
export interface JsvmpFrame {
  /** Index in the original JavaScript call stack */
  jsFrameIndex: number;

  /** CDP call frame ID for evaluation */
  cdpCallFrameId: string;

  /** Computed virtual instruction pointer (ip + offset) */
  virtualIp: number;

  /** Raw ip register value in this frame */
  rawIp: number;

  /** Offset value for this frame's bytecode segment (__jsvmp_offset) */
  offset: number;

  /** Stack pointer value (optional, for context) */
  sp?: number;

  /** Mapped vmasm line number (if available) */
  vmasmLine?: number;

  /** Opcode name at this address (if available) */
  opcodeName?: string;

  /** Function name derived from vmasm (if available) */
  functionName?: string;
}

/**
 * Result of virtual call stack construction.
 *
 * Requirements: 3.1, 3.2
 */
export interface VirtualCallStack {
  /** Ordered frames from innermost (current execution) to outermost (entry point) */
  frames: JsvmpFrame[];

  /** Total JavaScript frames analyzed */
  totalJsFrames: number;

  /** Number of JSVMP frames detected */
  jsvmpFrameCount: number;

  /** Any errors encountered during construction */
  errors: string[];
}

/**
 * Result of checking for __jsvmp_offset in a frame
 */
export interface JsvmpOffsetCheckResult {
  /** Whether __jsvmp_offset was found */
  found: boolean;
  /** The offset value if found and valid */
  value?: number;
  /** Error message if check failed */
  error?: string;
}

/**
 * Result of frame register evaluation
 */
export interface FrameRegisterResult {
  /** Whether evaluation succeeded */
  success: boolean;
  /** Raw ip register value */
  ip?: number;
  /** Stack pointer value */
  sp?: number;
  /** Offset value (__jsvmp_offset) */
  offset?: number;
  /** Error message if evaluation failed */
  error?: string;
}

// ==========================================
// Constants
// ==========================================

/** Variable name to look for in scope chain */
const OFFSET_VAR_NAME = '__jsvmp_offset';

/** Scope types to check, in priority order (local first, then closure) */
const SCOPE_PRIORITY: string[] = ['local', 'closure'];

/** Default timeout for CDP operations (ms) */
const CDP_TIMEOUT = 5000;

// ==========================================
// Helper Functions
// ==========================================

/**
 * Order scopes by priority (local first, then closure).
 * Filters out scopes that are not relevant for __jsvmp_offset detection.
 *
 * @param scopeChain - CDP scope chain
 * @returns Ordered array of relevant scopes
 */
function getOrderedScopes(scopeChain: ScopeInfo[]): ScopeInfo[] {
  const result: ScopeInfo[] = [];

  for (const scopeType of SCOPE_PRIORITY) {
    for (const scope of scopeChain) {
      if (scope.type === scopeType) {
        result.push(scope);
      }
    }
  }

  return result;
}

/**
 * Check a specific scope object for __jsvmp_offset variable.
 *
 * @param session - CDP session
 * @param objectId - CDP object ID for the scope
 * @returns Result containing found status and value if found
 */
async function checkScopeForOffset(
  session: CDPSession,
  objectId: string
): Promise<JsvmpOffsetCheckResult> {
  try {
    const propsResult = (await session.send('Runtime.getProperties', {
      objectId,
      ownProperties: true,
    })) as {result: Array<{name: string; value?: {type: string; value?: unknown}}>};

    const properties = propsResult.result || [];
    const offsetProp = properties.find(prop => prop.name === OFFSET_VAR_NAME);

    if (!offsetProp) {
      return {found: false};
    }

    const value = offsetProp.value;
    if (!value) {
      return {found: false, error: '__jsvmp_offset has no value'};
    }

    if (value.type !== 'number') {
      return {found: false, error: `__jsvmp_offset is not a number (type: ${value.type})`};
    }

    const numValue = value.value as number;
    if (typeof numValue !== 'number' || isNaN(numValue)) {
      return {found: false, error: '__jsvmp_offset is NaN or invalid'};
    }

    return {found: true, value: numValue};
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {found: false, error: errorMsg};
  }
}

/**
 * Get __jsvmp_offset value from frame scope.
 * Checks local scope first, then closure scopes.
 *
 * Requirements:
 * - 1.2: Check if __jsvmp_offset variable exists in the frame's scope chain
 * - 1.4: Check local scope first, then closure scopes in the scope chain
 * - 1.5: Handle cases where __jsvmp_offset is undefined or not a number
 *
 * @param session - CDP session
 * @param frame - CDP call frame to check
 * @returns Result containing found status and value if found
 */
export async function getJsvmpOffset(
  session: CDPSession,
  frame: CallFrame
): Promise<JsvmpOffsetCheckResult> {
  const orderedScopes = getOrderedScopes(frame.scopeChain);

  for (const scope of orderedScopes) {
    if (!scope.object.objectId) {
      continue;
    }

    const result = await checkScopeForOffset(session, scope.object.objectId);
    if (result.found) {
      return result;
    }
  }

  return {found: false};
}

/**
 * Check if a frame is a JSVMP frame by checking for __jsvmp_offset.
 *
 * @param session - CDP session
 * @param frame - CDP call frame to check
 * @returns True if __jsvmp_offset exists in scope chain
 */
export async function isJsvmpFrame(session: CDPSession, frame: CallFrame): Promise<boolean> {
  const result = await getJsvmpOffset(session, frame);
  return result.found;
}

/**
 * Evaluate frame registers (ip, sp) for a JSVMP frame.
 *
 * @param session - CDP session
 * @param callFrameId - CDP call frame ID
 * @param registers - Register mapping from vmasm
 * @param offset - The __jsvmp_offset value for this frame
 * @returns Frame register values
 */
export async function evaluateFrameRegisters(
  session: CDPSession,
  callFrameId: string,
  registers: RegisterMapping,
  offset: number
): Promise<FrameRegisterResult> {
  try {
    // Evaluate ip register
    const ipResult = (await session.send('Debugger.evaluateOnCallFrame', {
      callFrameId,
      expression: registers.ip,
      returnByValue: true,
      silent: true,
    })) as {result?: {value?: unknown}};

    const ip = ipResult.result?.value;
    if (typeof ip !== 'number') {
      return {success: false, error: `ip register is not a number: ${typeof ip}`};
    }

    // Evaluate sp register (optional)
    let sp: number | undefined;
    try {
      const spResult = (await session.send('Debugger.evaluateOnCallFrame', {
        callFrameId,
        expression: registers.sp,
        returnByValue: true,
        silent: true,
      })) as {result?: {value?: unknown}};

      if (typeof spResult.result?.value === 'number') {
        sp = spResult.result.value;
      }
    } catch {
      // sp is optional, ignore errors
    }

    return {
      success: true,
      ip,
      sp,
      offset,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {success: false, error: errorMsg};
  }
}

// ==========================================
// Main Functions
// ==========================================

/**
 * Construct a virtual call stack from the JavaScript call stack.
 *
 * Detects JSVMP frames by checking for __jsvmp_offset variable,
 * evaluates ip and offset for each frame, and maps to vmasm lines.
 *
 * Requirements:
 * - 3.1: Construct Virtual_Call_Stack from detected JSVMP_Frames
 * - 3.2: Frames ordered from innermost to outermost
 * - 3.3: Virtual frame contains Virtual_IP, frame index, and optional function name
 * - 3.4: Map virtual IP to vmasm line and opcode
 *
 * @param session - CDP session
 * @param callFrames - JavaScript call frames from debugger
 * @param vmasmContext - Vmasm context for address mapping
 * @returns Virtual call stack with detected JSVMP frames
 */
export async function constructVirtualCallStack(
  session: CDPSession,
  callFrames: CallFrame[],
  vmasmContext: VmasmContext
): Promise<VirtualCallStack> {
  const frames: JsvmpFrame[] = [];
  const errors: string[] = [];
  const registers = vmasmContext.getRegisterMapping();

  if (!registers) {
    return {
      frames: [],
      totalJsFrames: callFrames.length,
      jsvmpFrameCount: 0,
      errors: ['No register mapping available - vmasm file not loaded'],
    };
  }

  // Process each call frame
  for (let i = 0; i < callFrames.length; i++) {
    const frame = callFrames[i];

    try {
      // Check if this is a JSVMP frame
      const offsetResult = await getJsvmpOffset(session, frame);

      if (!offsetResult.found) {
        continue;
      }

      const offset = offsetResult.value!;

      // Evaluate registers for this frame
      const regResult = await evaluateFrameRegisters(
        session,
        frame.callFrameId,
        registers,
        offset
      );

      if (!regResult.success) {
        errors.push(`Frame ${i}: ${regResult.error}`);
        continue;
      }

      const rawIp = regResult.ip!;
      const virtualIp = rawIp + offset;

      // Map to vmasm line and opcode
      const instruction = vmasmContext.getInstructionAtAddress(virtualIp);
      const vmasmLine = instruction?.lineNumber;
      const opcodeName = instruction?.opcode;

      // Create JSVMP frame
      const jsvmpFrame: JsvmpFrame = {
        jsFrameIndex: i,
        cdpCallFrameId: frame.callFrameId,
        virtualIp,
        rawIp,
        offset,
        sp: regResult.sp,
        vmasmLine,
        opcodeName,
        functionName: frame.functionName || undefined,
      };

      frames.push(jsvmpFrame);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push(`Frame ${i}: ${errorMsg}`);
    }
  }

  return {
    frames,
    totalJsFrames: callFrames.length,
    jsvmpFrameCount: frames.length,
    errors,
  };
}

/**
 * Create an empty virtual call stack.
 *
 * @returns Empty VirtualCallStack
 */
export function createEmptyVirtualCallStack(): VirtualCallStack {
  return {
    frames: [],
    totalJsFrames: 0,
    jsvmpFrameCount: 0,
    errors: [],
  };
}

// ==========================================
// Formatting Functions
// ==========================================

/**
 * Format a single JSVMP frame for display.
 *
 * @param frame - The JSVMP frame to format
 * @param index - Display index (0 = innermost)
 * @returns Formatted string for the frame
 */
export function formatJsvmpFrame(frame: JsvmpFrame, index: number): string {
  const virtualIpHex = `0x${frame.virtualIp.toString(16).padStart(4, '0')}`;
  const opcode = frame.opcodeName || 'unknown';
  const line = frame.vmasmLine !== undefined ? `line ${frame.vmasmLine}` : 'line ?';

  return `   [${index}] ${virtualIpHex} ${opcode} (${line})`;
}

/**
 * Format the virtual call stack section for display.
 *
 * Requirements:
 * - 3.5: Display "No JSVMP frames detected" when empty
 * - 3.6: Fall back to JavaScript call stack on failure
 *
 * @param callStack - The virtual call stack to format
 * @param jsCallFrames - Original JavaScript call frames (for fallback)
 * @returns Array of formatted lines
 */
export function formatCallStackSection(
  callStack: VirtualCallStack,
  jsCallFrames?: CallFrame[]
): string[] {
  const lines: string[] = [];

  lines.push('📚 **JSVMP Call Stack:**');

  // Handle no JSVMP frames case
  if (callStack.jsvmpFrameCount === 0) {
    if (callStack.errors.length > 0) {
      // Fall back to JavaScript call stack on failure
      lines.push('   ⚠️ Failed to construct virtual call stack');
      for (const error of callStack.errors.slice(0, 3)) {
        lines.push(`      ${error}`);
      }

      if (jsCallFrames && jsCallFrames.length > 0) {
        lines.push('');
        lines.push('   JavaScript Call Stack (fallback):');
        for (let i = 0; i < Math.min(jsCallFrames.length, 5); i++) {
          const frame = jsCallFrames[i];
          const funcName = frame.functionName || '(anonymous)';
          lines.push(`      [${i}] ${funcName}`);
        }
        if (jsCallFrames.length > 5) {
          lines.push(`      ... ${jsCallFrames.length - 5} more frames`);
        }
      }
    } else {
      lines.push('   No JSVMP frames detected');
    }

    return lines;
  }

  // Display JSVMP frames
  lines.push(`   Depth: ${callStack.jsvmpFrameCount}`);
  lines.push('');

  // Frames are already ordered from innermost to outermost
  for (let i = 0; i < callStack.frames.length; i++) {
    const frame = callStack.frames[i];
    lines.push(formatJsvmpFrame(frame, i));
  }

  // Show errors if any
  if (callStack.errors.length > 0) {
    lines.push('');
    lines.push('   ⚠️ Some frames had errors:');
    for (const error of callStack.errors.slice(0, 3)) {
      lines.push(`      ${error}`);
    }
  }

  return lines;
}

/**
 * Format the virtual call stack as a single output string.
 *
 * @param callStack - The virtual call stack to format
 * @param jsCallFrames - Original JavaScript call frames (for fallback)
 * @returns Formatted output string
 */
export function formatCallStackOutput(
  callStack: VirtualCallStack,
  jsCallFrames?: CallFrame[]
): string {
  return formatCallStackSection(callStack, jsCallFrames).join('\n');
}
