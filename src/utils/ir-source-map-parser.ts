/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IR Source Map Parser
 * Parses JSVMP IR source map files and builds indexes for efficient lookups.
 */

import * as fs from 'fs';
import type {
  ParsedSourceMap,
  IRMapping,
  IRFunctionInfo,
  SourceMapFile,
  IRDebuggerError,
} from './ir-debugger-types.js';
import { ErrorCodes } from './ir-debugger-types.js';

/**
 * Result type for source map parsing operations.
 */
export type ParseResult =
  | { success: true; sourceMap: ParsedSourceMap }
  | { success: false; error: IRDebuggerError };

/**
 * Validates the raw source map file structure.
 */
function validateSourceMapFile(data: unknown): data is SourceMapFile {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const obj = data as Record<string, unknown>;

  // Check required top-level fields
  if (typeof obj.version !== 'number') return false;
  if (typeof obj.file !== 'string') return false;
  if (typeof obj.sourceFile !== 'string') return false;
  if (typeof obj.sourceFileUrl !== 'string') return false;
  if (typeof obj.vm !== 'object' || obj.vm === null) return false;
  if (!Array.isArray(obj.functions)) return false;
  if (!Array.isArray(obj.mappings)) return false;

  // Check VM structure
  const vm = obj.vm as Record<string, unknown>;
  if (typeof vm.dispatcher !== 'object' || vm.dispatcher === null) return false;
  if (typeof vm.registers !== 'object' || vm.registers === null) return false;

  // Check dispatcher
  const dispatcher = vm.dispatcher as Record<string, unknown>;
  if (typeof dispatcher.function !== 'string') return false;
  if (typeof dispatcher.line !== 'number') return false;
  if (typeof dispatcher.column !== 'number') return false;

  // Check registers
  const registers = vm.registers as Record<string, unknown>;
  const requiredRegisters = ['ip', 'sp', 'stack', 'bytecode', 'scope', 'constants'];
  for (const reg of requiredRegisters) {
    const regInfo = registers[reg] as Record<string, unknown> | undefined;
    if (!regInfo || typeof regInfo.name !== 'string' || typeof regInfo.description !== 'string') {
      return false;
    }
  }

  return true;
}

/**
 * Builds indexes for efficient mapping lookups.
 */
function buildIndexes(mappings: IRMapping[]): {
  lineIndex: Map<number, IRMapping>;
  addrIndex: Map<number, IRMapping>;
  opcodeIndex: Map<string, IRMapping[]>;
} {
  const lineIndex = new Map<number, IRMapping>();
  const addrIndex = new Map<number, IRMapping>();
  const opcodeIndex = new Map<string, IRMapping[]>();

  for (const mapping of mappings) {
    // Index by IR line
    lineIndex.set(mapping.irLine, mapping);

    // Index by IR address
    addrIndex.set(mapping.irAddr, mapping);

    // Index by opcode name
    const existing = opcodeIndex.get(mapping.opcodeName);
    if (existing) {
      existing.push(mapping);
    } else {
      opcodeIndex.set(mapping.opcodeName, [mapping]);
    }
  }

  return { lineIndex, addrIndex, opcodeIndex };
}

/**
 * Parses a source map file and builds indexes.
 * @param sourceMapPath Path to the source map JSON file
 * @returns ParseResult with either the parsed source map or an error
 */
export function parseSourceMap(sourceMapPath: string): ParseResult {
  // Check if file exists
  if (!fs.existsSync(sourceMapPath)) {
    return {
      success: false,
      error: {
        code: ErrorCodes.FILE_NOT_FOUND,
        message: `Source map file not found: ${sourceMapPath}`,
        details: { path: sourceMapPath },
      },
    };
  }

  // Read file content
  let content: string;
  try {
    content = fs.readFileSync(sourceMapPath, 'utf-8');
  } catch (err) {
    return {
      success: false,
      error: {
        code: ErrorCodes.FILE_NOT_FOUND,
        message: `Failed to read source map file: ${sourceMapPath}`,
        details: { path: sourceMapPath, error: String(err) },
      },
    };
  }

  // Parse JSON
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    const parseError = err as SyntaxError;
    return {
      success: false,
      error: {
        code: ErrorCodes.INVALID_JSON,
        message: `Invalid JSON in source map file: ${parseError.message}`,
        details: { path: sourceMapPath, error: parseError.message },
      },
    };
  }

  // Validate structure
  if (!validateSourceMapFile(data)) {
    return {
      success: false,
      error: {
        code: ErrorCodes.INVALID_SOURCE_MAP,
        message: 'Invalid source map structure: missing or invalid required fields',
        details: { path: sourceMapPath },
      },
    };
  }

  // Convert raw data to typed structures
  const mappings: IRMapping[] = data.mappings.map((m) => ({
    irLine: m.irLine,
    irAddr: m.irAddr,
    opcode: m.opcode,
    opcodeName: m.opcodeName,
    source: {
      line: m.source.line,
      column: m.source.column,
    },
    breakpoint: {
      condition: m.breakpoint.condition,
      logMessage: m.breakpoint.logMessage,
      watchExpressions: m.breakpoint.watchExpressions.map((w) => ({
        name: w.name,
        expr: w.expr,
      })),
    },
    semantic: m.semantic,
  }));

  const functions: IRFunctionInfo[] = data.functions.map((f) => ({
    id: f.id,
    name: f.name,
    bytecodeRange: f.bytecodeRange,
    irLineRange: f.irLineRange,
    params: f.params,
    strict: f.strict,
  }));

  // Build indexes
  const { lineIndex, addrIndex, opcodeIndex } = buildIndexes(mappings);

  // Construct parsed source map
  const sourceMap: ParsedSourceMap = {
    version: data.version,
    file: data.file,
    sourceFile: data.sourceFile,
    sourceFileUrl: data.sourceFileUrl,
    vm: {
      dispatcher: {
        function: data.vm.dispatcher.function,
        line: data.vm.dispatcher.line,
        column: data.vm.dispatcher.column,
        description: data.vm.dispatcher.description || '',
      },
      registers: {
        ip: {
          name: data.vm.registers.ip.name,
          description: data.vm.registers.ip.description,
        },
        sp: {
          name: data.vm.registers.sp.name,
          description: data.vm.registers.sp.description,
        },
        stack: {
          name: data.vm.registers.stack.name,
          description: data.vm.registers.stack.description,
        },
        bytecode: {
          name: data.vm.registers.bytecode.name,
          description: data.vm.registers.bytecode.description,
        },
        scope: {
          name: data.vm.registers.scope.name,
          description: data.vm.registers.scope.description,
        },
        constants: {
          name: data.vm.registers.constants.name,
          description: data.vm.registers.constants.description,
        },
      },
      entryPoint: data.vm.entryPoint
        ? {
            line: data.vm.entryPoint.line,
            column: data.vm.entryPoint.column,
            description: data.vm.entryPoint.description || '',
          }
        : {
            line: data.vm.dispatcher.line,
            column: data.vm.dispatcher.column,
            description: '',
          },
    },
    functions,
    mappings,
    lineIndex,
    addrIndex,
    opcodeIndex,
  };

  return { success: true, sourceMap };
}

/**
 * Gets a mapping by IR line number.
 * @param sourceMap Parsed source map
 * @param irLine IR line number
 * @returns The mapping or undefined if not found
 */
export function getMappingByLine(
  sourceMap: ParsedSourceMap,
  irLine: number
): IRMapping | undefined {
  return sourceMap.lineIndex.get(irLine);
}

/**
 * Gets a mapping by IR address (PC value).
 * @param sourceMap Parsed source map
 * @param irAddr IR address
 * @returns The mapping or undefined if not found
 */
export function getMappingByAddr(
  sourceMap: ParsedSourceMap,
  irAddr: number
): IRMapping | undefined {
  return sourceMap.addrIndex.get(irAddr);
}

/**
 * Gets all mappings for a specific opcode name.
 * @param sourceMap Parsed source map
 * @param opcodeName Opcode name to search for
 * @returns Array of mappings (empty if none found)
 */
export function getMappingsByOpcode(
  sourceMap: ParsedSourceMap,
  opcodeName: string
): IRMapping[] {
  return sourceMap.opcodeIndex.get(opcodeName) || [];
}

/**
 * Gets function information by function ID.
 * @param sourceMap Parsed source map
 * @param functionId Function ID
 * @returns The function info or undefined if not found
 */
export function getFunction(
  sourceMap: ParsedSourceMap,
  functionId: number
): IRFunctionInfo | undefined {
  return sourceMap.functions.find((f) => f.id === functionId);
}

/**
 * Gets function information by IR line number.
 * @param sourceMap Parsed source map
 * @param irLine IR line number
 * @returns The function info or undefined if not found
 */
export function getFunctionByLine(
  sourceMap: ParsedSourceMap,
  irLine: number
): IRFunctionInfo | undefined {
  return sourceMap.functions.find(
    (f) => irLine >= f.irLineRange[0] && irLine <= f.irLineRange[1]
  );
}

/**
 * Gets function information by IR address (PC value).
 * @param sourceMap Parsed source map
 * @param irAddr IR address
 * @returns The function info or undefined if not found
 */
export function getFunctionByAddr(
  sourceMap: ParsedSourceMap,
  irAddr: number
): IRFunctionInfo | undefined {
  return sourceMap.functions.find(
    (f) => irAddr >= f.bytecodeRange[0] && irAddr <= f.bytecodeRange[1]
  );
}
