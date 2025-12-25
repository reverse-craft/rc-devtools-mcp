/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ScriptParser module for parsing JavaScript code and extracting function definitions
 * and call relationships using AST analysis.
 */

import * as acorn from 'acorn';

import type {
  CallInfo,
  FunctionInfo,
  FunctionType,
  ParseError,
  ParseResult,
} from './analysis-types.js';
import {buildLineOffsets} from './context-code-utils.js';

// Acorn AST node types we work with
type AcornNode = acorn.Node & {
  type: string;
  body?: AcornNode | AcornNode[];
  id?: {name: string; start: number; end: number} | null;
  params?: Array<{name?: string; type: string}>;
  init?: AcornNode | null;
  declarations?: Array<{id: {name?: string; type: string}; init?: AcornNode | null}>;
  expression?: AcornNode;
  left?: AcornNode;
  right?: AcornNode;
  callee?: AcornNode & {name?: string; property?: {name: string}; object?: AcornNode};
  key?: {name?: string; value?: string};
  value?: AcornNode;
  properties?: AcornNode[];
  argument?: AcornNode;
  consequent?: AcornNode | AcornNode[];
  alternate?: AcornNode | null;
  object?: AcornNode;
  property?: {name?: string};
  elements?: Array<AcornNode | null>;
  arguments?: AcornNode[];
  test?: AcornNode;
  update?: AcornNode;
  name?: string;
};

/**
 * Convert acorn position (0-based offset) to line and column.
 */
function positionToLineColumn(
  source: string,
  position: number
): {line: number; column: number} {
  let line = 1;
  let lastNewline = -1;

  for (let i = 0; i < position && i < source.length; i++) {
    if (source[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }

  return {
    line,
    column: position - lastNewline - 1,
  };
}

/**
 * Extract parameter names from function parameters.
 */
function extractParams(params: Array<{name?: string; type: string}> | undefined): string[] {
  if (!params) return [];

  return params.map((param, index) => {
    if (param.name) return param.name;
    // Handle destructuring and rest parameters
    if (param.type === 'RestElement') return '...rest';
    if (param.type === 'ObjectPattern') return '{...}';
    if (param.type === 'ArrayPattern') return '[...]';
    if (param.type === 'AssignmentPattern') return `param${index}`;
    return `param${index}`;
  });
}


/**
 * Parse a JavaScript source file and extract function definitions and call relationships.
 *
 * @param scriptId - The CDP script ID
 * @param scriptUrl - The script URL
 * @param source - The JavaScript source code
 * @returns ParseResult containing functions, calls, and any errors
 */
export function parseScript(
  scriptId: string,
  scriptUrl: string,
  source: string
): ParseResult {
  const functions: FunctionInfo[] = [];
  const calls: CallInfo[] = [];
  const errors: ParseError[] = [];

  // Track the current function scope for call extraction
  const scopeStack: string[] = ['<global>'];

  let ast: AcornNode;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowReserved: true,
    }) as AcornNode;
  } catch (error) {
    // Handle parse errors gracefully
    const parseError = error as {message: string; loc?: {line: number; column: number}};
    errors.push({
      scriptId,
      scriptUrl,
      message: parseError.message || String(error),
      line: parseError.loc?.line,
      column: parseError.loc?.column,
    });
    // Build line offsets even on parse error for position conversion
    const lineOffsets = buildLineOffsets(source);
    return {ast: null, functions, calls, errors, lineOffsets};
  }

  /**
   * Add a function to the results.
   */
  function addFunction(
    name: string,
    type: FunctionType,
    node: AcornNode,
    params: Array<{name?: string; type: string}> | undefined
  ): void {
    const pos = positionToLineColumn(source, node.start);
    functions.push({
      name,
      scriptId,
      scriptUrl,
      lineNumber: pos.line,
      columnNumber: pos.column,
      params: extractParams(params),
      type,
    });
  }

  /**
   * Get the callee name from a CallExpression.
   */
  function getCalleeName(callee: AcornNode): string | null {
    if (callee.type === 'Identifier' && callee.name) {
      return callee.name;
    }
    if (callee.type === 'MemberExpression' && callee.property?.name) {
      // For method calls like obj.method(), return just the method name
      return callee.property.name;
    }
    return null;
  }

  /**
   * Recursively traverse the AST.
   */
  function traverse(node: AcornNode | null | undefined, contextName?: string): void {
    if (!node) return;

    switch (node.type) {
      // Function declarations: function foo() {}
      case 'FunctionDeclaration': {
        const name = node.id?.name || contextName || `<anonymous@${node.start}>`;
        addFunction(name, 'declaration', node, node.params);
        scopeStack.push(name);
        traverseBody(node.body);
        scopeStack.pop();
        break;
      }

      // Function expressions: const foo = function() {} or function() {}
      case 'FunctionExpression': {
        const name = node.id?.name || contextName || `<anonymous@${node.start}>`;
        const type: FunctionType = node.id?.name ? 'expression' : contextName ? 'expression' : 'anonymous';
        addFunction(name, type, node, node.params);
        scopeStack.push(name);
        traverseBody(node.body);
        scopeStack.pop();
        break;
      }

      // Arrow functions: const foo = () => {}
      case 'ArrowFunctionExpression': {
        const name = contextName || `<anonymous@${node.start}>`;
        addFunction(name, 'arrow', node, node.params);
        scopeStack.push(name);
        traverseBody(node.body);
        scopeStack.pop();
        break;
      }

      // Variable declarations: const foo = function() {} or const foo = () => {}
      case 'VariableDeclaration': {
        for (const decl of node.declarations || []) {
          const varName = decl.id?.type === 'Identifier' ? decl.id.name : undefined;
          if (decl.init) {
            traverse(decl.init, varName);
          }
        }
        break;
      }

      // Assignment expressions: foo = function() {}
      case 'AssignmentExpression': {
        let assignName: string | undefined;
        if (node.left?.type === 'Identifier' && node.left.name) {
          assignName = node.left.name;
        } else if (node.left?.type === 'MemberExpression' && node.left.property?.name) {
          assignName = node.left.property.name;
        }
        traverse(node.right, assignName);
        break;
      }

      // Object methods: { foo() {} } or { foo: function() {} }
      case 'Property': {
        const keyName = node.key?.name || node.key?.value;
        if (node.value) {
          if (node.value.type === 'FunctionExpression' || node.value.type === 'ArrowFunctionExpression') {
            // Method shorthand or property with function value
            traverse(node.value, keyName);
          } else {
            traverse(node.value);
          }
        }
        break;
      }

      // Method definitions in classes: class { foo() {} }
      case 'MethodDefinition': {
        const methodName = node.key?.name || node.key?.value || `<method@${node.start}>`;
        if (node.value) {
          const funcNode = node.value as AcornNode;
          addFunction(methodName, 'method', funcNode, funcNode.params);
          scopeStack.push(methodName);
          traverseBody(funcNode.body);
          scopeStack.pop();
        }
        break;
      }

      // Call expressions: foo() or obj.foo()
      case 'CallExpression': {
        const calleeName = getCalleeName(node.callee as AcornNode);
        if (calleeName) {
          const pos = positionToLineColumn(source, node.start);
          calls.push({
            caller: scopeStack[scopeStack.length - 1],
            callee: calleeName,
            scriptId,
            lineNumber: pos.line,
            columnNumber: pos.column,
          });
        }
        // Traverse callee and arguments
        traverse(node.callee as AcornNode);
        for (const arg of node.arguments || []) {
          traverse(arg);
        }
        break;
      }

      // Object expressions: { ... }
      case 'ObjectExpression': {
        for (const prop of node.properties || []) {
          traverse(prop);
        }
        break;
      }

      // Class declarations and expressions
      case 'ClassDeclaration':
      case 'ClassExpression': {
        const classBody = (node as any).body;
        if (classBody?.body) {
          for (const member of classBody.body) {
            traverse(member);
          }
        }
        break;
      }

      // Default: traverse child nodes
      default: {
        traverseBody(node.body);
        if (node.expression) traverse(node.expression);
        if (node.init) traverse(node.init);
        if (node.test) traverse(node.test);
        if (node.update) traverse(node.update);
        if (node.consequent) traverseBody(node.consequent);
        if (node.alternate) traverse(node.alternate);
        if (node.argument) traverse(node.argument);
        if (node.left) traverse(node.left);
        if (node.right) traverse(node.right);
        if (node.object) traverse(node.object);
        if (node.elements) {
          for (const el of node.elements) {
            if (el) traverse(el);
          }
        }
        if (node.declarations) {
          for (const decl of node.declarations) {
            if (decl.init) {
              traverse(decl.init);
            }
          }
        }
        break;
      }
    }
  }

  /**
   * Traverse a body which can be a single node or array of nodes.
   */
  function traverseBody(body: AcornNode | AcornNode[] | undefined | null): void {
    if (!body) return;
    if (Array.isArray(body)) {
      for (const node of body) {
        traverse(node);
      }
    } else {
      traverse(body);
    }
  }

  // Start traversal from the program body
  traverseBody(ast.body);

  // Build line offsets array for efficient position conversion
  const lineOffsets = buildLineOffsets(source);

  // Return ParseResult with cached AST and lineOffsets
  return {ast: ast as acorn.Node, functions, calls, errors, lineOffsets};
}
