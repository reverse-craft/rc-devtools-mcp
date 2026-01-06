/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scope Fetcher - Fetches and formats JavaScript scope variables
 *
 * Provides functionality to fetch local, closure, and global scope variables
 * using CDP Runtime.getProperties for scope objects.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */

import type {CDPSession} from '../third-party/index.js';
import type {ScopeInfo} from './debugger-utils.js';
import {formatValue, isExpandable, getTypeName} from './vm-state-utils.js';

/**
 * Maximum number of variables to fetch per scope
 * Requirement: Limit variables per scope (max 50)
 */
export const MAX_VARIABLES_PER_SCOPE = 50;

/**
 * Represents a single scope variable
 * Requirements: 4.2, 4.3
 */
export interface ScopeVariable {
  /** Variable name */
  name: string;
  /** Formatted value for display */
  value: string;
  /** Type of the value */
  type: string;
  /** Whether the value is expandable (object/array with properties) */
  expandable: boolean;
}

/**
 * Represents all scope data for a call frame
 * Requirements: 4.1
 */
export interface ScopeData {
  /** Local scope variables */
  local: ScopeVariable[];
  /** Closure scope variables */
  closure: ScopeVariable[];
  /** Global scope variables */
  global: ScopeVariable[];
}

/**
 * Result of fetching scope variables
 */
export interface FetchScopeResult {
  /** Fetched variables */
  variables: ScopeVariable[];
  /** Whether the result was truncated due to max limit */
  truncated: boolean;
  /** Total count before truncation */
  totalCount: number;
  /** Error message if fetch failed */
  error?: string;
}


/**
 * Fetch variables from a single scope object using CDP Runtime.getProperties
 *
 * @param session - CDP session
 * @param objectId - Object ID of the scope object
 * @param maxVariables - Maximum number of variables to fetch (default: 50)
 * @returns Fetch result with variables and metadata
 *
 * Requirements: 4.1, 4.2
 */
async function fetchScopeObject(
  session: CDPSession,
  objectId: string,
  maxVariables: number = MAX_VARIABLES_PER_SCOPE
): Promise<FetchScopeResult> {
  try {
    const result = await session.send('Runtime.getProperties', {
      objectId,
      ownProperties: true,
      generatePreview: true,
    });

    const properties = (result as any).result || [];
    const totalCount = properties.length;
    const truncated = totalCount > maxVariables;

    // Limit to max variables
    const limitedProperties = properties.slice(0, maxVariables);

    const variables: ScopeVariable[] = limitedProperties
      .filter((prop: any) => {
        // Filter out internal properties
        if (prop.name.startsWith('__')) return false;
        // Filter out getter/setter only properties without value
        if (!prop.value && !prop.get) return false;
        return true;
      })
      .map((prop: any) => {
        const value = prop.value;
        return {
          name: prop.name,
          value: formatCDPValue(value),
          type: getCDPValueType(value),
          expandable: isCDPValueExpandable(value),
        };
      });

    return {
      variables,
      truncated,
      totalCount,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      variables: [],
      truncated: false,
      totalCount: 0,
      error: errorMessage,
    };
  }
}

/**
 * Format a CDP RemoteObject value for display
 *
 * @param value - CDP RemoteObject
 * @returns Formatted string representation
 */
function formatCDPValue(value: any): string {
  if (!value) {
    return 'undefined';
  }

  const {type, subtype, value: primitiveValue, description, preview} = value;

  // Handle primitives
  if (type === 'undefined') {
    return 'undefined';
  }

  if (type === 'string') {
    return formatValue(primitiveValue);
  }

  if (type === 'number') {
    return String(primitiveValue);
  }

  if (type === 'boolean') {
    return String(primitiveValue);
  }

  if (subtype === 'null') {
    return 'null';
  }

  // Handle functions
  if (type === 'function') {
    if (description) {
      // Extract just the function signature
      const match = description.match(/^function\s*([^{]+)/);
      if (match) {
        return `ƒ ${match[1].trim()}`;
      }
      return 'ƒ ()';
    }
    return '[Function]';
  }

  // Handle arrays
  if (subtype === 'array') {
    if (preview) {
      return formatArrayPreview(preview);
    }
    if (description) {
      return description;
    }
    return 'Array';
  }

  // Handle objects
  if (type === 'object') {
    if (preview) {
      return formatObjectPreview(preview);
    }
    if (description) {
      return description;
    }
    return 'Object';
  }

  // Handle symbols
  if (type === 'symbol') {
    return description || 'Symbol()';
  }

  // Handle bigint
  if (type === 'bigint') {
    return `${primitiveValue}n`;
  }

  // Fallback
  return description || String(primitiveValue) || '[Unknown]';
}

/**
 * Format a CDP preview for arrays
 */
function formatArrayPreview(preview: any): string {
  const {properties, overflow} = preview;
  const length = preview.description?.match(/\((\d+)\)/)?.[1] || properties?.length || 0;

  if (!properties || properties.length === 0) {
    return `Array(${length}) []`;
  }

  const elements = properties
    .slice(0, 5)
    .map((p: any) => formatPreviewValue(p.value, p.type, p.subtype))
    .join(', ');

  const suffix = overflow || properties.length > 5 ? ', ...' : '';
  return `Array(${length}) [${elements}${suffix}]`;
}

/**
 * Format a CDP preview for objects
 */
function formatObjectPreview(preview: any): string {
  const {properties, overflow, subtype, description} = preview;

  // Handle special object types
  if (subtype === 'date') {
    return description || 'Date';
  }

  if (subtype === 'regexp') {
    return description || 'RegExp';
  }

  if (subtype === 'error') {
    return description || 'Error';
  }

  if (subtype === 'map') {
    return description || 'Map';
  }

  if (subtype === 'set') {
    return description || 'Set';
  }

  if (!properties || properties.length === 0) {
    return description || '{}';
  }

  const props = properties
    .slice(0, 3)
    .map((p: any) => `${p.name}: ${formatPreviewValue(p.value, p.type, p.subtype)}`)
    .join(', ');

  const suffix = overflow || properties.length > 3 ? ', ...' : '';
  const prefix = description && description !== 'Object' ? `${description} ` : '';
  return `${prefix}{${props}${suffix}}`;
}

/**
 * Format a preview value (used in array/object previews)
 */
function formatPreviewValue(value: any, type: string, subtype?: string): string {
  if (type === 'undefined') return 'undefined';
  if (subtype === 'null') return 'null';
  if (type === 'string') return JSON.stringify(value);
  if (type === 'number' || type === 'boolean') return String(value);
  if (type === 'function') return 'ƒ';
  if (subtype === 'array') return 'Array';
  if (type === 'object') return '{...}';
  if (type === 'symbol') return 'Symbol';
  return String(value);
}

/**
 * Get the type name from a CDP RemoteObject
 */
function getCDPValueType(value: any): string {
  if (!value) return 'undefined';

  const {type, subtype} = value;

  if (subtype === 'null') return 'null';
  if (subtype === 'array') return 'array';
  if (subtype) return subtype;
  return type || 'unknown';
}

/**
 * Check if a CDP RemoteObject is expandable
 */
function isCDPValueExpandable(value: any): boolean {
  if (!value) return false;

  const {type, subtype, objectId} = value;

  // Must have an objectId to be expandable
  if (!objectId) return false;

  // Functions are not expandable in our context
  if (type === 'function') return false;

  // Objects and arrays are expandable
  if (type === 'object') return true;

  return false;
}


/**
 * Fetch variables from all scopes in a call frame
 *
 * This is the main entry point for scope fetching. It:
 * 1. Fetches local, closure, and global scope variables
 * 2. Uses Runtime.getProperties for scope objects
 * 3. Limits variables per scope (max 50)
 *
 * @param session - CDP session
 * @param scopeChain - Scope chain from the call frame
 * @param maxVariables - Maximum variables per scope (default: 50)
 * @returns Scope data with local, closure, and global variables
 *
 * Requirements: 4.1, 4.2
 */
export async function fetchScopeVariables(
  session: CDPSession,
  scopeChain: ScopeInfo[],
  maxVariables: number = MAX_VARIABLES_PER_SCOPE
): Promise<ScopeData> {
  const result: ScopeData = {
    local: [],
    closure: [],
    global: [],
  };

  for (const scope of scopeChain) {
    const objectId = scope.object?.objectId;
    if (!objectId) continue;

    const scopeType = scope.type.toLowerCase();

    // Map CDP scope types to our scope categories
    if (scopeType === 'local') {
      const fetchResult = await fetchScopeObject(session, objectId, maxVariables);
      if (!fetchResult.error) {
        result.local = fetchResult.variables;
      }
    } else if (scopeType === 'closure') {
      const fetchResult = await fetchScopeObject(session, objectId, maxVariables);
      if (!fetchResult.error) {
        result.closure = fetchResult.variables;
      }
    } else if (scopeType === 'global') {
      // For global scope, we limit more aggressively since it's usually huge
      const fetchResult = await fetchScopeObject(session, objectId, Math.min(maxVariables, 20));
      if (!fetchResult.error) {
        result.global = fetchResult.variables;
      }
    }
    // Skip other scope types (block, with, catch, etc.)
  }

  return result;
}

// ==========================================
// Display Formatting Functions
// Requirements: 4.3, 4.4
// ==========================================

/**
 * Options for formatting scope variables
 */
export interface FormatScopeOptions {
  /** Indentation string (default: 3 spaces) */
  indent?: string;
  /** Maximum value length before truncation (default: 80) */
  maxValueLength?: number;
  /** Whether to show type information (default: true for complex types) */
  showType?: boolean;
}

/**
 * Format a single scope variable for display
 *
 * @param variable - Scope variable to format
 * @param options - Formatting options
 * @returns Formatted string for display
 *
 * Requirements: 4.3
 */
export function formatScopeVariable(
  variable: ScopeVariable,
  options: FormatScopeOptions = {}
): string {
  const indent = options.indent ?? '   ';
  const showType = options.showType ?? true;
  const maxValueLength = options.maxValueLength ?? 80;

  const {name, value, type, expandable} = variable;

  // Truncate long values
  let displayValue = value;
  if (displayValue.length > maxValueLength) {
    displayValue = displayValue.substring(0, maxValueLength) + '...';
  }

  // Build the display line
  let line = `${indent}${name} = ${displayValue}`;

  // Add type info for non-primitive types
  if (showType && type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'null' && type !== 'undefined') {
    line += ` (${type})`;
  }

  // Add expandable indicator for objects/arrays
  if (expandable) {
    line += ' [+]';
  }

  return line;
}

/**
 * Format a scope section for display
 *
 * @param scopeName - Name of the scope (e.g., "Local", "Closure", "Global")
 * @param variables - Array of scope variables
 * @param options - Formatting options
 * @returns Array of formatted lines
 *
 * Requirements: 4.3, 4.4
 */
export function formatScopeSection(
  scopeName: string,
  variables: ScopeVariable[],
  options: FormatScopeOptions = {}
): string[] {
  const lines: string[] = [];
  const indent = options.indent ?? '   ';

  if (variables.length === 0) {
    // Requirement 4.4: Handle unavailable scopes gracefully
    return [];
  }

  // Add section header with emoji
  const emoji = getScopeEmoji(scopeName);
  lines.push(`${emoji} **${scopeName} Scope:**`);

  // Add variables
  for (const variable of variables) {
    lines.push(formatScopeVariable(variable, options));
  }

  return lines;
}

/**
 * Get emoji for a scope type
 */
function getScopeEmoji(scopeName: string): string {
  switch (scopeName.toLowerCase()) {
    case 'local':
      return '📍';
    case 'closure':
      return '🔗';
    case 'global':
      return '🌐';
    default:
      return '📦';
  }
}

/**
 * Format all scopes for display
 *
 * @param scopeData - Scope data with local, closure, and global variables
 * @param options - Formatting options
 * @returns Array of formatted lines for all scopes
 *
 * Requirements: 4.1, 4.3, 4.4
 */
export function formatAllScopes(
  scopeData: ScopeData,
  options: FormatScopeOptions = {}
): string[] {
  const lines: string[] = [];

  // Format local scope
  const localLines = formatScopeSection('Local', scopeData.local, options);
  if (localLines.length > 0) {
    lines.push(...localLines);
    lines.push('');
  }

  // Format closure scope
  const closureLines = formatScopeSection('Closure', scopeData.closure, options);
  if (closureLines.length > 0) {
    lines.push(...closureLines);
    lines.push('');
  }

  // Format global scope
  const globalLines = formatScopeSection('Global', scopeData.global, options);
  if (globalLines.length > 0) {
    lines.push(...globalLines);
  }

  return lines;
}

/**
 * Check if scope data has any variables
 *
 * @param scopeData - Scope data to check
 * @returns true if any scope has variables
 */
export function hasScopeVariables(scopeData: ScopeData): boolean {
  return (
    scopeData.local.length > 0 ||
    scopeData.closure.length > 0 ||
    scopeData.global.length > 0
  );
}

