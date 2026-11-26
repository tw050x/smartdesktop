import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeStep } from '@smartdesktop/ui/main/steps/smartspec.js';

test('running the checks says what it runs', () => {
  assert.equal(describeStep('mcp__smartspec__run_checks', { schematic_id: 's1' }), 'Running the checks');
  assert.equal(describeStep('run_checks', { schematic_id: 's1', only: 'order-by-id' }), 'Running the checks of “order-by-id”');
  assert.equal(describeStep('run_checks', { schematic_id: 's1', proposal: true }), 'Running the proposal’s checks');
  assert.equal(describeStep('get_test_results', {}), 'Reading the test results');
});
