/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

// Logger utilities
export {logger, saveLogsToFile} from './logger.js';

// Mutex for synchronization
export {Mutex} from './mutex.js';

// Wait for helper
export {WaitForHelper} from './wait-for-helper.js';

// DevTools utilities
export {
  extractUrlLikeFromDevToolsTitle,
  urlsEqual,
  FakeIssuesManager,
  mapIssueToMessageObject,
  UniverseManager,
  type TargetUniverse,
  type TargetUniverseFactoryFn,
} from './devtools-utils.js';

// Configuration
export {getConfig, type McpConfig, type DebuggerConfig} from './config.js';

// Types
export {type PaginationOptions} from './types.js';

// CDP utilities
export {
  getCdpSession,
  disposeCdpSession,
  hasCdpSession,
  formatStackTrace,
  formatInitiator,
  enableNetworkInitiatorTracking,
  getNetworkInitiator,
  clearNetworkInitiators,
  isNetworkTrackingEnabled,
  type InitiatorType,
  type CallFrameInfo,
  type StackTraceInfo,
  type NetworkInitiator,
} from './cdp.js';

// Pagination
export {paginate, type PaginationResult} from './pagination.js';

// Keyboard utilities
export {parseKey} from './keyboard.js';

// Debugger utilities
export {
  getDebuggerState,
  getActiveBreakpoints,
  trackBreakpoint,
  untrackBreakpoint,
  getBreakpointCount,
  clearTrackedBreakpoints,
  restoreBreakpointsAfterNavigation,
  initializeDebuggerForPage,
  getBreakpointSummary,
  trackXhrBreakpoint,
  untrackXhrBreakpoint,
  getTrackedXhrBreakpoints,
  clearTrackedXhrBreakpoints,
  type BreakpointInfo,
  type CdpBreakpointLocation,
  type CallFrame,
  type ScopeInfo,
  type DebuggerState,
  type ActiveBreakpointInfo,
} from './debugger-utils.js';

// Analysis types
export {
  type FunctionType,
  type FunctionInfo,
  type CallInfo,
  type ParseError,
  type ParseResult,
  type CallGraph,
  type TraceResult,
  type CallGraphResult,
  type SearchMatch,
  type SearchResult,
} from './analysis-types.js';

// Call graph analyzer
export {
  buildCallGraph,
  getUpstreamTrace,
  getDownstreamTrace,
  findSimilarFunctions,
  analyzeFunction,
} from './call-graph-analyzer.js';

// Context code utilities
export {
  isMinified,
  extractContextCode,
  formatContextCodeOutput,
  formatPositionAnnotation,
  buildLineOffsets,
  lineColumnToIndex,
  type ContextCodeOptions,
  type OptimizedContextOptions,
  type ContextCodeResult,
  type FormattedLine,
  type PositionAnnotation,
  type PositionMapping,
  type FormatResult,
} from './context-code-utils.js';

// Smart breakpoint utilities
export {
  findNearestBreakpointLocation,
  queryPossibleBreakpoints,
  getScriptCache,
  cacheScript,
  clearScriptCache,
  findMatchingScripts,
  getScriptSource,
  getAllScriptsWithSource,
  type BreakpointLocation,
  type ScriptInfo,
} from './smart-breakpoint-utils.js';

// Persistent scripts
export {
  addScript,
  removeScript,
  listScripts,
  clearScripts,
  truncateSource,
  type PersistentScriptEntry,
} from './persistent-scripts.js';

// Smart navigator
export {
  smartNavigate,
  SmartNavigator,
  type SmartNavigationResult,
  type SmartNavigationOptions,
} from './smart-navigator.js';

// Script cache manager
export {ScriptCacheManager} from './script-cache-manager.js';

// Script cache registry
export {ScriptCacheRegistry} from './script-cache-registry.js';

// Script parser
export {parseScript} from './script-parser.js';

// IR Debugger types
export {
  ErrorCodes,
  type ErrorCode,
  type IRSessionConfig,
  type IRSessionInfo,
  type VMRegisterInfo,
  type VMRegisters,
  type VMDispatcher,
  type VMEntryPoint,
  type VMInfo,
  type IRFunctionInfo,
  type WatchExpression,
  type BreakpointConfig,
  type SourceLocation,
  type IRMapping,
  type ParsedSourceMap,
  type IRBreakpointInfo,
  type IRState,
  type IRCodeLine,
  type IRCodeContext,
  type IRDebuggerError,
  type SourceMapFile,
} from './ir-debugger-types.js';

// IR Session Manager
export {
  IRSession,
  createSession,
  getSession,
  listSessions,
  removeSession,
  clearAllSessions,
  getSessionCount,
  deriveAsmPath,
  type CreateSessionResult,
  type GetSessionResult,
  type RemoveSessionResult,
} from './ir-session-manager.js';

// IR Source Map Parser
export {
  parseSourceMap,
  getMappingByLine,
  getMappingByAddr,
  getMappingsByOpcode,
  getFunction,
  getFunctionByLine,
  getFunctionByAddr,
  type ParseResult as IRParseResult,
} from './ir-source-map-parser.js';

// IR Condition Builder
export {
  fromMapping,
  combine,
  buildStackCondition,
  buildScopeCondition,
  combineWithMapping,
} from './ir-condition-builder.js';

// IR State Extractor
export {
  extractState,
  formatState,
  truncateValue,
  extractAndFormatState,
  type ExtractStateResult,
  type ExtractStateOptions,
  type FormatStateOptions,
} from './ir-state-extractor.js';
