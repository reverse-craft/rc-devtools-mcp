#!/usr/bin/env tsx

import {getVmasmContext} from './src/utils/vmasm-context.js';

async function main() {
  const vmasmContext = getVmasmContext();
  const filePath = '/Users/kylin/reverse-ai-agent/artifacts/jsrev/douyin.com/output/bdms_disasm.vmasm';
  
  console.log('Loading vmasm file...');
  const result = await vmasmContext.loadFile(filePath);
  
  if (!result.success) {
    console.error('❌ Failed to load:', result.error);
    if (result.parseError) {
      console.error('Parse error:', result.parseError);
    }
    process.exit(1);
  }
  
  console.log('✅ Successfully loaded vmasm file!');
  console.log('\nMetadata:');
  console.log(`  Format: ${result.metadata.format}`);
  console.log(`  Domain: ${result.metadata.domain}`);
  console.log(`  Source: ${result.metadata.source}`);
  console.log(`  URL: ${result.metadata.url}`);
  console.log(`  Instructions: ${result.metadata.instructionCount}`);
  console.log(`  Constants: ${result.metadata.constantCount}`);
  
  const ast = vmasmContext.getActiveAST();
  if (ast && ast.opcodeTransforms) {
    console.log(`  Opcode Transforms: ${ast.opcodeTransforms.size}`);
    
    // Check for PUSH_UNDEF2
    const pushUndef2 = ast.opcodeTransforms.get(33);
    if (pushUndef2) {
      console.log(`\n✅ Found PUSH_UNDEF2 transform:`);
      console.log(`  Opcode: ${pushUndef2.opcodeNumber}`);
      console.log(`  Name: ${pushUndef2.opcodeName}`);
      console.log(`  Variables: ${pushUndef2.variables.length}`);
    }
  }
}

main().catch(console.error);
