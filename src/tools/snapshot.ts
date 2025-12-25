/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third-party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './tool-definition.js';

/**
 * Tool to take a text snapshot of the currently selected page based on the a11y tree.
 */
export const takeSnapshot = defineTool({
  name: 'take_snapshot',
  description: `Take a text snapshot of the currently selected page based on the a11y tree. Lists page elements with unique identifiers. Supports search filtering and pagination.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    verbose: zod
      .boolean()
      .optional()
      .describe(
        'Whether to include all possible information available in the full a11y tree. Default is false.',
      ),
    filePath: zod
      .string()
      .optional()
      .describe(
        'The absolute path, or a path relative to the current working directory, to save the snapshot to instead of attaching it to the response. Useful for saving large snapshots that can be searched with grep/rg tools.',
      ),
    search: zod
      .string()
      .optional()
      .describe(
        'Filter snapshot to only include elements matching this text (case-insensitive). Matches against element name, role, and other attributes.',
      ),
    pageSize: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Number of elements per page for pagination. If not specified, all matching elements are returned.',
      ),
    pageIdx: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Page index (0-based) for pagination. Requires pageSize to be set.'),
  },
  handler: async (request, response) => {
    response.includeSnapshot({
      verbose: request.params.verbose ?? false,
      filePath: request.params.filePath,
      search: request.params.search,
      pageSize: request.params.pageSize,
      pageIdx: request.params.pageIdx,
    });
  },
});
