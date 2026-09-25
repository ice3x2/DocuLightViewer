'use strict';
// @req IR-APP-013
const STATES = Object.freeze({
  NOT_CONFIGURED: 'ledger_storage_not_configured',
  COLD: 'ledger_initializing',
  RECOVERY_DISCOVERY: 'ledger_recovery_discovery',
  RECOVERY_CHECKING: 'ledger_recovery_checking',
  BOOTSTRAPPING: 'ledger_bootstrapping',
  CHECKING: 'ledger_checking',
  CHECKER_EXIT_PENDING: 'ledger_checker_exit_pending',
  CHECKER_EXIT_BLOCKED: 'ledger_checker_exit_blocked',
  FTS_VALIDATING: 'fts_validation_pending',
  KEYWORD_VALIDATING: 'keyword_validation_pending',
  CORRUPT_DEGRADED: 'ledger_recovery_required',
  MIGRATION_REQUIRED: 'ledger_migration_required',
  BACKING_UP: 'ledger_backup_in_progress',
  BACKUP_RECOVERING: 'ledger_backup_recovering',
  MIGRATION_BLOCKED: 'ledger_migration_blocked',
  MIGRATING: 'ledger_migrating',
  VERIFYING_FULL: 'ledger_verifying_full',
  VERIFYING_KEYWORD_ISOLATED: 'ledger_verifying_keyword_isolated',
  RESTORE_FINALIZING: 'ledger_restore_finalizing',
  OWNER_EXIT_PENDING: 'ledger_owner_exit_pending',
  OWNER_EXIT_BLOCKED: 'ledger_owner_exit_blocked',
  INTERRUPTED: 'ledger_maintenance_interrupted',
  RESTORING: 'ledger_restore_in_progress',
  ROLLBACK_REQUIRED: 'ledger_rollback_required',
  READY: 'ledger_ready',
  READY_KEYWORD_ONLY: 'semantic_unavailable',
  READY_KEYWORD_DEGRADED: 'keyword_index_unavailable',
  KEYWORD_REPAIRING: 'keyword_repair_in_progress',
  ANN_BUILDING: 'semantic_rebuild_in_progress',
  READY_MAINTENANCE_PENDING: 'maintenance_pending'
});

function fromOwnerSnapshot(snapshot, configured) {
  let ledgerState = 'NOT_CONFIGURED';
  if (configured) {
    const state = snapshot && snapshot.state;
    if (Object.hasOwn(STATES, state)) ledgerState = state;
    else if (state === 'ready') ledgerState = 'READY';
    else if (state === 'stale') ledgerState = 'READY_KEYWORD_DEGRADED';
    else if (state === 'clearing') ledgerState = 'READY_MAINTENANCE_PENDING';
    else if (state === 'indexing') ledgerState = snapshot.phase === 'ann' ? 'ANN_BUILDING' : 'KEYWORD_REPAIRING';
    else if (state === 'failed') ledgerState = 'OWNER_EXIT_BLOCKED';
    else if (state === 'shutdown') ledgerState = 'OWNER_EXIT_PENDING';
    else ledgerState = 'COLD';
  }
  const progress = snapshot && snapshot.progress;
  const ledgerProgress = progress && Number.isFinite(progress.current) && Number.isFinite(progress.total) && progress.total > 0
    ? Math.max(0, Math.min(100, Math.floor(progress.current * 100 / progress.total))) : null;
  return { ledgerState, ledgerCode: STATES[ledgerState],
    ledgerPhase: snapshot && typeof snapshot.phase === 'string' && /^[a-z0-9_-]{1,40}$/.test(snapshot.phase) ? snapshot.phase : null,
    ledgerProgress,
    ledgerCondition: snapshot && snapshot.condition === 'indexing_ingress_capacity'
      ? 'indexing_ingress_capacity' : null };
}

function composeIndexingStatusPayload(rawStatus, ownerStatus, sourceRootConfigured) {
  const status = {
    ...rawStatus,
    sourceRootConfigured,
    canRebuild: sourceRootConfigured,
    ...fromOwnerSnapshot(ownerStatus, sourceRootConfigured)
  };
  if (!sourceRootConfigured) {
    Object.assign(status, { state: 'storage-not-configured', indexedCount: 0,
      pendingCount: 0, failedCount: 0, currentPath: null, phase: null,
      progress: null, rebuildSession: null, errorSummary: null });
  }
  if (sourceRootConfigured && ['rebuild', 'clear'].includes(ownerStatus?.kind)) {
    const session = ownerStatus.rebuildSession || null;
    Object.assign(status, {
      state: ownerStatus.active ? ownerStatus.kind === 'clear' ? 'clearing' : 'rebuilding'
        : ownerStatus.phase === 'failed' ? 'degraded'
        : ownerStatus.phase === 'cancelled' ? 'stale' : status.state,
      phase: ownerStatus.phase || null,
      progress: ownerStatus.progress || status.progress,
      rebuildSession: session,
      indexedCount: session?.active ? session.indexedCount : status.indexedCount,
      pendingCount: session?.active ? session.pendingCount : status.pendingCount,
      currentPath: ownerStatus.currentPath || null,
      heartbeatAt: ownerStatus.heartbeatAt || null,
      cancelRequested: ownerStatus.cancelRequested === true,
      diagnostic: ownerStatus.diagnostic || status.diagnostic
    });
  }
  return status;
}

module.exports = { STATES, fromOwnerSnapshot, composeIndexingStatusPayload };
