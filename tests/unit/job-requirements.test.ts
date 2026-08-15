import { describe, expect, it } from 'vitest';

import { missingRequirement, type JobDraft } from '@/src/job-requirements';

/** A draft with every requirement met; tests knock out one field at a time. */
const complete: JobDraft = {
  hasServers: true,
  serverId: 1,
  name: 'Camera backup',
  sourceKind: 'media',
  sourceUri: 'media:all',
  remotePath: '/phone-backups/camera',
};

describe('missingRequirement', () => {
  it('returns null when the draft is ready to save', () => {
    expect(missingRequirement(complete)).toBeNull();
  });

  it('asks for a server to exist before anything else', () => {
    // Nothing on the job form can fix this one, so it outranks the fields.
    expect(missingRequirement({ ...complete, hasServers: false, name: '' })).toBe(
      'Add a server from the Servers tab first.',
    );
  });

  it('names each unmet field', () => {
    expect(missingRequirement({ ...complete, name: '' })).toBe('Give this job a name.');
    expect(missingRequirement({ ...complete, serverId: null })).toBe(
      'Pick a server to continue.',
    );
    expect(missingRequirement({ ...complete, remotePath: '' })).toBe(
      'Enter a remote path on the server.',
    );
  });

  it('treats a whitespace-only name as unset', () => {
    expect(missingRequirement({ ...complete, name: '   ' })).toBe('Give this job a name.');
  });

  it('normalizes the remote path before judging it', () => {
    // normalizeRemotePath trims, so spaces alone are not a path...
    expect(missingRequirement({ ...complete, remotePath: '   ' })).toBe(
      'Enter a remote path on the server.',
    );
    // ...but the server root is a legitimate destination.
    expect(missingRequirement({ ...complete, remotePath: '/' })).toBeNull();
    // A bare segment normalizes to '/photos' rather than being rejected.
    expect(missingRequirement({ ...complete, remotePath: 'photos' })).toBeNull();
  });

  it('words the missing source for the kind of source in play', () => {
    expect(missingRequirement({ ...complete, sourceKind: 'saf', sourceUri: '' })).toBe(
      'Choose a local folder to back up.',
    );
    expect(missingRequirement({ ...complete, sourceKind: 'media', sourceUri: '' })).toBe(
      'Choose which photos to back up.',
    );
  });

  it('reports the first unmet requirement in form order', () => {
    const empty: JobDraft = {
      hasServers: true,
      serverId: null,
      name: '',
      sourceKind: 'saf',
      sourceUri: '',
      remotePath: '',
    };
    expect(missingRequirement(empty)).toBe('Give this job a name.');
    expect(missingRequirement({ ...empty, name: 'Camera backup' })).toBe(
      'Pick a server to continue.',
    );
    expect(missingRequirement({ ...empty, name: 'Camera backup', serverId: 1 })).toBe(
      'Choose a local folder to back up.',
    );
    expect(
      missingRequirement({
        ...empty,
        name: 'Camera backup',
        serverId: 1,
        sourceUri: 'content://tree/primary%3ADCIM',
      }),
    ).toBe('Enter a remote path on the server.');
  });
});
