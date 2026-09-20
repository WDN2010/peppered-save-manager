import { describe, expect, it } from 'vitest';
import { friendlyErrorStatus } from '../src/renderer/App';

describe('renderer restore error classification', () => {
  it('uses the guarded backup path when rollback consumed the temporary', () => {
    const backup = 'C:\\Users\\Player\\guarded backup with spaces.bak';
    const status = friendlyErrorStatus(new Error(`Windows guarded replacement failed: ROLLBACK_FAILED_WIN32_32 BACKUP_PRESERVED_AT ${backup}`));
    expect(status).toEqual({ key: 'restoreRollbackFailedWithBackup', vars: { path: backup } });
  });

  it('keeps quarantine residue separate from valid recovery evidence', () => {
    const residue = '/tmp/catalog with spaces/.candidate.discard-123';
    const status = friendlyErrorStatus(new Error(`Recovery candidate cleanup left residue at ${residue}; QUARANTINE_RESIDUE_AT ${residue}; cleanup failed`));
    expect(status).toEqual({ key: 'restoreCandidateCleanupResidue', vars: { path: residue } });
  });
});
