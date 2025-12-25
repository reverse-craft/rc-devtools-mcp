/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

// TODO: These tools are temporarily disabled due to a bug where scripts
// don't persist after page refresh. The issue is that function declarations
// like `() => { ... }` are not automatically executed - they need to be
// wrapped in an IIFE. Fix is in progress in persistent-scripts.ts.

// Empty export to keep this as a valid module
export {};

/*
import {zod} from '../third-party/index.js';
import * as persistentScripts from '../utils/persistent-scripts.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './tool-definition.js';

export const addPersistentScript = defineTool({
  name: 'add_persistent_script',
  description: `Register a JavaScript script to execute automatically on every page load.

This is useful for persistent hooks (like XHR interceptors, fetch interceptors, etc.) that need to survive page refreshes.
The script will execute before any other scripts on the page, making it ideal for:
- Intercepting network requests (XMLHttpRequest, fetch)
- Modifying global objects or prototypes
- Setting up debugging hooks

Returns a unique identifier that can be used to remove the script later.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    function: zod.string().describe(
      `A JavaScript function or code to execute on every page load.
Example: \`() => {
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    console.log('Fetch intercepted:', args[0]);
    return originalFetch.apply(this, args);
  };
}\``,
    ),
    name: zod
      .string()
      .optional()
      .describe(
        `An optional name for the script to help identify it when listing scripts.`,
      ),
  },
  handler: async (request, response, context) => {
    const {function: source, name} = request.params;
    const page = context.getSelectedPage();

    try {
      const entry = await persistentScripts.addScript(page, source, name);

      response.appendResponseLine(`✅ Persistent script registered successfully.`);
      response.appendResponseLine('');
      response.appendResponseLine(`**Identifier:** \`${entry.identifier}\``);
      if (name) {
        response.appendResponseLine(`**Name:** ${name}`);
      }
      response.appendResponseLine('');
      response.appendResponseLine(
        'The script will execute automatically before any other scripts on subsequent page loads.',
      );
      response.appendResponseLine(
        'Use `remove_persistent_script` with the identifier to remove it.',
      );
      response.appendResponseLine(
        'Use `list_persistent_scripts` to see all registered scripts.',
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      response.appendResponseLine(`❌ Failed to register persistent script:`);
      response.appendResponseLine('```');
      response.appendResponseLine(errorMessage);
      response.appendResponseLine('```');
    }
  },
});

export const removePersistentScript = defineTool({
  name: 'remove_persistent_script',
  description: `Remove a previously registered persistent script by its identifier.

After removal, the script will no longer execute on subsequent page loads.
Use \`list_persistent_scripts\` to see all registered scripts and their identifiers.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    identifier: zod.string().describe(
      `The unique identifier of the script to remove. This is returned when adding a script with \`add_persistent_script\`.`,
    ),
  },
  handler: async (request, response, context) => {
    const {identifier} = request.params;
    const page = context.getSelectedPage();

    try {
      const removed = await persistentScripts.removeScript(page, identifier);

      if (removed) {
        response.appendResponseLine(`✅ Persistent script removed successfully.`);
        response.appendResponseLine('');
        response.appendResponseLine(`**Identifier:** \`${identifier}\``);
        response.appendResponseLine('');
        response.appendResponseLine(
          'The script will no longer execute on subsequent page loads.',
        );
      } else {
        response.appendResponseLine(`❌ Script not found.`);
        response.appendResponseLine('');
        response.appendResponseLine(
          `No persistent script with identifier \`${identifier}\` was found.`,
        );
        response.appendResponseLine('');
        response.appendResponseLine(
          'Use `list_persistent_scripts` to see all registered scripts and their identifiers.',
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      response.appendResponseLine(`❌ Failed to remove persistent script:`);
      response.appendResponseLine('```');
      response.appendResponseLine(errorMessage);
      response.appendResponseLine('```');
    }
  },
});

export const listPersistentScripts = defineTool({
  name: 'list_persistent_scripts',
  description: `List all registered persistent scripts for the current page.

Shows each script's identifier, name (if provided), and a preview of the source code.
Use this to see what hooks are currently active and to get identifiers for removal.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    previewLength: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `Maximum length for script source preview. Defaults to 100 characters. Longer scripts will be truncated with "...".`,
      ),
  },
  handler: async (request, response, context) => {
    const {previewLength = 100} = request.params;
    const page = context.getSelectedPage();

    const scripts = persistentScripts.listScripts(page);

    if (scripts.length === 0) {
      response.appendResponseLine(`📋 No persistent scripts registered.`);
      response.appendResponseLine('');
      response.appendResponseLine(
        'Use `add_persistent_script` to register a script that executes on every page load.',
      );
      return;
    }

    response.appendResponseLine(
      `📋 **${scripts.length} persistent script${scripts.length === 1 ? '' : 's'} registered:**`,
    );
    response.appendResponseLine('');

    for (const script of scripts) {
      response.appendResponseLine(`---`);
      response.appendResponseLine(`**Identifier:** \`${script.identifier}\``);
      if (script.name) {
        response.appendResponseLine(`**Name:** ${script.name}`);
      }
      response.appendResponseLine(
        `**Created:** ${new Date(script.createdAt).toISOString()}`,
      );
      response.appendResponseLine(`**Source preview:**`);
      response.appendResponseLine('```javascript');
      response.appendResponseLine(
        persistentScripts.truncateSource(script.source, previewLength),
      );
      response.appendResponseLine('```');
      response.appendResponseLine('');
    }

    response.appendResponseLine('---');
    response.appendResponseLine(
      'Use `remove_persistent_script` with an identifier to remove a specific script.',
    );
    response.appendResponseLine(
      'Use `clear_persistent_scripts` to remove all scripts at once.',
    );
  },
});

export const clearPersistentScripts = defineTool({
  name: 'clear_persistent_scripts',
  description: `Remove all registered persistent scripts for the current page at once.

This is useful for quickly resetting to a clean state without having to remove scripts individually.
Returns the count of scripts that were removed.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {},
  handler: async (_request, response, context) => {
    const page = context.getSelectedPage();

    try {
      const count = await persistentScripts.clearScripts(page);

      if (count === 0) {
        response.appendResponseLine(`📋 No persistent scripts to clear.`);
        response.appendResponseLine('');
        response.appendResponseLine(
          'Use `add_persistent_script` to register a script that executes on every page load.',
        );
      } else {
        response.appendResponseLine(`✅ Cleared all persistent scripts.`);
        response.appendResponseLine('');
        response.appendResponseLine(
          `**Scripts removed:** ${count}`,
        );
        response.appendResponseLine('');
        response.appendResponseLine(
          'No scripts will execute on subsequent page loads.',
        );
        response.appendResponseLine(
          'Use `add_persistent_script` to register new scripts.',
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      response.appendResponseLine(`❌ Failed to clear persistent scripts:`);
      response.appendResponseLine('```');
      response.appendResponseLine(errorMessage);
      response.appendResponseLine('```');
    }
  },
});
*/
