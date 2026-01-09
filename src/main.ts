/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Main entry point for rc-devtools-mcp server.
 * Initializes the MCP server, browser connection, and tool registration.
 */

import './polyfill.js';

import process from 'node:process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

import type {Channel} from './core/browser.js';
import {ensureBrowserConnected, ensureBrowserLaunched} from './core/browser.js';
import {
  launchNativeChrome,
  isNativeChromeRunning,
  killNativeChrome,
  type NativeChromeInstance,
} from './core/browser-utils.js';
import {parseArguments} from './cli.js';
import {loadIssueDescriptions} from './issue-descriptions.js';
import {logger, saveLogsToFile} from './utils/logger.js';
import {McpContext} from './core/mcp-context.js';
import {McpResponse} from './core/mcp-response.js';
import {Mutex} from './utils/mutex.js';
import {
  McpServer,
  StdioServerTransport,
  type CallToolResult,
  SetLevelRequestSchema,
} from './third-party/index.js';
import {ToolCategory} from './tools/categories.js';
import type {ToolDefinition} from './tools/tool-definition.js';
import {tools} from './tools/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
const VERSION = packageJson.version;

export const args = parseArguments(VERSION);

const logFile = args.logFile ? saveLogsToFile(args.logFile) : undefined;

process.on('unhandledRejection', (reason, promise) => {
  logger('Unhandled promise rejection', promise, reason);
});

logger(`Starting ReverseCraft DevTools MCP Server v${VERSION}`);
const server = new McpServer(
  {
    name: 'rc_devtools',
    title: 'ReverseCraft DevTools MCP server',
    version: VERSION,
  },
  {capabilities: {logging: {}}},
);
server.server.setRequestHandler(SetLevelRequestSchema, () => {
  return {};
});

let context: McpContext;
let nativeChromeInstance: NativeChromeInstance | null = null;


/**
 * Launch native Chrome and connect via CDP.
 * This method reduces detection risk by avoiding automation flags.
 */
async function launchAndConnectNativeChrome(): Promise<ReturnType<typeof ensureBrowserConnected>> {
  const extraArgs: string[] = (args.chromeArg ?? []).map(String);
  if (args.disableMedia) {
    extraArgs.push('--blink-settings=imagesEnabled=false');
  }
  const devtools = args.experimentalDevtools ?? false;
  const cdpPort = 9222;

  // Check if Chrome is already running on the port
  const isRunning = await isNativeChromeRunning(cdpPort);

  if (!isRunning) {
    logger('Launching native Chrome with CDP (reduced detection mode)...');
    nativeChromeInstance = await launchNativeChrome({
      cdpPort,
      userDataDir: args.userDataDir,
      headless: args.headless,
      additionalArgs: extraArgs,
      devtools,
      proxyServer: args.proxyServer,
      noSandbox: args.noSandbox,
    });
    logger(`Native Chrome launched, CDP available at ${nativeChromeInstance.cdpUrl}`);
  } else {
    logger(`Chrome already running on port ${cdpPort}, connecting...`);
  }

  // Connect via CDP
  const browser = await ensureBrowserConnected({
    browserURL: `http://127.0.0.1:${cdpPort}`,
    devtools,
  });

  return browser;
}

/**
 * Get browser context with CDP-first connection mode.
 * Priority:
 * 1. Explicit browserUrl/wsEndpoint - use as provided
 * 2. cdpUrl with nativeLaunch - try to connect, then launch native Chrome if not running
 * 3. Fall back to Puppeteer launch if nativeLaunch is disabled
 */
async function getContext(): Promise<McpContext> {
  const extraArgs: string[] = (args.chromeArg ?? []).map(String);
  if (args.proxyServer) {
    extraArgs.push(`--proxy-server=${args.proxyServer}`);
  }
  if (args.disableMedia) {
    extraArgs.push('--blink-settings=imagesEnabled=false');
  }
  const devtools = args.experimentalDevtools ?? false;
  const useNativeLaunch = args.nativeLaunch !== false;

  const launchOptions = {
    headless: args.headless,
    executablePath: args.executablePath,
    channel: args.channel as Channel,
    isolated: args.isolated ?? false,
    userDataDir: args.userDataDir,
    logFile,
    viewport: args.viewport,
    args: extraArgs,
    acceptInsecureCerts: args.acceptInsecureCerts,
    devtools,
  };

  let browser;

  // Priority 1: Explicit browserUrl or wsEndpoint
  if (args.browserUrl || args.wsEndpoint || args.autoConnect) {
    browser = await ensureBrowserConnected({
      ...launchOptions,
      browserURL: args.browserUrl,
      wsEndpoint: args.wsEndpoint,
      wsHeaders: args.wsHeaders,
      // Important: only pass channel, if autoConnect is true.
      channel: args.autoConnect ? (args.channel as Channel) : undefined,
    });
  }
  // Priority 2: CDP mode with native Chrome launch (reduced detection)
  else if (useNativeLaunch && args.cdpUrl) {
    try {
      // First try to connect to existing Chrome
      logger(
        `Trying CDP connection to ${args.cdpUrl} (CDP-first mode for reduced detection)`,
      );
      browser = await ensureBrowserConnected({
        ...launchOptions,
        browserURL: args.cdpUrl,
      });
      logger('Successfully connected via CDP to existing Chrome');
    } catch (err) {
      logger(
        `CDP connection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      logger('Launching native Chrome with CDP...');
      // Launch native Chrome and connect
      browser = await launchAndConnectNativeChrome();
    }
  }
  // Priority 3: Native Chrome launch with CDP (default when nativeLaunch is enabled)
  else if (useNativeLaunch) {
    browser = await launchAndConnectNativeChrome();
  }
  // Priority 4: Fall back to Puppeteer launch (when nativeLaunch is disabled)
  else {
    logger('Native launch disabled, using Puppeteer launch...');
    browser = await ensureBrowserLaunched(launchOptions);
  }

  if (context?.browser !== browser) {
    context = await McpContext.from(browser, logger, {
      experimentalDevToolsDebugging: devtools,
      experimentalIncludeAllPages: args.experimentalIncludeAllPages,
      proxyAuth:
        args.proxyUsername && args.proxyPassword
          ? {
              username: args.proxyUsername,
              password: args.proxyPassword,
            }
          : undefined,
      launchOptions,
    });
  }
  return context;
}

// Cleanup on process exit
process.on('exit', () => {
  killNativeChrome();
});

process.on('SIGINT', () => {
  killNativeChrome();
  process.exit(0);
});

process.on('SIGTERM', () => {
  killNativeChrome();
  process.exit(0);
});

const logDisclaimers = () => {
  console.error(
    `rc-devtools-mcp exposes content of the browser instance to the MCP clients allowing them to inspect,
debug, and modify any data in the browser or DevTools.
Avoid sharing sensitive or personal information that you do not want to share with MCP clients.`,
  );
};

const toolMutex = new Mutex();

function registerTool(tool: ToolDefinition): void {
  // Skip if tool doesn't have required annotations (e.g., exported functions that aren't tools)
  if (!tool.annotations || !tool.annotations.category) {
    return;
  }
  if (
    tool.annotations.category === ToolCategory.EMULATION &&
    args.categoryEmulation === false
  ) {
    return;
  }
  if (
    tool.annotations.category === ToolCategory.NETWORK &&
    args.categoryNetwork === false
  ) {
    return;
  }
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.schema,
      annotations: tool.annotations,
    },
    async (params): Promise<CallToolResult> => {
      const guard = await toolMutex.acquire();
      try {
        logger(`${tool.name} request: ${JSON.stringify(params, null, '  ')}`);
        const context = await getContext();
        logger(`${tool.name} context: resolved`);
        await context.detectOpenDevToolsWindows();
        const response = new McpResponse();
        await tool.handler(
          {
            params,
          },
          response,
          context,
        );
        const content = await response.handle(tool.name, context);
        return {
          content,
        };
      } catch (err) {
        logger(`${tool.name} error:`, err, err?.stack);
        let errorText = err && 'message' in err ? err.message : String(err);
        if ('cause' in err && err.cause) {
          errorText += `\nCause: ${err.cause.message}`;
        }
        return {
          content: [
            {
              type: 'text',
              text: errorText,
            },
          ],
          isError: true,
        };
      } finally {
        guard.dispose();
      }
    },
  );
}

for (const tool of tools) {
  registerTool(tool);
}

await loadIssueDescriptions();
const transport = new StdioServerTransport();
await server.connect(transport);
logger('ReverseCraft DevTools MCP Server connected');
logDisclaimers();
