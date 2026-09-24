'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { STATES, fromOwnerSnapshot, composeIndexingStatusPayload } = require('../src/main/ledger-status-registry');

// @req IR-APP-013 FR-APP-007
const expected = [
  'NOT_CONFIGURED', 'COLD', 'RECOVERY_DISCOVERY', 'RECOVERY_CHECKING',
  'BOOTSTRAPPING', 'CHECKING', 'CHECKER_EXIT_PENDING', 'CHECKER_EXIT_BLOCKED',
  'FTS_VALIDATING', 'KEYWORD_VALIDATING', 'CORRUPT_DEGRADED', 'MIGRATION_REQUIRED',
  'BACKING_UP', 'BACKUP_RECOVERING', 'MIGRATION_BLOCKED', 'MIGRATING',
  'VERIFYING_FULL', 'VERIFYING_KEYWORD_ISOLATED', 'RESTORE_FINALIZING',
  'OWNER_EXIT_PENDING', 'OWNER_EXIT_BLOCKED', 'INTERRUPTED', 'RESTORING',
  'ROLLBACK_REQUIRED', 'READY', 'READY_KEYWORD_ONLY', 'READY_KEYWORD_DEGRADED',
  'KEYWORD_REPAIRING', 'ANN_BUILDING', 'READY_MAINTENANCE_PENDING'
];
assert.deepEqual(Object.keys(STATES), expected, 'all 30 canonical states have a stable registry');
assert.equal(new Set(Object.values(STATES)).size, expected.length, 'canonical codes are one-to-one');
const codes = [
  'ledger_storage_not_configured', 'ledger_initializing', 'ledger_recovery_discovery',
  'ledger_recovery_checking', 'ledger_bootstrapping', 'ledger_checking',
  'ledger_checker_exit_pending', 'ledger_checker_exit_blocked', 'fts_validation_pending',
  'keyword_validation_pending', 'ledger_recovery_required', 'ledger_migration_required',
  'ledger_backup_in_progress', 'ledger_backup_recovering', 'ledger_migration_blocked',
  'ledger_migrating', 'ledger_verifying_full', 'ledger_verifying_keyword_isolated',
  'ledger_restore_finalizing', 'ledger_owner_exit_pending', 'ledger_owner_exit_blocked',
  'ledger_maintenance_interrupted', 'ledger_restore_in_progress', 'ledger_rollback_required',
  'ledger_ready', 'semantic_unavailable', 'keyword_index_unavailable',
  'keyword_repair_in_progress', 'semantic_rebuild_in_progress', 'maintenance_pending'
];
assert.deepEqual(Object.values(STATES), codes, 'each state maps to its approved canonical code');
for (const locale of ['ko', 'en', 'ja', 'es']) {
  const strings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/locales', `${locale}.json`), 'utf8'));
  for (const state of expected) {
    const key = `settings.ledger.state.${state}`;
    assert.ok(typeof strings[key] === 'string' && strings[key].trim(), `${locale} translates ${state}`);
  }
  for (const state of ['rebuilding', 'indexing', 'queued', 'compacting', 'clearing', 'checking', 'repairing']) {
    const key = `settings.legacyState.${state}`;
    assert.ok(typeof strings[key] === 'string' && strings[key].trim(), `${locale} translates active legacy ${state}`);
  }
}
assert.deepEqual(fromOwnerSnapshot(null, false), { ledgerState: 'NOT_CONFIGURED', ledgerCode: STATES.NOT_CONFIGURED,
  ledgerPhase: null, ledgerProgress: null, ledgerCondition: null }, 'unconfigured store is canonical');
assert.equal(fromOwnerSnapshot({ state: 'stale' }, true).ledgerCode, STATES.READY_KEYWORD_DEGRADED,
  'legacy owner stale state maps to canonical keyword degradation');
assert.equal(fromOwnerSnapshot({ state: 'ready', progress: { current: 9, total: 10 } }, true).ledgerProgress, 90,
  'progress comes from the owner snapshot');
const mixed = composeIndexingStatusPayload({ state: 'rebuilding', failedCount: 2, rebuildSession: { active: true } },
  { state: 'ready' }, true);
assert.equal(mixed.state, 'rebuilding', 'legacy rebuild state retains public precedence');
assert.equal(mixed.ledgerState, 'READY', 'owner READY remains a parallel private field');
assert.equal(mixed.failedCount, 2, 'legacy failed documents remain available for retry');
console.log('test-ledger-status-registry: all assertions passed');
