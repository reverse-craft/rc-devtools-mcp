/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Opcode Listing Provider - Provides surrounding bytecode instructions for context display
 *
 * Generates a list of bytecode instructions around the current execution point,
 * similar to a disassembly view in traditional debuggers.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
 */

import type {VmasmContext} from './vmasm-context.js';
import type {InstructionEntry, ConstantEntry} from './vmasm-visitor.js';
import {
  resolveConstantReferences,
  formatConstantInline,
} from './constant-resolver.js';
import {logger} from './logger.js';

/**
 * Represents a single instruction in the opcode listing
 * Requirements: 1.3, 1.4, 1.5, 1.6
 */
export interface ListingInstruction {
  /** Bytecode address */
  address: number;
  /** Address in hex format (e.g., "0x002d") */
  addressHex: string;
  /** Opcode name (e.g., "CALL") */
  opcode: string;
  /** Original operands (e.g., ["K[5]", "3"]) */
  operands: string[];
  /** Operands with K[n] references resolved (e.g., ["\"functionName\"", "3"]) */
  resolvedOperands: string[];
  /** VMASM line number */
  vmasmLine: number;
  /** Whether this is the current instruction */
  isCurrent: boolean;
  /** Optional annotation/comment from vmasm */
  annotation?: string;
}

/**
 * Result of getting instruction listing
 * Requirements: 1.1, 1.2, 1.7
 */
export interface InstructionListing {
  /** Instructions in the listing */
  instructions: ListingInstruction[];
  /** Index of the current instruction in the array */
  currentIndex: number;
  /** Whether there are more instructions before the listing */
  hasMoreBefore: boolean;
  /** Whether there are more instructions after the listing */
  hasMoreAfter: boolean;
}

/**
 * OpcodeListingProvider - Provides opcode listing around current execution point
 *
 * This class generates a formatted list of bytecode instructions around
 * the current instruction pointer, similar to a disassembly view.
 *
 * Requirements:
 * - 1.1: Display instructions around current address
 * - 1.2: Configurable number of context lines (default: 5)
 * - 1.3: Mark current instruction with visual indicator
 * - 1.4: Show address (hex), opcode name, and operands
 * - 1.5: Resolve K[n] references to constant values
 * - 1.6: Display vmasm line number
 * - 1.7: Handle boundary conditions gracefully
 */
export class OpcodeListingProvider {
  private context: VmasmContext;

  /**
   * Create a new OpcodeListingProvider
   *
   * @param context - VmasmContext instance to get instructions from
   */
  constructor(context: VmasmContext) {
    this.context = context;
  }

  /**
   * Get instructions around the current address
   *
   * @param currentAddress - Current instruction pointer value (bytecode address)
   * @param contextLines - Number of lines before/after current instruction (default: 5)
   * @returns InstructionListing with surrounding instructions, or undefined if not available
   *
   * Requirements: 1.1, 1.2, 1.7
   */
  getInstructionListing(
    currentAddress: number,
    contextLines: number = 5
  ): InstructionListing | undefined {
    const ast = this.context.getActiveAST();
    if (!ast || ast.instructions.length === 0) {
      logger('OpcodeListingProvider: No active AST or empty instructions');
      return undefined;
    }

    const instructions = ast.instructions;
    const constants = ast.constants;

    // Find the index of the current instruction
    const currentIndex = instructions.findIndex(
      (instr) => instr.addr === currentAddress
    );

    if (currentIndex === -1) {
      // Requirement 1.7: Handle case where address is not found
      logger(
        `OpcodeListingProvider: Address 0x${currentAddress.toString(16).padStart(4, '0')} not found in instructions`
      );
      return undefined;
    }

    // Calculate range with boundary handling (Requirement 1.7)
    const startIndex = Math.max(0, currentIndex - contextLines);
    const endIndex = Math.min(
      instructions.length - 1,
      currentIndex + contextLines
    );

    // Build listing instructions
    const listingInstructions: ListingInstruction[] = [];

    for (let i = startIndex; i <= endIndex; i++) {
      const instr = instructions[i];
      const listingInstr = this.formatInstruction(
        instr,
        constants,
        i === currentIndex
      );
      listingInstructions.push(listingInstr);
    }

    return {
      instructions: listingInstructions,
      currentIndex: currentIndex - startIndex,
      hasMoreBefore: startIndex > 0,
      hasMoreAfter: endIndex < instructions.length - 1,
    };
  }

  /**
   * Format a single instruction for the listing
   *
   * @param instr - The instruction entry from the AST
   * @param constants - Array of constant entries for K[n] resolution
   * @param isCurrent - Whether this is the current instruction
   * @returns Formatted ListingInstruction
   *
   * Requirements: 1.3, 1.4, 1.5, 1.6
   */
  private formatInstruction(
    instr: InstructionEntry,
    constants: ConstantEntry[],
    isCurrent: boolean
  ): ListingInstruction {
    // Requirement 1.4: Format address as hex (0x0000)
    const addressHex = `0x${instr.addr.toString(16).padStart(4, '0')}`;

    // Requirement 1.5: Resolve K[n] references in operands
    const resolvedOperands = instr.operands.map((operand) =>
      this.resolveOperand(operand, constants)
    );

    return {
      address: instr.addr,
      addressHex,
      opcode: instr.opcode,
      operands: [...instr.operands],
      resolvedOperands,
      vmasmLine: instr.lineNumber,
      isCurrent,
    };
  }

  /**
   * Resolve K[n] references in a single operand
   *
   * @param operand - The operand string
   * @param constants - Array of constant entries
   * @returns Resolved operand string
   *
   * Requirement 1.5
   */
  private resolveOperand(operand: string, constants: ConstantEntry[]): string {
    // Check if operand is a simple K[n] reference
    const kRefMatch = operand.match(/^K\[(\d+)\]$/);
    if (kRefMatch) {
      const index = parseInt(kRefMatch[1], 10);
      const constant = constants.find((c) => c.index === index);
      if (constant) {
        // Format as K[n]=value for clarity
        return `${operand}=${formatConstantInline(constant, 20)}`;
      }
      // Return original if constant not found
      return operand;
    }

    // For expressions containing K[n], resolve them inline
    if (operand.includes('K[')) {
      const result = resolveConstantReferences(operand, constants);
      if (result.hasReferences && result.resolvedIndices.length > 0) {
        return result.resolved;
      }
    }

    return operand;
  }

  /**
   * Format the instruction listing for display output
   *
   * Creates a formatted string representation suitable for display in
   * the get_vm_state tool output.
   *
   * @param listing - The InstructionListing to format
   * @returns Array of formatted lines for display
   *
   * Requirements: 1.1, 1.3, 1.4, 1.5, 1.6
   */
  formatListingDisplay(listing: InstructionListing): string[] {
    const lines: string[] = [];

    // Add "..." indicator if there are more instructions before
    if (listing.hasMoreBefore) {
      lines.push('   ...');
    }

    for (const instr of listing.instructions) {
      // Requirement 1.3: Mark current instruction with visual indicator
      const marker = instr.isCurrent ? '→ ' : '   ';

      // Format operands with resolved values
      const operandsStr =
        instr.resolvedOperands.length > 0
          ? ' ' + instr.resolvedOperands.join(', ')
          : '';

      // Requirement 1.6: Include vmasm line number
      // Format: → 0x002e | L:48  | CALL K[5]="invoke", 3
      const lineNum = `L:${instr.vmasmLine.toString().padStart(3, ' ')}`;
      const line = `${marker}${instr.addressHex} | ${lineNum} | ${instr.opcode}${operandsStr}`;

      lines.push(line);
    }

    // Add "..." indicator if there are more instructions after
    if (listing.hasMoreAfter) {
      lines.push('   ...');
    }

    return lines;
  }
}

/**
 * Convenience function to get formatted opcode listing
 *
 * @param context - VmasmContext instance
 * @param currentAddress - Current instruction pointer value
 * @param contextLines - Number of lines before/after (default: 5)
 * @returns Array of formatted lines, or undefined if not available
 */
export function getFormattedOpcodeListing(
  context: VmasmContext,
  currentAddress: number,
  contextLines: number = 5
): string[] | undefined {
  const provider = new OpcodeListingProvider(context);
  const listing = provider.getInstructionListing(currentAddress, contextLines);

  if (!listing) {
    return undefined;
  }

  return provider.formatListingDisplay(listing);
}
