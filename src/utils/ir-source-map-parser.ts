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
 * Validation result with detailed error information.
 */
interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates the raw source map file structure and returns detailed errors.
 */
function validateSourceMapFile(data: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof data !== 'object' || data === null) {
    errors.push('Source map must be a JSON object');
    return { valid: false, errors };
  }

  const obj = data as Record<string, unknown>;

  // Check required top-level fields
  if (typeof obj.version !== 'number') {
    errors.push('Missing or invalid field: "version" (must be a number)');
  }
  if (typeof obj.file !== 'string') {
    errors.push('Missing or invalid field: "file" (must be a string)');
  }
  if (typeof obj.sourceFile !== 'string') {
    errors.push('Missing or invalid field: "sourceFile" (must be a string)');
  }
  if (typeof obj.sourceFileUrl !== 'string') {
    errors.push('Missing or invalid field: "sourceFileUrl" (must be a string)');
    errors.push('  → This field is required for URL pattern matching');
    errors.push('  → Hint: Add "sourceFileUrl": "<your-js-file-url>" to the source map');
  }
  if (typeof obj.vm !== 'object' || obj.vm === null) {
    errors.push('Missing or invalid field: "vm" (must be an object)');
  } else {
    // Check VM structure
    const vm = obj.vm as Record<string, unknown>;
    
    if (typeof vm.dispatcher !== 'object' || vm.dispatcher === null) {
      errors.push('Missing or invalid field: "vm.dispatcher" (must be an object)');
      errors.push('  → Expected structure: { "function": "...", "line": 123, "column": 0 }');
      if (vm.dispatcherLocation) {
        errors.push('  → Found "vm.dispatcherLocation" instead - this is an old format');
        errors.push('  → Rename "dispatcherLocation" to "dispatcher" and add "function" field');
      }
    } else {
      const dispatcher = vm.dispatcher as Record<string, unknown>;
      if (typeof dispatcher.function !== 'string') {
        errors.push('Missing or invalid field: "vm.dispatcher.function" (must be a string)');
      }
      if (typeof dispatcher.line !== 'number') {
        errors.push('Missing or invalid field: "vm.dispatcher.line" (must be a number)');
      }
      if (typeof dispatcher.column !== 'number') {
        errors.push('Missing or invalid field: "vm.dispatcher.column" (must be a number)');
      }
    }

    if (typeof vm.registers !== 'object' || vm.registers === null) {
      errors.push('Missing or invalid field: "vm.registers" (must be an object)');
      if (vm.components) {
        errors.push('  → Found "vm.components" instead - this is an old format');
        errors.push('  → Rename "components" to "registers" and update field names:');
        errors.push('     • instructionPointer → ip');
        errors.push('     • stackPointer → sp');
        errors.push('     • virtualStack → stack');
        errors.push('     • bytecodeArray → bytecode');
        errors.push('     • constantPool → constants');
        errors.push('     • scopeChain → scope');
      }
    } else {
      const registers = vm.registers as Record<string, unknown>;
      const requiredRegisters = ['ip', 'sp', 'stack', 'bytecode', 'scope', 'constants'];
      for (const reg of requiredRegisters) {
        const regInfo = registers[reg] as Record<string, unknown> | undefined;
        if (!regInfo) {
          errors.push(`Missing field: "vm.registers.${reg}"`);
        } else {
          if (typeof regInfo.name !== 'string') {
            errors.push(`Missing or invalid field: "vm.registers.${reg}.name" (must be a string)`);
          }
          if (typeof regInfo.description !== 'string') {
            errors.push(`Missing or invalid field: "vm.registers.${reg}.description" (must be a string)`);
          }
        }
      }
    }
  }

  if (!Array.isArray(obj.functions)) {
    errors.push('Missing or invalid field: "functions" (must be an array)');
  } else if (obj.functions.length > 0) {
    const firstFunc = obj.functions[0] as Record<string, unknown>;
    if (typeof firstFunc.id !== 'number' && typeof firstFunc.index === 'number') {
      errors.push('Invalid field in "functions": found "index" instead of "id"');
      errors.push('  → This is an old format - rename "index" to "id" in all function objects');
    }
    if (typeof firstFunc.params !== 'number' && typeof firstFunc.locals === 'number') {
      errors.push('Invalid field in "functions": found "locals" instead of "params"');
      errors.push('  → This is an old format - rename "locals" to "params" in all function objects');
    }
  }

  if (!Array.isArray(obj.mappings)) {
    errors.push('Missing or invalid field: "mappings" (must be an array)');
  }

  return { valid: errors.length === 0, errors };
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
  const validation = validateSourceMapFile(data);
  if (!validation.valid) {
    return {
      success: false,
      error: {
        code: ErrorCodes.INVALID_SOURCE_MAP,
        message: 'Invalid source map structure',
        details: { 
          path: sourceMapPath,
          errors: validation.errors,
          errorCount: validation.errors.length
        },
      },
    };
  }

  // Type assertion after validation
  const sourceMapData = data as SourceMapFile;

  // Convert raw data to typed structures
  const mappings: IRMapping[] = sourceMapData.mappings.map((m) => ({
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

  const functions: IRFunctionInfo[] = sourceMapData.functions.map((f) => ({
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
    version: sourceMapData.version,
    file: sourceMapData.file,
    sourceFile: sourceMapData.sourceFile,
    sourceFileUrl: sourceMapData.sourceFileUrl,
    vm: {
      dispatcher: {
        function: sourceMapData.vm.dispatcher.function,
        line: sourceMapData.vm.dispatcher.line,
        column: sourceMapData.vm.dispatcher.column,
        description: sourceMapData.vm.dispatcher.description || '',
      },
      registers: {
        ip: {
          name: sourceMapData.vm.registers.ip.name,
          description: sourceMapData.vm.registers.ip.description,
        },
        sp: {
          name: sourceMapData.vm.registers.sp.name,
          description: sourceMapData.vm.registers.sp.description,
        },
        stack: {
          name: sourceMapData.vm.registers.stack.name,
          description: sourceMapData.vm.registers.stack.description,
        },
        bytecode: {
          name: sourceMapData.vm.registers.bytecode.name,
          description: sourceMapData.vm.registers.bytecode.description,
        },
        scope: {
          name: sourceMapData.vm.registers.scope.name,
          description: sourceMapData.vm.registers.scope.description,
        },
        constants: {
          name: sourceMapData.vm.registers.constants.name,
          description: sourceMapData.vm.registers.constants.description,
        },
      },
      entryPoint: sourceMapData.vm.entryPoint
        ? {
            line: sourceMapData.vm.entryPoint.line,
            column: sourceMapData.vm.entryPoint.column,
            description: sourceMapData.vm.entryPoint.description || '',
          }
        : {
            line: sourceMapData.vm.dispatcher.line,
            column: sourceMapData.vm.dispatcher.column,
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
