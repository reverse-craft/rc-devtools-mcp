/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IR Condition Builder
 * Builds and combines condition expressions for IR breakpoints.
 */

import type { IRMapping, VMRegisters } from './ir-debugger-types.js';

/**
 * Gets the base condition from an IR mapping.
 * @param mapping The IR mapping containing breakpoint configuration
 * @returns The condition string from the mapping, or empty string if none
 */
export function fromMapping(mapping: IRMapping): string {
  return mapping.breakpoint.condition || '';
}

/**
 * Combines multiple condition expressions with AND logic.
 * Filters out empty conditions and joins non-empty ones with " && ".
 * @param conditions Array of condition expressions to combine
 * @returns Combined condition string, or empty string if no valid conditions
 */
export function combine(conditions: string[]): string {
  const validConditions = conditions.filter((c) => c && c.trim() !== '');
  if (validConditions.length === 0) {
    return '';
  }
  if (validConditions.length === 1) {
    return validConditions[0];
  }
  // Wrap each condition in parentheses to ensure correct precedence
  return validConditions.map((c) => `(${c})`).join(' && ');
}

/**
 * Builds a condition expression for checking a stack value.
 * @param registers VM register definitions
 * @param stackIndex Index into the stack (0 = top of stack)
 * @param operator Comparison operator (e.g., "===", "!==", ">", "<")
 * @param value Value to compare against (will be used as-is in the expression)
 * @returns Condition expression string
 */
export function buildStackCondition(
  registers: VMRegisters,
  stackIndex: number,
  operator: string,
  value: string
): string {
  const stackName = registers.stack.name;
  const spName = registers.sp.name;
  // Stack access: stack[sp - 1 - stackIndex] for stackIndex 0 = top
  // sp points to the next free slot, so sp-1 is the top of stack
  return `${stackName}[${spName} - 1 - ${stackIndex}] ${operator} ${value}`;
}

/**
 * Builds a condition expression for checking a scope variable value.
 * @param registers VM register definitions
 * @param scopeDepth Depth in the scope chain (0 = current scope)
 * @param propertyName Name of the property to check in the scope
 * @param operator Comparison operator (e.g., "===", "!==", ">", "<")
 * @param value Value to compare against (will be used as-is in the expression)
 * @returns Condition expression string
 */
export function buildScopeCondition(
  registers: VMRegisters,
  scopeDepth: number,
  propertyName: string,
  operator: string,
  value: string
): string {
  const scopeName = registers.scope.name;
  // Scope access: scope[scopeDepth].propertyName or scope[scopeDepth]["propertyName"]
  // Use bracket notation for safety with special characters
  return `${scopeName}[${scopeDepth}]["${propertyName}"] ${operator} ${value}`;
}

/**
 * Combines a base condition from a mapping with additional user-provided conditions.
 * @param mapping The IR mapping containing the base breakpoint condition
 * @param additionalConditions Array of additional condition expressions
 * @returns Combined condition string
 */
export function combineWithMapping(
  mapping: IRMapping,
  additionalConditions: string[]
): string {
  const baseCondition = fromMapping(mapping);
  return combine([baseCondition, ...additionalConditions]);
}
