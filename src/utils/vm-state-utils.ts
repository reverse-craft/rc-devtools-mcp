/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * VM State Utilities - Value formatting helpers for VM state display
 *
 * Provides formatting functions for displaying VM state values in a
 * consistent, readable format matching VSCode-like debugging output.
 *
 * Requirements: 1.5, 5.3
 */

/**
 * Format a numeric value as both hexadecimal and decimal.
 * Used for address formatting in VM state display.
 *
 * @param value - The numeric value to format
 * @returns Formatted string like "0x2d2e (11566)"
 *
 * Requirements: 1.2, 1.5
 */
export function formatHexDecimal(value: number): string {
  if (!Number.isFinite(value)) {
    return 'N/A';
  }
  const hex = `0x${value.toString(16).padStart(4, '0')}`;
  return `${hex} (${value})`;
}

/**
 * Truncate a string to a maximum length, adding "..." if truncated.
 *
 * @param str - The string to truncate
 * @param maxLength - Maximum length (default: 100)
 * @returns Truncated string with "..." suffix if needed
 *
 * Requirements: 5.3
 */
export function truncateString(str: string, maxLength: number = 100): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength) + '...';
}

/**
 * Format a value for display with type information and truncation.
 * Handles various JavaScript types including primitives, arrays, and objects.
 *
 * @param value - The value to format
 * @param maxLength - Maximum string length before truncation (default: 100)
 * @returns Formatted string representation of the value
 *
 * Requirements: 1.3, 1.5, 5.3
 */
export function formatValue(value: unknown, maxLength: number = 100): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }

  const type = typeof value;

  if (type === 'string') {
    const str = JSON.stringify(value);
    return truncateString(str, maxLength);
  }

  if (type === 'number') {
    return String(value);
  }

  if (type === 'boolean') {
    return String(value);
  }

  if (type === 'function') {
    return '[Function]';
  }

  if (type === 'symbol') {
    return value.toString();
  }

  if (type === 'bigint') {
    return `${value}n`;
  }

  if (Array.isArray(value)) {
    const preview = formatArrayPreview(value, maxLength);
    return preview;
  }

  if (type === 'object') {
    const preview = formatObjectPreview(value as object, maxLength);
    return preview;
  }

  // Fallback for any other type
  try {
    const str = String(value);
    return truncateString(str, maxLength);
  } catch {
    return '[Unknown]';
  }
}

/**
 * Format an array for preview display.
 * Shows array length and a preview of elements.
 *
 * @param arr - The array to format
 * @param maxLength - Maximum string length
 * @returns Formatted array preview like "Array(5) [1, 2, 3, ...]"
 */
function formatArrayPreview(arr: unknown[], maxLength: number): string {
  const length = arr.length;
  const prefix = `Array(${length})`;

  if (length === 0) {
    return `${prefix} []`;
  }

  // Build preview of first few elements
  const previewElements: string[] = [];
  let currentLength = prefix.length + 3; // " [" + "]"

  for (let i = 0; i < arr.length && i < 5; i++) {
    const elemStr = formatValueShort(arr[i]);
    const separator = i > 0 ? ', ' : '';
    const newLength = currentLength + separator.length + elemStr.length;

    if (newLength > maxLength - 4) {
      // Leave room for "..."
      previewElements.push('...');
      break;
    }

    previewElements.push(elemStr);
    currentLength = newLength;
  }

  if (arr.length > 5 && !previewElements.includes('...')) {
    previewElements.push('...');
  }

  return `${prefix} [${previewElements.join(', ')}]`;
}

/**
 * Format an object for preview display.
 * Shows object type and a preview of properties.
 *
 * @param obj - The object to format
 * @param maxLength - Maximum string length
 * @returns Formatted object preview like "Object {a: 1, b: 2, ...}"
 */
function formatObjectPreview(obj: object, maxLength: number): string {
  // Handle special object types
  if (obj instanceof Date) {
    return `Date(${obj.toISOString()})`;
  }

  if (obj instanceof RegExp) {
    return obj.toString();
  }

  if (obj instanceof Error) {
    return `${obj.name}: ${truncateString(obj.message, maxLength - obj.name.length - 2)}`;
  }

  // Get constructor name for type info
  const constructorName = obj.constructor?.name || 'Object';
  const prefix = constructorName === 'Object' ? '' : `${constructorName} `;

  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return `${prefix}{}`;
  }

  // Build preview of first few properties
  const previewProps: string[] = [];
  let currentLength = prefix.length + 2; // "{" + "}"

  for (let i = 0; i < keys.length && i < 3; i++) {
    const key = keys[i];
    const value = (obj as Record<string, unknown>)[key];
    const valueStr = formatValueShort(value);
    const propStr = `${key}: ${valueStr}`;
    const separator = i > 0 ? ', ' : '';
    const newLength = currentLength + separator.length + propStr.length;

    if (newLength > maxLength - 4) {
      // Leave room for "..."
      previewProps.push('...');
      break;
    }

    previewProps.push(propStr);
    currentLength = newLength;
  }

  if (keys.length > 3 && !previewProps.includes('...')) {
    previewProps.push('...');
  }

  return `${prefix}{${previewProps.join(', ')}}`;
}

/**
 * Format a value in short form for use in previews.
 * Used internally for array/object element previews.
 *
 * @param value - The value to format
 * @returns Short string representation
 */
function formatValueShort(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';

  const type = typeof value;

  if (type === 'string') {
    const str = value as string;
    if (str.length > 20) {
      return JSON.stringify(str.substring(0, 17) + '...');
    }
    return JSON.stringify(str);
  }

  if (type === 'number' || type === 'boolean') {
    return String(value);
  }

  if (type === 'function') {
    return '[Function]';
  }

  if (Array.isArray(value)) {
    return `Array(${value.length})`;
  }

  if (type === 'object') {
    const constructorName = (value as object).constructor?.name || 'Object';
    return `${constructorName}`;
  }

  return String(value);
}

/**
 * Determine if a value is expandable (array or object with properties).
 * Used to indicate whether a value can be expanded in the debugger UI.
 *
 * @param value - The value to check
 * @returns true if the value is expandable
 */
export function isExpandable(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  const type = typeof value;

  if (type !== 'object') {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return Object.keys(value as object).length > 0;
}

/**
 * Get the type name of a value for display.
 *
 * @param value - The value to get type for
 * @returns Type name string
 */
export function getTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  const type = typeof value;

  if (type !== 'object') {
    return type;
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  return (value as object).constructor?.name || 'object';
}
