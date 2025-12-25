/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Core module exports for rc-devtools-mcp.
 * Provides browser management, MCP context, and response handling.
 */

// Browser management
export {
  BrowserManager,
  createDefaultBrowserManager,
  createCdpBrowserManager,
  createExecutableBrowserManager,
  checkBrowserStatus,
  listBrowserContexts,
  type BrowserManagerOptions,
  type BrowserContextInfo,
} from './browser-manager.js';

// Browser utilities
export {
  getUserAgent,
  getVersion,
  BrowserStatusManager,
  browserStatusManager,
  getSelfCdpUrl,
  getCdpTargets,
  expandPath,
  expandCommandPath,
  getChromeExecutablePath,
  getRandomViewport,
  randomDelay,
  getTypingDelay,
  getDefaultPersistentContextDir,
  createTempPersistentContextDir,
  cleanupPersistentContextDir,
  getDefaultBrowserArgs,
  getHeadlessBrowserArgs,
  getDevToolsArgs,
  getNoSandboxArgs,
  buildBrowserArgs,
  writeSnapshotToFile,
  cleanupOldLogFiles,
  isSnapshotTooLarge,
  getTempLogDir,
  launchNativeChrome,
  isNativeChromeRunning,
  killNativeChrome,
  getNativeChromeProcess,
  type BrowserStatus,
  type CdpTarget,
  type BuildBrowserArgsOptions,
  type BrowserConfig,
  type SnapshotFileInfo,
  type NativeChromeOptions,
  type NativeChromeInstance,
} from './browser-utils.js';

// Browser connection
export {
  ensureBrowserConnected,
  ensureBrowserLaunched,
  launch,
  type McpLaunchOptions,
  type Channel,
} from './browser.js';

// MCP Context
export {
  McpContext,
  type TextSnapshotNode,
  type GeolocationOptions,
  type TextSnapshot,
} from './mcp-context.js';

// MCP Response
export {McpResponse} from './mcp-response.js';

// Page collectors
export {
  PageCollector,
  ConsoleCollector,
  NetworkCollector,
  stableIdSymbol,
  type ListenerMap,
} from './page-collector.js';

// DevTools connection adapter
export {PuppeteerDevToolsConnection} from './devtools-connection-adapter.js';
