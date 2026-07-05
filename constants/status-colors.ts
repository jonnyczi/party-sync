import type { RunStatus } from '@/src/db/types';

import { Colors } from './theme';

type Scheme = 'light' | 'dark';

/**
 * Single source of truth for run-status colours. Replaces the per-screen
 * ternary ladders that were previously duplicated (and drifting) across the
 * home dashboard, jobs list, job detail, and run detail. Pulls from the
 * semantic tokens in theme.ts so every status indicator stays consistent and
 * theme-aware in both light and dark mode.
 */
export function statusColor(status: RunStatus, scheme: Scheme): string {
  const c = Colors[scheme];
  switch (status) {
    case 'ok':
      return c.success;
    case 'partial':
      return c.warning;
    case 'failed':
      return c.danger;
    case 'skipped':
      return c.skipped;
    case 'running':
      return c.running;
    case 'cancelled':
    case 'interrupted':
      return c.muted;
    default:
      return c.muted;
  }
}

/**
 * Human-readable reason a run was skipped — closes the "silently skipped"
 * loop: the DB has stored skip_reason since phase 6, but no screen showed it.
 */
export function skipReasonLabel(reason: string): string {
  switch (reason) {
    case 'wifi_only':
      return 'waiting for Wi-Fi';
    case 'data_saver':
      return 'Data Saver on';
    case 'charging_only':
      return 'waiting for charger';
    case 'already_running':
      return 'another sync was running';
    default:
      return reason;
  }
}

/** Human-readable label for a run status (used by pills/summaries). */
export function statusLabel(status: RunStatus): string {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'partial':
      return 'partial';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    case 'running':
      return 'running';
    case 'cancelled':
      return 'cancelled';
    case 'interrupted':
      return 'interrupted';
    default:
      return status;
  }
}
