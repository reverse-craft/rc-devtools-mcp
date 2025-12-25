/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

// Re-export types from devtools.d.ts
// Note: The devtools.d.ts file contains ambient module declarations
// that are automatically included by TypeScript

// Export common types used across the project
export type {PaginationOptions} from '../utils/types.js';

// Export analysis types
export type {
  FunctionType,
  FunctionInfo,
  CallInfo,
  ParseError,
  ParseResult,
  CallGraph,
  TraceResult,
  CallGraphResult,
  SearchMatch,
  SearchResult,
} from '../utils/analysis-types.js';

// Export debugger types
export type {
  BreakpointInfo,
  CdpBreakpointLocation,
  CallFrame,
  ScopeInfo,
  DebuggerState,
  ActiveBreakpointInfo,
} from '../utils/debugger-utils.js';

// Export CDP types
export type {
  InitiatorType,
  CallFrameInfo,
  StackTraceInfo,
  NetworkInitiator,
} from '../utils/cdp.js';

// Export context code types
export type {
  ContextCodeOptions,
  OptimizedContextOptions,
  ContextCodeResult,
  FormattedLine,
  PositionAnnotation,
  PositionMapping,
  FormatResult,
} from '../utils/context-code-utils.js';

// Export smart breakpoint types
export type {
  BreakpointLocation,
  ScriptInfo,
} from '../utils/smart-breakpoint-utils.js';

// Export navigation types
export type {
  SmartNavigationResult,
  SmartNavigationOptions,
} from '../utils/smart-navigator.js';

// Export persistent script types
export type {
  PersistentScriptEntry,
} from '../utils/persistent-scripts.js';

// Export config types
export type {
  McpConfig,
  DebuggerConfig,
} from '../utils/config.js';

// Export pagination types
export type {
  PaginationResult,
} from '../utils/pagination.js';
