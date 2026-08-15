import { normalizeRemotePath } from '@/src/copyparty/paths';
import type { SourceKind } from '@/src/db/types';

/** The job-form fields that decide whether a draft can be saved. */
export type JobDraft = {
  hasServers: boolean;
  serverId: number | null;
  name: string;
  sourceKind: SourceKind;
  sourceUri: string;
  remotePath: string;
};

/**
 * The first thing stopping this draft from being saved, phrased for the user,
 * or null when it is ready to save.
 *
 * The job form's Save button lives in the navigator header, where greying it
 * out reads as ordinary chrome rather than a disabled control — so a tap on an
 * incomplete form has to say what is missing instead of doing nothing.
 *
 * Order follows the form top to bottom (Name → Server → Source → Remote path)
 * so the message names the first field the user will meet on the way back up.
 * The exception is "no servers at all", which comes first because it is the one
 * blocker that cannot be resolved on this screen.
 */
export function missingRequirement(draft: JobDraft): string | null {
  if (!draft.hasServers) return 'Add a server from the Servers tab first.';
  if (draft.name.trim().length === 0) return 'Give this job a name.';
  if (draft.serverId === null) return 'Pick a server to continue.';
  if (draft.sourceUri.length === 0) {
    return draft.sourceKind === 'media'
      ? 'Choose which photos to back up.'
      : 'Choose a local folder to back up.';
  }
  if (normalizeRemotePath(draft.remotePath).length === 0) {
    return 'Enter a remote path on the server.';
  }
  return null;
}
