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
   * Optional account name. When set, the `PW` header carries `username:password`
   * so the server can disambiguate the account — required when copyparty is run
   * with `--usernames`. See {@link CopypartyClient.headers}.
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
 * Auth: copyparty accepts the password via the `PW` request header (see
 * initial-plan.md "Auth"). By default copyparty matches the account from the
 * password alone and ignores any username. But when the server is started with
 * `--usernames`, the credential must be `username:password` — a bare password
 * is rejected. So when a `username` is configured we send `PW: user:pass`,
 * which copyparty also accepts on non-`--usernames` servers (it just finds the
 * password component), keeping this format safe for every server.
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
      h['PW'] = this.username
        ? `${this.username}:${this.password}`
        : this.password;
    }
    return h;
  }
}
