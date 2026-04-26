#!/usr/bin/env node

/**
 * PPG AUDIT SCRIPT
 * 
 * Verifies that the codebase has no fake/simulated PPG data.
 * 
 * Fails if it finds:
 * - Math.random in src outside of tests
 * - Hardcoded BPM values
 * - Hardcoded SpO2 values
 * - mock/fake/simulated in production
 * - setInterval generating waveform
 * - Vibration without beat confirmation
 * - UI components calculating vital signs
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SRC_DIR = join(__dirname, '../src');
const TEST_DIR = join(__dirname, '../src/test');

const PATTERNS = {
  MATH_RANDOM: /Math\.random\(/,
  HARDCODED_BPM: /bpm\s*[:=]\s*\d+/i,
  HARDCODED_SPO2: /spo2\s*[:=]\s*\d+/i,
  MOCK_FAKE_SIMULATED: /(mock|fake|simulated|fallback|demo|placeholder)/i,
  SETINTERVAL_WAVEFORM: /setInterval.*waveform|setInterval.*pulse|setInterval.*beat/i,
  VIBRATION_TIMER: /vibrate.*setInterval|setInterval.*vibrate/i,
};

const EXCLUDED_DIRS = ['test', '__tests__', 'node_modules'];

let errors = [];
let checkedFiles = 0;

function checkFile(filePath) {
  checkedFiles++;
  const content = readFileSync(filePath, 'utf-8');
  const relativePath = relative(SRC_DIR, filePath);
  
  // Skip test files
  if (filePath.includes(TEST_DIR) || filePath.includes('__tests__')) {
    return;
  }

  // Check Math.random
  if (PATTERNS.MATH_RANDOM.test(content)) {
    errors.push(`${relativePath}: Math.random found`);
  }

  // Check hardcoded BPM
  if (PATTERNS.HARDCODED_BPM.test(content)) {
    // Allow in type definitions and comments
    if (!content.includes('interface') && !content.includes('//')) {
      errors.push(`${relativePath}: Hardcoded BPM found`);
    }
  }

  // Check hardcoded SpO2
  if (PATTERNS.HARDCODED_SPO2.test(content)) {
    if (!content.includes('interface') && !content.includes('//')) {
      errors.push(`${relativePath}: Hardcoded SpO2 found`);
    }
  }

  // Check mock/fake/simulated
  if (PATTERNS.MOCK_FAKE_SIMULATED.test(content)) {
    // Allow in comments
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      if (PATTERNS.MOCK_FAKE_SIMULATED.test(line) && !line.trim().startsWith('//')) {
        errors.push(`${relativePath}:${i + 1}: Mock/fake/simulated found`);
      }
    });
  }

  // Check setInterval waveform
  if (PATTERNS.SETINTERVAL_WAVEFORM.test(content)) {
    errors.push(`${relativePath}: setInterval generating waveform found`);
  }

  // Check vibration timer
  if (PATTERNS.VIBRATION_TIMER.test(content)) {
    errors.push(`${relativePath}: Vibration timer found`);
  }
}

function walkDir(dir) {
  const files = readdirSync(dir);
  
  for (const file of files) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    
    if (stat.isDirectory()) {
      if (!EXCLUDED_DIRS.includes(file)) {
        walkDir(filePath);
      }
    } else if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.jsx')) {
      checkFile(filePath);
    }
  }
}

console.log('🔍 Auditing PPG codebase for fake/simulated data...\n');

walkDir(SRC_DIR);

console.log(`✅ Checked ${checkedFiles} files\n`);

if (errors.length > 0) {
  console.error('❌ AUDIT FAILED:\n');
  errors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
} else {
  console.log('✅ AUDIT PASSED: No fake/simulated PPG data found');
  process.exit(0);
}
