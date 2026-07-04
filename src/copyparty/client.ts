import { bytesToBase64 } from '../backup/base64';

import type {
  HandshakeBody,
  HandshakeResponse,
  LsResponse,
  SearchResponse,
} from './types';
import { Up2kError } from './types';

export interface CopypartyClientOptions {
  baseUrl: string;
  password?: string;
  /**
   * Optional account name. When set, the credential is sent as HTTP Basic auth
   * (`username:password`) so it authenticates on `--usernames` servers as well
   * as default ones. See {@link CopypartyClient.headers}.
   */
  username?: string;
  /** Extra fetch init merged into every request (e.g. for self-signed cert agents in Node tests). */
  fetchInit?: RequestInit;
  /** Fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

/**
 * Thin HTTP wrapper around copyparty's up2k endpoints.
 *
 * Auth: copyparty matches the account from the password (it is globally unique
 * across accounts). When NO username is configured we send the bare password in
 * the `PW` request header (see initial-plan.md "Auth").
 *
 * When a username IS configured we instead send HTTP Basic auth
 * (`Authorization: Basic base64(user:pass)`). This matters because copyparty
 * matches the `PW` header *verbatim*, so `PW: user:pass` only works on
 * `--usernames` servers and is rejected (403) by default ones; Basic auth is
 * parsed by trying the `user:pass`, `pass`, and `user` components, so it
 * authenticates on both. (Limitation: a server run with `--no-bauth` disables
 * Basic auth — uncommon, and not handled here.)
 *
 * URL handling: every request takes a `folderPath` (e.g. `/phone-backups/`)
 * which is joined to `baseUrl`. The trailing slash is required by copyparty
 * for folder URLs — we add it if missing.
 */
export class CopypartyClient {
  private readonly baseUrl: string;
  private readonly password?: string;
  private readonly username?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly fetchInit: RequestInit;

  constructor(opts: CopypartyClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.password = opts.password;
    // Empty/whitespace usernames collapse to undefined so we never emit a
    // leading-colon `PW: :pass`, which copyparty would read as an empty user.
    this.username = opts.username?.trim() || undefined;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.fetchInit = opts.fetchInit ?? {};
  }

  /** Resolve a folder path to a full URL with a trailing slash. */
  folderUrl(folderPath: string): string {
    const trimmed = folderPath.replace(/^\/+/, '').replace(/\/+$/, '');
    return trimmed ? `${this.baseUrl}/${trimmed}/` : `${this.baseUrl}/`;
  }

  /**
   * POST a handshake (or search) to a folder URL. Returns the parsed JSON.
   * On non-2xx the promise rejects with an Up2kError carrying the http
   * status so the caller can distinguish auth (401), missing folder (404),
   * etc. from server-side processing errors (5xx).
   */
  async handshake(
    folderPath: string,
    body: HandshakeBody | (HandshakeBody & { srch: 1 }),
  ): Promise<HandshakeResponse | SearchResponse> {
    const res = await this.fetchImpl(this.folderUrl(folderPath), {
      ...this.fetchInit,
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Up2kError(
        `handshake ${res.status} ${res.statusText} for ${folderPath}`,
        'handshake',
        res.status,
      );
    }
    return (await res.json()) as HandshakeResponse | SearchResponse;
  }

  /**
   * POST one chunk's worth of bytes. The hash header may carry one or more
   * comma-joined chunk hashes (chunk stitching); v1 always sends one.
   */
  async uploadChunk(
    folderPath: string,
    headers: { hash: string; wark: string; subc?: number; stat?: string },
    body: Uint8Array,
  ): Promise<void> {
    const h: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.byteLength),
      'X-Up2k-Hash': headers.hash,
      'X-Up2k-Wark': headers.wark,
    };
    if (headers.subc !== undefined) h['X-Up2k-Subc'] = String(headers.subc);
    if (headers.stat) h['X-Up2k-Stat'] = headers.stat;

    const res = await this.fetchImpl(this.folderUrl(folderPath), {
      ...this.fetchInit,
      method: 'POST',
      headers: this.headers(h),
      // BodyInit accepts ArrayBuffer in both DOM and Node typings; the cast
      // satisfies stricter RN-bundled fetch types that omit Uint8Array.
      body: body as unknown as BodyInit,
    });
    if (!res.ok) {
      throw new Up2kError(
        `chunk upload ${res.status} ${res.statusText}`,
        'upload',
        res.status,
      );
    }
  }

  /**
   * GET a folder listing (`?ls`). Used by the pre-flight test buttons to
   * validate reachability, auth, and — when called against a specific remote
   * path — the user's permissions on that volume.
   */
  async listFolder(folderPath: string): Promise<LsResponse> {
    const res = await this.fetchImpl(`${this.folderUrl(folderPath)}?ls`, {
      ...this.fetchInit,
      method: 'GET',
      headers: this.headers({}),
    });
    if (!res.ok) {
      throw new Up2kError(
        `ls ${res.status} ${res.statusText} for ${folderPath}`,
        'ls',
        res.status,
      );
    }
    return (await res.json()) as LsResponse;
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.password) {
      if (this.username) {
        // HTTP Basic auth carries `user:pass` in a form copyparty accepts on
        // both `--usernames` and default servers (the verbatim `PW: user:pass`
        // header 403s on the latter). TextEncoder gives correct UTF-8 for
        // non-ASCII credentials; bytesToBase64 is Hermes-safe (no btoa).
        const creds = bytesToBase64(
          new TextEncoder().encode(`${this.username}:${this.password}`),
        );
        h['Authorization'] = `Basic ${creds}`;
      } else {
        h['PW'] = this.password;
      }
    }
    return h;
  }
}
