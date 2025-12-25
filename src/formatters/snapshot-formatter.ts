/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import type {TextSnapshot, TextSnapshotNode} from '../core/mcp-context.js';
import {paginate} from '../utils/pagination.js';
import type {PaginationOptions} from '../utils/types.js';

export interface SnapshotFormatOptions {
  search?: string;
  pagination?: PaginationOptions;
}

export interface FormattedSnapshotResult {
  content: string;
  totalElements: number;
  matchedElements: number;
  currentPage: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Flattens the snapshot tree into a list of nodes with their depths.
 */
function flattenSnapshotTree(
  root: TextSnapshotNode,
  depth = 0,
): Array<{node: TextSnapshotNode; depth: number}> {
  const result: Array<{node: TextSnapshotNode; depth: number}> = [];
  result.push({node: root, depth});
  for (const child of root.children) {
    result.push(...flattenSnapshotTree(child, depth + 1));
  }
  return result;
}

/**
 * Checks if a node matches the search query (case-insensitive).
 */
function nodeMatchesSearch(node: TextSnapshotNode, search: string): boolean {
  const searchLower = search.toLowerCase();
  const attributes = getAttributes(node);
  const attributeString = attributes.join(' ').toLowerCase();
  return attributeString.includes(searchLower);
}

/**
 * Formats a single node into a string line.
 */
function formatNodeLine(
  node: TextSnapshotNode,
  depth: number,
  snapshot?: TextSnapshot,
): string {
  const attributes = getAttributes(node);
  return (
    ' '.repeat(depth * 2) +
    attributes.join(' ') +
    (node.id === snapshot?.selectedElementUid
      ? ' [selected in the DevTools Elements panel]'
      : '')
  );
}

export function formatSnapshotNode(
  root: TextSnapshotNode,
  snapshot?: TextSnapshot,
  depth = 0,
): string {
  const chunks: string[] = [];

  if (depth === 0) {
    // Top-level content of the snapshot.
    if (
      snapshot?.verbose &&
      snapshot?.hasSelectedElement &&
      !snapshot.selectedElementUid
    ) {
      chunks.push(`Note: there is a selected element in the DevTools Elements panel but it is not included into the current a11y tree snapshot.
Get a verbose snapshot to include all elements if you are interested in the selected element.\n\n`);
    }
  }

  const attributes = getAttributes(root);
  const line =
    ' '.repeat(depth * 2) +
    attributes.join(' ') +
    (root.id === snapshot?.selectedElementUid
      ? ' [selected in the DevTools Elements panel]'
      : '') +
    '\n';
  chunks.push(line);

  for (const child of root.children) {
    chunks.push(formatSnapshotNode(child, snapshot, depth + 1));
  }

  return chunks.join('');
}

/**
 * Formats the snapshot with search filtering and pagination support.
 */
export function formatSnapshotWithOptions(
  root: TextSnapshotNode,
  snapshot?: TextSnapshot,
  options?: SnapshotFormatOptions,
): FormattedSnapshotResult {
  const chunks: string[] = [];

  // Add note about selected element if needed
  if (
    snapshot?.verbose &&
    snapshot?.hasSelectedElement &&
    !snapshot.selectedElementUid
  ) {
    chunks.push(`Note: there is a selected element in the DevTools Elements panel but it is not included into the current a11y tree snapshot.
Get a verbose snapshot to include all elements if you are interested in the selected element.`);
  }

  // Flatten the tree for easier filtering and pagination
  const allNodes = flattenSnapshotTree(root);
  const totalElements = allNodes.length;

  // Apply search filter if provided
  let filteredNodes = allNodes;
  if (options?.search) {
    filteredNodes = allNodes.filter(({node}) =>
      nodeMatchesSearch(node, options.search!),
    );
  }
  const matchedElements = filteredNodes.length;

  // Apply pagination
  const paginationResult = paginate(filteredNodes, options?.pagination);

  // Format the paginated nodes
  for (const {node, depth} of paginationResult.items) {
    chunks.push(formatNodeLine(node, depth, snapshot));
  }

  return {
    content: chunks.join('\n'),
    totalElements,
    matchedElements,
    currentPage: paginationResult.currentPage,
    totalPages: paginationResult.totalPages,
    hasNextPage: paginationResult.hasNextPage,
    hasPreviousPage: paginationResult.hasPreviousPage,
  };
}

function getAttributes(serializedAXNodeRoot: TextSnapshotNode): string[] {
  const attributes = [`uid=${serializedAXNodeRoot.id}`];
  if (serializedAXNodeRoot.role) {
    // To match representation in DevTools.
    attributes.push(
      serializedAXNodeRoot.role === 'none'
        ? 'ignored'
        : serializedAXNodeRoot.role,
    );
  }
  if (serializedAXNodeRoot.name) {
    attributes.push(`"${serializedAXNodeRoot.name}"`);
  }

  const excluded = new Set([
    'id',
    'role',
    'name',
    'elementHandle',
    'children',
    'backendNodeId',
  ]);

  const booleanPropertyMap: Record<string, string> = {
    disabled: 'disableable',
    expanded: 'expandable',
    focused: 'focusable',
    selected: 'selectable',
  };

  for (const attr of Object.keys(serializedAXNodeRoot).sort()) {
    if (excluded.has(attr)) {
      continue;
    }
    const value = (serializedAXNodeRoot as unknown as Record<string, unknown>)[
      attr
    ];
    if (typeof value === 'boolean') {
      if (booleanPropertyMap[attr]) {
        attributes.push(booleanPropertyMap[attr]);
      }
      if (value) {
        attributes.push(attr);
      }
    } else if (typeof value === 'string' || typeof value === 'number') {
      attributes.push(`${attr}="${value}"`);
    }
  }
  return attributes;
}
