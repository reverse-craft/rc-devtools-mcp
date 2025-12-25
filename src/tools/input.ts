/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Input automation tools for rc-devtools-mcp.
 * Provides click, fill, and keyboard interaction capabilities.
 */

import type {McpContext, TextSnapshotNode} from '../core/mcp-context.js';
import {zod} from '../third-party/index.js';
import type {ElementHandle} from '../third-party/index.js';
import {parseKey} from '../utils/keyboard.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './tool-definition.js';

export const click = defineTool({
  name: 'click',
  description: `Clicks on the provided element`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot',
      ),
    dblClick: zod
      .boolean()
      .optional()
      .describe('Set to true for double clicks. Default is false.'),
  },
  handler: async (request, response, context) => {
    const uid = request.params.uid;
    const handle = await context.getElementByUid(uid);
    try {
      await context.waitForEventsAfterAction(async () => {
        await handle.asLocator().click({
          count: request.params.dblClick ? 2 : 1,
        });
      });
      response.appendResponseLine(
        request.params.dblClick
          ? `Successfully double clicked on the element`
          : `Successfully clicked on the element`,
      );
      response.includeSnapshot();
    } finally {
      void handle.dispose();
    }
  },
});


/**
 * Selects an option from a combobox element.
 * Finds the correct option by matching text content and uses the element's value.
 */
async function selectOption(
  handle: ElementHandle,
  aXNode: TextSnapshotNode,
  value: string,
) {
  let optionFound = false;
  for (const child of aXNode.children) {
    if (child.role === 'option' && child.name === value && child.value) {
      optionFound = true;
      const childHandle = await child.elementHandle();
      if (childHandle) {
        try {
          const childValueHandle = await childHandle.getProperty('value');
          try {
            const childValue = await childValueHandle.jsonValue();
            if (childValue) {
              await handle.asLocator().fill(childValue.toString());
            }
          } finally {
            void childValueHandle.dispose();
          }
          break;
        } finally {
          void childHandle.dispose();
        }
      }
    }
  }
  if (!optionFound) {
    throw new Error(`Could not find option with text "${value}"`);
  }
}

/**
 * Fills a form element with the specified value.
 * Handles both regular inputs and combobox elements.
 */
async function fillFormElement(
  uid: string,
  value: string,
  context: McpContext,
) {
  const handle = await context.getElementByUid(uid);
  try {
    const aXNode = context.getAXNodeByUid(uid);
    if (aXNode && aXNode.role === 'combobox') {
      await selectOption(handle, aXNode, value);
    } else {
      await handle.asLocator().fill(value);
    }
  } finally {
    void handle.dispose();
  }
}

export const fill = defineTool({
  name: 'fill',
  description: `Type text into a input, text area or select an option from a <select> element.`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot',
      ),
    value: zod.string().describe('The value to fill in'),
  },
  handler: async (request, response, context) => {
    await context.waitForEventsAfterAction(async () => {
      await fillFormElement(
        request.params.uid,
        request.params.value,
        context as McpContext,
      );
    });
    response.appendResponseLine(`Successfully filled out the element`);
    response.includeSnapshot();
  },
});

export const pressKey = defineTool({
  name: 'press_key',
  description: `Press a key or key combination for keyboard shortcuts and navigation keys.`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    key: zod
      .string()
      .describe(
        'A key or a combination (e.g., "Enter", "Control+A", "Control++", "Control+Shift+R"). Modifiers: Control, Shift, Alt, Meta',
      ),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const tokens = parseKey(request.params.key);
    const [key, ...modifiers] = tokens;

    await context.waitForEventsAfterAction(async () => {
      for (const modifier of modifiers) {
        await page.keyboard.down(modifier);
      }
      await page.keyboard.press(key);
      for (const modifier of modifiers.toReversed()) {
        await page.keyboard.up(modifier);
      }
    });

    response.appendResponseLine(
      `Successfully pressed key: ${request.params.key}`,
    );
    response.includeSnapshot();
  },
});
