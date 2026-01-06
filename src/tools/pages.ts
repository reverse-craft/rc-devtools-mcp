/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Page navigation tools for rc-devtools-mcp.
 * Provides page management, navigation, and cookie handling capabilities.
 */

import {zod} from '../third-party/index.js';
import {
  getDebuggerState,
  initializeDebuggerForPage,
} from '../utils/debugger-utils.js';
import {SmartNavigator} from '../utils/smart-navigator.js';

import {ToolCategory} from './categories.js';
import {defineTool, timeoutSchema} from './tool-definition.js';

export const listPages = defineTool({
  name: 'list_pages',
  description: `Get a list of pages open in the browser.`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (_request, response) => {
    response.setIncludePages(true);
  },
});

export const selectPage = defineTool({
  name: 'select_page',
  description: `Select a page as a context for future tool calls.`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: true,
  },
  schema: {
    pageIdx: zod
      .number()
      .describe(
        `The index of the page to select. Call ${listPages.name} to get available pages.`,
      ),
    bringToFront: zod
      .boolean()
      .optional()
      .describe('Whether to focus the page and bring it to the top.'),
  },
  handler: async (request, response, context) => {
    const page = context.getPageByIdx(request.params.pageIdx);
    context.selectPage(page);
    response.setIncludePages(true);
    if (request.params.bringToFront) {
      await page.bringToFront();
    }
  },
});


export const newPage = defineTool({
  name: 'new_page',
  description: `Creates a new page`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    url: zod.string().describe('URL to load in a new page.'),
    incognito: zod
      .boolean()
      .optional()
      .describe('Whether to open the page in a new incognito window.'),
    newWindow: zod
      .boolean()
      .optional()
      .describe('Whether to open the page in a new window.'),
    userDataDir: zod
      .string()
      .optional()
      .describe(
        'Optional independent resource directory (user data directory). If provided, a new browser instance with its own window will be started.',
      ),
    enableDebugger: zod
      .boolean()
      .optional()
      .describe(
        'Whether to enable the JavaScript debugger for the new page. Default is true.',
      ),
    ...timeoutSchema,
  },
  handler: async (request, response, context) => {
    const page = await context.newPage({
      incognito: request.params.incognito,
      newWindow: request.params.newWindow,
      userDataDir: request.params.userDataDir,
      enableDebugger: request.params.enableDebugger,
    });

    // Use SmartNavigator for debugger-aware navigation
    const navigator = new SmartNavigator(page);
    let result: Awaited<ReturnType<typeof navigator.navigateToUrl>>;
    
    await context.waitForEventsAfterAction(async () => {
      result = await navigator.navigateToUrl(request.params.url, {
        timeout: request.params.timeout,
        debuggerEnabled: request.params.enableDebugger !== false,
      });
    });

    // Format response based on navigation result
    switch (result!.status) {
      case 'loaded':
        response.appendResponseLine(
          `Successfully created new page and navigated to ${result!.url ?? request.params.url}.`,
        );
        break;
      case 'paused':
        response.appendResponseLine(
          `Created new page and navigated to ${request.params.url}. Debugger is paused.`,
        );
        if (result!.callFrames && result!.callFrames.length > 0) {
          const topFrame = result!.callFrames[0];
          response.appendResponseLine(
            `Paused at: ${topFrame.functionName || '(anonymous)'} (${topFrame.url}:${topFrame.location.lineNumber + 1})`,
          );
        }
        break;
      case 'timeout':
        response.appendResponseLine(
          `Created new page but navigation to ${request.params.url} timed out: ${result!.error}`,
        );
        break;
      case 'error':
        response.appendResponseLine(
          `Created new page but unable to navigate to ${request.params.url}: ${result!.error}`,
        );
        break;
    }

    response.setIncludePages(true);
  },
});


export const navigatePage = defineTool({
  name: 'navigate_page',
  description: `Navigates the currently selected page to a URL.`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    type: zod
      .enum(['url', 'back', 'forward', 'reload'])
      .optional()
      .describe(
        'Navigate the page by URL, back or forward in history, or reload.',
      ),
    url: zod.string().optional().describe('Target URL (only type=url)'),
    ignoreCache: zod
      .boolean()
      .optional()
      .describe('Whether to ignore cache on reload.'),
    enableDebugger: zod
      .boolean()
      .optional()
      .describe(
        'Whether to enable the JavaScript debugger after navigation. Default is true.',
      ),
    ...timeoutSchema,
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();

    if (!request.params.type && !request.params.url) {
      throw new Error('Either URL or a type is required.');
    }

    if (!request.params.type) {
      request.params.type = 'url';
    }

    // Set userDisabled flag based on enableDebugger parameter
    if (request.params.enableDebugger === false) {
      const state = getDebuggerState(page);
      state.userDisabled = true;
    } else if (request.params.enableDebugger === true) {
      // Explicitly enable debugger - force enable to override any previous disable
      await initializeDebuggerForPage(page, { forceEnable: true });
    }

    // Create SmartNavigator for debugger-aware navigation
    const navigator = new SmartNavigator(page);

    await context.waitForEventsAfterAction(async () => {
      switch (request.params.type) {
        case 'url': {
          if (!request.params.url) {
            throw new Error('A URL is required for navigation of type=url.');
          }
          // Use SmartNavigator for debugger-aware URL navigation
          const result = await navigator.navigateToUrl(request.params.url, {
            timeout: request.params.timeout,
            debuggerEnabled: request.params.enableDebugger !== false,
          });

          // Format response based on navigation result
          switch (result.status) {
            case 'loaded':
              response.appendResponseLine(
                `Successfully navigated to ${result.url ?? request.params.url}.`,
              );
              break;
            case 'paused':
              response.appendResponseLine(
                `Navigated to ${request.params.url}. Debugger is paused.`,
              );
              if (result.callFrames && result.callFrames.length > 0) {
                const topFrame = result.callFrames[0];
                response.appendResponseLine(
                  `Paused at: ${topFrame.functionName || '(anonymous)'} (${topFrame.url}:${topFrame.location.lineNumber + 1})`,
                );
              }
              break;
            case 'timeout':
              response.appendResponseLine(
                `Navigation to ${request.params.url} timed out: ${result.error}`,
              );
              break;
            case 'error':
              response.appendResponseLine(
                `Unable to navigate to ${request.params.url}: ${result.error}.`,
              );
              break;
          }
          break;
        }
        case 'back': {
          // Use SmartNavigator for debugger-aware back navigation
          const result = await navigator.navigateBack({
            timeout: request.params.timeout,
            debuggerEnabled: request.params.enableDebugger !== false,
          });

          // Format response based on navigation result
          switch (result.status) {
            case 'loaded':
              response.appendResponseLine(
                `Successfully navigated back to ${result.url ?? page.url()}.`,
              );
              break;
            case 'paused':
              response.appendResponseLine(
                `Navigated back. Debugger is paused.`,
              );
              if (result.callFrames && result.callFrames.length > 0) {
                const topFrame = result.callFrames[0];
                response.appendResponseLine(
                  `Paused at: ${topFrame.functionName || '(anonymous)'} (${topFrame.url}:${topFrame.location.lineNumber + 1})`,
                );
              }
              break;
            case 'timeout':
              response.appendResponseLine(
                `Navigate back timed out: ${result.error}`,
              );
              break;
            case 'error':
              response.appendResponseLine(
                `Unable to navigate back in the selected page: ${result.error}.`,
              );
              break;
          }
          break;
        }
        case 'forward': {
          // Use SmartNavigator for debugger-aware forward navigation
          const result = await navigator.navigateForward({
            timeout: request.params.timeout,
            debuggerEnabled: request.params.enableDebugger !== false,
          });

          // Format response based on navigation result
          switch (result.status) {
            case 'loaded':
              response.appendResponseLine(
                `Successfully navigated forward to ${result.url ?? page.url()}.`,
              );
              break;
            case 'paused':
              response.appendResponseLine(
                `Navigated forward. Debugger is paused.`,
              );
              if (result.callFrames && result.callFrames.length > 0) {
                const topFrame = result.callFrames[0];
                response.appendResponseLine(
                  `Paused at: ${topFrame.functionName || '(anonymous)'} (${topFrame.url}:${topFrame.location.lineNumber + 1})`,
                );
              }
              break;
            case 'timeout':
              response.appendResponseLine(
                `Navigate forward timed out: ${result.error}`,
              );
              break;
            case 'error':
              response.appendResponseLine(
                `Unable to navigate forward in the selected page: ${result.error}.`,
              );
              break;
          }
          break;
        }
        case 'reload': {
          // Use SmartNavigator for debugger-aware reload
          const result = await navigator.reload({
            timeout: request.params.timeout,
            ignoreCache: request.params.ignoreCache,
            debuggerEnabled: request.params.enableDebugger !== false,
          });

          // Format response based on navigation result
          switch (result.status) {
            case 'loaded':
              response.appendResponseLine(`Successfully reloaded the page.`);
              break;
            case 'paused':
              response.appendResponseLine(
                `Reloaded the page. Debugger is paused.`,
              );
              if (result.callFrames && result.callFrames.length > 0) {
                const topFrame = result.callFrames[0];
                response.appendResponseLine(
                  `Paused at: ${topFrame.functionName || '(anonymous)'} (${topFrame.url}:${topFrame.location.lineNumber + 1})`,
                );
              }
              break;
            case 'timeout':
              response.appendResponseLine(
                `Reload timed out: ${result.error}`,
              );
              break;
            case 'error':
              response.appendResponseLine(
                `Unable to reload the selected page: ${result.error}.`,
              );
              break;
          }
          break;
        }
      }
    });

    response.setIncludePages(true);
  },
});
