/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Script tools for rc-devtools-mcp.
 * Provides script evaluation capabilities.
 */

import type {CDPSession} from '../third-party/index.js';
import {zod} from '../third-party/index.js';
import {getCdpSession} from '../utils/cdp.js';
import {getScriptCache} from '../utils/smart-breakpoint-utils.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './tool-definition.js';

interface RuntimeResult {
  type: string;
  subtype?: string;
  objectId?: string;
  value?: unknown;
  description?: string;
  className?: string;
  unserializableValue?: string;
  preview?: {
    type: string;
    subtype?: string;
    description?: string;
    properties?: Array<{name: string; type: string; value?: string}>;
  };
}

interface FormattedResult {
  value: string;
  location?: string;
}

async function formatResult(
  session: CDPSession,
  result: RuntimeResult,
): Promise<FormattedResult> {
  const {type, subtype, objectId, value, description, unserializableValue, preview} =
    result;

  if (type === 'undefined') {
    return {value: 'undefined'};
  }
  if (subtype === 'null') {
    return {value: 'null'};
  }
  if (unserializableValue) {
    return {value: unserializableValue};
  }
  if (type === 'boolean' || type === 'number' || type === 'bigint') {
    return {value: String(value)};
  }
  if (type === 'string') {
    return {value: JSON.stringify(value)};
  }
  if (type === 'symbol') {
    return {value: description || 'Symbol()'};
  }

  if (type === 'function' && objectId) {
    const location = await getFunctionLocation(session, objectId);
    const source = description || '[Function]';
    return {value: source, location};
  }

  if (subtype === 'node' && objectId) {
    const nodeDesc = await getNodeDescription(session, objectId);
    return {value: nodeDesc || description || '[Node]'};
  }

  if (subtype === 'array' && objectId) {
    const arrayStr = await serializeObject(session, objectId);
    return {value: arrayStr || description || '[]'};
  }

  if (
    subtype === 'regexp' ||
    subtype === 'date' ||
    subtype === 'map' ||
    subtype === 'set' ||
    subtype === 'error'
  ) {
    return {value: description || `[${subtype}]`};
  }

  if (subtype === 'promise' && preview) {
    return {value: description || 'Promise'};
  }

  if (type === 'object' && objectId) {
    const objStr = await serializeObject(session, objectId);
    return {value: objStr || description || '[Object]'};
  }

  return {value: description || `[${type}]`};
}

async function getFunctionLocation(
  session: CDPSession,
  objectId: string,
): Promise<string | undefined> {
  try {
    const props = (await session.send('Runtime.getProperties', {
      objectId,
      ownProperties: false,
    })) as {
      internalProperties?: Array<{
        name: string;
        value?: {value?: {scriptId: string; lineNumber: number; columnNumber: number}};
      }>;
    };

    const locationProp = props.internalProperties?.find(
      p => p.name === '[[FunctionLocation]]',
    );
    if (locationProp?.value?.value) {
      const {scriptId, lineNumber, columnNumber} = locationProp.value.value;
      const scriptCache = getScriptCache(session);
      const scriptInfo = scriptCache.get(scriptId);
      const url = scriptInfo?.url || `VM${scriptId}`;
      return `${url}:${lineNumber + 1}:${columnNumber + 1}`;
    }
  } catch {
    // Ignore errors
  }
  return undefined;
}

async function getNodeDescription(
  session: CDPSession,
  objectId: string,
): Promise<string | undefined> {
  try {
    const result = (await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        const el = this;
        if (el.nodeType === 1) {
          let s = '<' + el.tagName.toLowerCase();
          if (el.id) s += ' id="' + el.id + '"';
          if (el.className) s += ' class="' + el.className + '"';
          s += '>';
          return s;
        }
        return el.nodeName;
      }`,
      returnByValue: true,
    })) as {result: {value?: string}};
    return result.result.value;
  } catch {
    return undefined;
  }
}

async function serializeObject(
  session: CDPSession,
  objectId: string,
): Promise<string | undefined> {
  try {
    const result = (await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        try {
          return JSON.stringify(this, null, 2);
        } catch {
          return null;
        }
      }`,
      returnByValue: true,
    })) as {result: {value?: string | null}};
    return result.result.value ?? undefined;
  } catch {
    return undefined;
  }
}

function formatExceptionDetails(exceptionDetails: {
  text?: string;
  exception?: {description?: string};
  lineNumber?: number;
  columnNumber?: number;
}): string {
  if (exceptionDetails.exception?.description) {
    return exceptionDetails.exception.description;
  }
  if (exceptionDetails.text) {
    const loc =
      exceptionDetails.lineNumber !== undefined
        ? ` at line ${exceptionDetails.lineNumber + 1}:${(exceptionDetails.columnNumber ?? 0) + 1}`
        : '';
    return `${exceptionDetails.text}${loc}`;
  }
  return 'Unknown error';
}

const DEFAULT_MAX_OUTPUT_CHARS = 10000;

export const evaluateScript = defineTool({
  name: 'evaluate_script',
  description: `Evaluate JavaScript code inside the currently selected page, similar to DevTools Console.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    script: zod.string().describe('JavaScript code to execute in the page context.'),
    maxOutputChars: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Maximum number of characters in the output. Default is ${DEFAULT_MAX_OUTPUT_CHARS}.`),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const script = request.params.script;
    const maxOutputChars = request.params.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    const session = await getCdpSession(page);

    await context.waitForEventsAfterAction(async () => {
      const evalResult = (await session.send('Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: false,
        generatePreview: true,
        userGesture: true,
        replMode: true,
      })) as {
        result: RuntimeResult;
        exceptionDetails?: {
          text?: string;
          exception?: {description?: string};
          lineNumber?: number;
          columnNumber?: number;
        };
      };

      if (evalResult.exceptionDetails) {
        const errorMsg = formatExceptionDetails(evalResult.exceptionDetails);
        const truncatedError = truncateToMaxChars(errorMsg, maxOutputChars);
        response.appendResponseLine('❌ Error: ' + truncatedError.text);
        if (truncatedError.truncated) {
          response.appendResponseLine(`⚠️ Output truncated: ${truncatedError.originalLength} chars → ${maxOutputChars} chars`);
        }
        return;
      }

      const formatted = await formatResult(session, evalResult.result);
      const truncatedResult = truncateToMaxChars(formatted.value, maxOutputChars);
      response.appendResponseLine(truncatedResult.text);
      if (truncatedResult.truncated) {
        response.appendResponseLine(`⚠️ Output truncated: ${truncatedResult.originalLength} chars → ${maxOutputChars} chars`);
      }
      if (formatted.location) {
        response.appendResponseLine(`📍 ${formatted.location}`);
      }
    });
  },
});

function truncateToMaxChars(
  text: string,
  maxChars: number,
): {text: string; truncated: boolean; originalLength: number} {
  const originalLength = text.length;
  if (originalLength <= maxChars) {
    return {text, truncated: false, originalLength};
  }
  return {
    text: text.substring(0, maxChars) + '\n... <truncated>',
    truncated: true,
    originalLength,
  };
}
