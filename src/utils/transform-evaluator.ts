/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Transform Evaluator - Evaluates opcode transform expressions
 *
 * Provides functionality to evaluate transform expressions from vmasm
 * @opcode_transform directives using CDP Debugger.evaluateOnCallFrame.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 5.2, 5.3
 */

import type {CDPSession} from '../third-party/index.js';
import type {
  OpcodeTransform,
  TransformVariable,
  ConstantEntry,
  RegisterMapping,
} from './vmasm-visitor.js';
import {resolveConstantReferences} from './constant-resolver.js';
import {formatValue, isExpandable, getTypeName} from './vm-state-utils.js';
import {substituteIdentifiers, type TransformResult} from './ast-transform.js';
import {logger} from './logger.js';

/**
 * Result of evaluating a single transform variable
 */
export interface EvaluatedVariable {
  /** Variable name from the transform */
  name: string;
  /** Original expression from the transform */
  expression: string;
  /** Expression with K[n] references resolved */
  resolvedExpression: string;
  /** Expression with register identifiers substituted (AST-transformed) */
  transformedExpression: string;
  /** Evaluated value (formatted for display) */
  value: string;
  /** Type of the evaluated value */
  type: string;
  /** Whether the value is expandable (object/array) */
  expandable: boolean;
  /** Error message if evaluation failed */
  error?: string;
  /** Whether this is a post-execution expression */
  isPost?: boolean;
  /** Whether AST transformation was applied */
  wasTransformed: boolean;
}

/**
 * Result of evaluating all transform variables for an instruction
 */
export interface EvaluatedTransform {
  /** Opcode number */
  opcodeNumber: number;
  /** Opcode name */
  opcodeName: string;
  /** Evaluated pre-execution variables */
  variables: EvaluatedVariable[];
  /** Errors encountered during evaluation */
  errors: string[];
}

/**
 * Result of evaluating transform variables including previous instruction
 */
export interface TransformEvaluationResult {
  /** Current instruction's transform evaluation */
  current?: EvaluatedTransform;
  /** Previous instruction's post-expression evaluation */
  previous?: {
    opcodeNumber: number;
    opcodeName: string;
    postVariables: EvaluatedVariable[];
  };
  /** Whether any transforms were found */
  hasTransforms: boolean;
}

/**
 * Represents a transform variable to be displayed
 */
export interface TransformVariableInfo {
  /** Variable name (e.g., fn, args, result) */
  name: string;

  /** Expression to evaluate (e.g., stack[sp - argCount]) */
  expression: string;

  /** Whether this is from the previous instruction's post-expressions */
  isPreviousInstruction: boolean;

  /** Display label for grouping (e.g., "Current Instruction", "Previous Instruction") */
  group?: string;
}

/**
 * Result of getTransformVariables
 */
export interface TransformVariablesResult {
  /** Variables from current instruction's pre-expressions */
  currentPreVariables: TransformVariableInfo[];

  /** Variables from previous instruction's post-expressions */
  previousPostVariables: TransformVariableInfo[];
}

/**
 * Provider for tracking previous instruction state
 * Used to evaluate post-expressions from the previous instruction
 *
 * Tracks current and previous instruction addresses to display
 * pre-expressions for current instruction and post-expressions
 * from the previous instruction.
 *
 * Requirements:
 * - 2.3: Show post-expressions from the previous instruction
 */
export class TransformVariableProvider {
  /** Current instruction address */
  private currentAddress: number = -1;

  /** Previous instruction address */
  private previousAddress: number = -1;

  /** Transform for the previous instruction (if any) */
  private previousTransform: OpcodeTransform | null = null;

  /** Callback to get transform for an address */
  private getTransformForAddressCallback:
    | ((address: number) => OpcodeTransform | null)
    | null = null;

  /**
   * Set the callback function to get transform for an address
   *
   * @param callback - Function that returns OpcodeTransform for a given address
   */
  setTransformLookup(
    callback: (address: number) => OpcodeTransform | null
  ): void {
    this.getTransformForAddressCallback = callback;
  }

  /**
   * Update the current instruction address
   * Called when the debugger steps to a new instruction.
   *
   * Requirements:
   * - 2.3: Track previous instruction address when stepping
   *
   * @param newAddress - The new instruction address
   * @param currentTransform - The transform for the current instruction (optional)
   */
  updateAddress(
    newAddress: number,
    currentTransform?: OpcodeTransform | null
  ): void {
    // Save the current address as previous before updating
    if (this.currentAddress >= 0 && newAddress !== this.currentAddress) {
      this.previousAddress = this.currentAddress;

      // Get the transform for the previous address if we have a lookup function
      if (this.getTransformForAddressCallback) {
        this.previousTransform = this.getTransformForAddressCallback(
          this.previousAddress
        );
      }
    }

    this.currentAddress = newAddress;
  }

  /**
   * Legacy update method for backward compatibility
   * Call this when stepping to a new instruction
   *
   * @param currentAddress - Current instruction address
   * @param currentTransform - Transform for the current instruction (if any)
   */
  update(
    currentAddress: number,
    currentTransform: OpcodeTransform | null
  ): void {
    // Save current as previous before updating
    if (this.currentAddress >= 0 && currentAddress !== this.currentAddress) {
      this.previousAddress = this.currentAddress;
      this.previousTransform = currentTransform;
    }
    this.currentAddress = currentAddress;
  }

  /**
   * Get the current instruction address
   */
  getCurrentAddress(): number {
    return this.currentAddress;
  }

  /**
   * Get the previous instruction's transform
   */
  getPreviousTransform(): OpcodeTransform | null {
    return this.previousTransform;
  }

  /**
   * Get the previous instruction's address
   */
  getPreviousAddress(): number {
    return this.previousAddress;
  }

  /**
   * Check if there are post-expressions from the previous instruction
   */
  hasPreviousPostExpressions(): boolean {
    return (
      this.previousTransform !== null &&
      this.previousTransform.postVariables.length > 0
    );
  }

  /**
   * Get transform variables for display
   *
   * Returns:
   * - Current instruction's pre-expressions
   * - Previous instruction's post-expressions (if any)
   *
   * Requirements:
   * - 2.2: Show all pre-expressions for the current instruction
   * - 2.3: Show post-expressions from the previous instruction
   *
   * @param currentTransform - The transform for the current instruction
   * @returns TransformVariablesResult with current pre and previous post variables
   */
  getTransformVariables(
    currentTransform: OpcodeTransform | null
  ): TransformVariablesResult {
    const result: TransformVariablesResult = {
      currentPreVariables: [],
      previousPostVariables: [],
    };

    // Add current instruction's pre-expressions
    if (currentTransform) {
      for (const expr of currentTransform.variables) {
        result.currentPreVariables.push({
          name: expr.name,
          expression: expr.expression,
          isPreviousInstruction: false,
          group: 'Current Instruction',
        });
      }
    }

    // Add previous instruction's post-expressions (if any)
    if (
      this.previousTransform &&
      this.previousTransform.postVariables.length > 0
    ) {
      for (const expr of this.previousTransform.postVariables) {
        result.previousPostVariables.push({
          name: expr.name,
          expression: expr.expression,
          isPreviousInstruction: true,
          group: 'Previous Instruction',
        });
      }
    }

    return result;
  }

  /**
   * Reset the provider state
   * Called when debug session ends or restarts
   */
  reset(): void {
    this.currentAddress = -1;
    this.previousAddress = -1;
    this.previousTransform = null;
  }

  /**
   * Manually set the previous transform
   * Useful for testing or when the transform is already known
   *
   * @param transform - The transform to set as previous
   */
  setPreviousTransform(transform: OpcodeTransform | null): void {
    this.previousTransform = transform;
  }
}


/**
 * Evaluate a single transform variable expression using CDP
 *
 * @param session - CDP session
 * @param callFrameId - Call frame ID for evaluation context
 * @param variable - Transform variable to evaluate
 * @param constants - Constant pool for K[n] resolution
 * @param registers - Register mapping for variable substitution
 * @returns Evaluated variable result
 *
 * Requirements: 2.1, 2.2, 2.4, 5.2, 5.3
 */
async function evaluateSingleVariable(
  session: CDPSession,
  callFrameId: string,
  variable: TransformVariable,
  constants: ConstantEntry[],
  registers: RegisterMapping
): Promise<EvaluatedVariable> {
  const {name, expression, isPost} = variable;

  // Requirement 5.2, 5.3: Handle missing register mappings gracefully
  // Check if registers object is valid
  if (!registers || typeof registers !== 'object') {
    logger(`Transform evaluation: Missing or invalid register mapping for variable "${name}". Using original expression.`);
    return {
      name,
      expression,
      resolvedExpression: expression,
      transformedExpression: expression,
      value: '<unavailable>',
      type: 'error',
      expandable: false,
      error: 'Missing register mapping',
      isPost,
      wasTransformed: false,
    };
  }

  // Resolve K[n] references in the expression
  // Requirement 5.3: Log warnings without interrupting output
  let resolvedExpression = expression;
  try {
    const resolveResult = resolveConstantReferences(expression, constants);
    resolvedExpression = resolveResult.resolved;
    
    // Log warning if there were invalid constant indices
    if (resolveResult.invalidIndices.length > 0) {
      logger(`Transform evaluation: Invalid constant indices [${resolveResult.invalidIndices.join(', ')}] in expression "${expression}" for variable "${name}".`);
    }
  } catch (resolveError) {
    // Requirement 5.3: Log warning but continue with original expression
    const errorMsg = resolveError instanceof Error ? resolveError.message : String(resolveError);
    logger(`Transform evaluation: Failed to resolve constants in expression "${expression}" for variable "${name}": ${errorMsg}`);
    resolvedExpression = expression;
  }

  // Use AST-based identifier substitution for register names
  // Requirements 2.1, 2.2, 5.2: Parse expression using Babel AST parser and replace identifiers
  // Missing mappings are handled gracefully by substituteIdentifiers
  let transformedExpression = resolvedExpression;
  let wasTransformed = false;
  
  try {
    const transformResult = substituteIdentifiers(resolvedExpression, registers);
    transformedExpression = transformResult.transformed;
    wasTransformed = transformResult.wasTransformed;
    
    // Requirement 5.3: Log if AST transform had an error but still produced output
    if (transformResult.error) {
      logger(`Transform evaluation: AST transform warning for variable "${name}": ${transformResult.error}`);
    }
  } catch (transformError) {
    // Requirement 5.3: Log warning but continue with resolved expression
    const errorMsg = transformError instanceof Error ? transformError.message : String(transformError);
    logger(`Transform evaluation: AST transform failed for variable "${name}": ${errorMsg}. Using resolved expression.`);
    transformedExpression = resolvedExpression;
    wasTransformed = false;
  }

  try {
    // Evaluate the transformed expression in the call frame context
    const result = await session.send('Debugger.evaluateOnCallFrame', {
      callFrameId,
      expression: transformedExpression,
      returnByValue: true,
      silent: true,
      timeout: 5000, // 5 second timeout
    });

    const evalResult = result as {
      result?: {value?: unknown; type?: string; description?: string};
      exceptionDetails?: {text?: string};
    };

    // Check for evaluation errors
    if (evalResult.exceptionDetails) {
      // Requirement 5.3: Log warning without interrupting output
      const errorText = evalResult.exceptionDetails.text || 'Evaluation failed';
      logger(`Transform evaluation: Expression evaluation failed for variable "${name}": ${errorText}`);
      
      return {
        name,
        expression,
        resolvedExpression,
        transformedExpression,
        value: '<error>',
        type: 'error',
        expandable: false,
        error: errorText,
        isPost,
        wasTransformed,
      };
    }

    const value = evalResult.result?.value;
    const formattedValue = formatValue(value);
    const type = getTypeName(value);
    const expandable = isExpandable(value);

    return {
      name,
      expression,
      resolvedExpression,
      transformedExpression,
      value: formattedValue,
      type,
      expandable,
      isPost,
      wasTransformed,
    };
  } catch (error) {
    // Requirement 5.3: Log warning without interrupting output
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger(`Transform evaluation: CDP evaluation failed for variable "${name}": ${errorMessage}`);
    
    return {
      name,
      expression,
      resolvedExpression,
      transformedExpression,
      value: '<error>',
      type: 'error',
      expandable: false,
      error: errorMessage,
      isPost,
      wasTransformed,
    };
  }
}

/**
 * Evaluate all transform variables for an opcode transform
 *
 * @param session - CDP session
 * @param callFrameId - Call frame ID for evaluation context
 * @param transform - Opcode transform definition
 * @param constants - Constant pool for K[n] resolution
 * @param registers - Register mapping
 * @returns Evaluated transform result
 *
 * Requirements: 2.1, 2.2, 2.4
 */
export async function evaluateTransform(
  session: CDPSession,
  callFrameId: string,
  transform: OpcodeTransform,
  constants: ConstantEntry[],
  registers: RegisterMapping
): Promise<EvaluatedTransform> {
  const evaluatedVariables: EvaluatedVariable[] = [];
  const errors: string[] = [];

  // Requirement 5.2, 5.3: Handle missing register mappings gracefully
  if (!registers || typeof registers !== 'object') {
    logger(`evaluateTransform: Missing or invalid register mapping for opcode ${transform.opcodeName}. Skipping variable evaluation.`);
    return {
      opcodeNumber: transform.opcodeNumber,
      opcodeName: transform.opcodeName,
      variables: [],
      errors: ['Missing register mapping'],
    };
  }

  // Evaluate pre-execution variables
  // Requirement 5.3: Continue processing even if individual variables fail
  for (const variable of transform.variables) {
    try {
      const result = await evaluateSingleVariable(
        session,
        callFrameId,
        variable,
        constants,
        registers
      );
      evaluatedVariables.push(result);

      if (result.error) {
        errors.push(`${result.name}: ${result.error}`);
      }
    } catch (error) {
      // Requirement 5.3: Log warning and continue with other variables
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger(`evaluateTransform: Failed to evaluate variable "${variable.name}": ${errorMessage}`);
      errors.push(`${variable.name}: ${errorMessage}`);
      
      // Add a placeholder result so the variable is still shown
      evaluatedVariables.push({
        name: variable.name,
        expression: variable.expression,
        resolvedExpression: variable.expression,
        transformedExpression: variable.expression,
        value: '<error>',
        type: 'error',
        expandable: false,
        error: errorMessage,
        isPost: variable.isPost,
        wasTransformed: false,
      });
    }
  }

  return {
    opcodeNumber: transform.opcodeNumber,
    opcodeName: transform.opcodeName,
    variables: evaluatedVariables,
    errors,
  };
}

/**
 * Evaluate post-execution variables from a transform
 *
 * @param session - CDP session
 * @param callFrameId - Call frame ID for evaluation context
 * @param transform - Opcode transform definition
 * @param constants - Constant pool for K[n] resolution
 * @param registers - Register mapping
 * @returns Array of evaluated post-variables
 *
 * Requirements: 2.3, 5.2, 5.3
 */
export async function evaluatePostVariables(
  session: CDPSession,
  callFrameId: string,
  transform: OpcodeTransform,
  constants: ConstantEntry[],
  registers: RegisterMapping
): Promise<EvaluatedVariable[]> {
  const evaluatedVariables: EvaluatedVariable[] = [];

  // Requirement 5.2, 5.3: Handle missing register mappings gracefully
  if (!registers || typeof registers !== 'object') {
    logger(`evaluatePostVariables: Missing or invalid register mapping for opcode ${transform.opcodeName}. Skipping post-variable evaluation.`);
    return [];
  }

  // Requirement 5.3: Continue processing even if individual variables fail
  for (const variable of transform.postVariables) {
    try {
      const result = await evaluateSingleVariable(
        session,
        callFrameId,
        {...variable, isPost: true},
        constants,
        registers
      );
      evaluatedVariables.push(result);
    } catch (error) {
      // Requirement 5.3: Log warning and continue with other variables
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger(`evaluatePostVariables: Failed to evaluate post-variable "${variable.name}": ${errorMessage}`);
      
      // Add a placeholder result so the variable is still shown
      evaluatedVariables.push({
        name: variable.name,
        expression: variable.expression,
        resolvedExpression: variable.expression,
        transformedExpression: variable.expression,
        value: '<error>',
        type: 'error',
        expandable: false,
        error: errorMessage,
        isPost: true,
        wasTransformed: false,
      });
    }
  }

  return evaluatedVariables;
}

/**
 * Evaluate transform variables for the current instruction
 *
 * This is the main entry point for transform evaluation. It:
 * 1. Gets the current instruction's opcode transform
 * 2. Evaluates pre-expressions with constant resolution
 * 3. Optionally evaluates post-expressions from the previous instruction
 *
 * @param session - CDP session
 * @param callFrameId - Call frame ID for evaluation context
 * @param currentAddress - Current instruction address
 * @param opcodeTransforms - Map of opcode number to transform
 * @param constants - Constant pool for K[n] resolution
 * @param registers - Register mapping
 * @param bytecode - Bytecode array to get opcode number
 * @param previousTransform - Previous instruction's transform (for post-expressions)
 * @returns Transform evaluation result
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4
 */
export async function evaluateTransformVariables(
  session: CDPSession,
  callFrameId: string,
  currentAddress: number,
  opcodeTransforms: Map<number, OpcodeTransform>,
  constants: ConstantEntry[],
  registers: RegisterMapping,
  bytecode: number[],
  previousTransform?: OpcodeTransform | null
): Promise<TransformEvaluationResult> {
  const result: TransformEvaluationResult = {
    hasTransforms: false,
  };

  // Get the opcode number at the current address
  const opcodeNumber = bytecode[currentAddress];
  if (opcodeNumber === undefined) {
    return result;
  }

  // Get the transform for this opcode
  const currentTransform = opcodeTransforms.get(opcodeNumber);

  // Evaluate current instruction's pre-expressions
  if (currentTransform && currentTransform.variables.length > 0) {
    result.current = await evaluateTransform(
      session,
      callFrameId,
      currentTransform,
      constants,
      registers
    );
    result.hasTransforms = true;
  }

  // Evaluate previous instruction's post-expressions
  if (previousTransform && previousTransform.postVariables.length > 0) {
    const postVariables = await evaluatePostVariables(
      session,
      callFrameId,
      previousTransform,
      constants,
      registers
    );

    result.previous = {
      opcodeNumber: previousTransform.opcodeNumber,
      opcodeName: previousTransform.opcodeName,
      postVariables,
    };
    result.hasTransforms = true;
  }

  return result;
}


// ==========================================
// Display Formatting Functions
// Requirements: 2.5, 2.6
// ==========================================

/**
 * Options for formatting evaluated variables
 */
export interface FormatVariableOptions {
  /** Indentation string (default: 3 spaces) */
  indent?: string;
  /** Whether to show the original expression (default: false) */
  showExpression?: boolean;
  /** Whether to show type information (default: true for complex types) */
  showType?: boolean;
  /** Whether to show the transformed expression (default: true) */
  showTransformed?: boolean;
}

/**
 * Format a single evaluated variable for display
 *
 * Requirements 3.1, 3.2, 3.3, 3.4:
 * - Show variable name and evaluated value
 * - Display transformed expression
 * - Show original expression as comment
 * - Indicate when transformation was applied
 *
 * @param variable - Evaluated variable to format
 * @param options - Formatting options
 * @returns Formatted string for display
 */
export function formatEvaluatedVariable(
  variable: EvaluatedVariable,
  options: FormatVariableOptions | string = '   '
): string {
  // Handle legacy string indent parameter
  const opts: FormatVariableOptions = typeof options === 'string'
    ? {indent: options}
    : options;

  const indent = opts.indent ?? '   ';
  const showExpression = opts.showExpression ?? true; // Default to true for enhanced display
  const showType = opts.showType ?? true;
  const showTransformed = opts.showTransformed ?? true;

  const {name, expression, transformedExpression, value, type, expandable, error, wasTransformed} = variable;

  // Build the display line
  // Requirements 3.1: Show variable name and evaluated value
  let line = `${indent}${name} = ${value}`;

  // Add type info for non-primitive types
  if (showType && type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'null' && type !== 'undefined') {
    line += ` (${type})`;
  }

  // Add expandable indicator for objects/arrays
  if (expandable) {
    line += ' [+]';
  }

  // Add error indicator
  if (error) {
    line += ` // Error: ${error}`;
  }

  // Requirements 3.2, 3.3, 3.4: Show transformed expression and original as comment
  if (showTransformed && showExpression && !error) {
    // Show transformed expression on a new line with arrow indicator
    if (wasTransformed) {
      // Requirements 3.3: Indicate when transformation was applied
      line += `\n${indent}   → ${transformedExpression}  // ${expression}`;
    } else if (expression !== transformedExpression) {
      // K[n] resolution happened but no AST transform
      line += `\n${indent}   → ${transformedExpression}  // ${expression}`;
    } else if (expression) {
      // No transformation, just show the expression
      line += `\n${indent}   → ${expression}`;
    }
  } else if (showExpression && expression && !error) {
    // Legacy format: show expression as inline comment
    const exprToShow = transformedExpression !== expression
      ? `${expression} → ${transformedExpression}`
      : expression;
    line += ` // ${exprToShow}`;
  }

  return line;
}

/**
 * Format the transform section for display
 *
 * Requirements 3.1, 3.2, 3.3, 3.4:
 * - Show variable name and evaluated value
 * - Display transformed expression
 * - Show original expression as comment
 * - Indicate when transformation was applied
 *
 * @param result - Transform evaluation result
 * @param indent - Base indentation (default: 3 spaces)
 * @returns Array of formatted lines
 */
export function formatTransformSection(
  result: TransformEvaluationResult,
  indent: string = '   '
): string[] {
  const lines: string[] = [];

  if (!result.hasTransforms) {
    return lines;
  }

  // Format current instruction's pre-expressions
  if (result.current && result.current.variables.length > 0) {
    lines.push(`${indent}📝 Current: ${result.current.opcodeName}`);
    for (const variable of result.current.variables) {
      lines.push(formatEvaluatedVariable(variable, {
        indent: indent + '   ',
        showExpression: true,
        showType: true,
        showTransformed: true,
      }));
    }
  }

  // Format previous instruction's post-expressions
  if (result.previous && result.previous.postVariables.length > 0) {
    if (lines.length > 0) {
      lines.push(''); // Add blank line separator
    }
    lines.push(`${indent}📝 Previous Instruction: ${result.previous.opcodeName}`);
    for (const variable of result.previous.postVariables) {
      lines.push(formatEvaluatedVariable(variable, {
        indent: indent + '   ',
        showExpression: true,
        showType: true,
        showTransformed: true,
      }));
    }
  }

  return lines;
}

/**
 * Format transform evaluation result as a complete section string
 *
 * @param result - Transform evaluation result
 * @returns Formatted section string or empty string if no transforms
 *
 * Requirements: 2.5
 */
export function formatTransformOutput(result: TransformEvaluationResult): string {
  if (!result.hasTransforms) {
    return '';
  }

  const lines = formatTransformSection(result);
  return lines.join('\n');
}

/**
 * Create a display-friendly summary of transform variables
 *
 * @param variables - Array of evaluated variables
 * @returns Summary string like "a=5, b=10, result=15"
 */
export function summarizeVariables(variables: EvaluatedVariable[]): string {
  if (variables.length === 0) {
    return '';
  }

  return variables
    .map(v => `${v.name}=${v.error ? '<error>' : v.value}`)
    .join(', ');
}

