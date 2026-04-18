export interface HandshakeBody {
  name: string;
  size: number;
  lmod: number;
  hash: string[];
}

export interface HandshakeSearchBody extends HandshakeBody {
  srch: 1;
}

export interface HandshakeResponse {
  name: string;
  purl: string;
  wark: string;
  hash: string[];
  sprs: boolean;
  fk?: string;
}

export interface SearchHit {
  rp: string;
  ts: number;
}

export interface SearchResponse {
  hits: SearchHit[];
}

export interface ChunkUploadHeaders {
  'Content-Type': 'application/octet-stream';
  'Content-Length': string;
  'X-Up2k-Hash': string;
  'X-Up2k-Wark': string;
  'X-Up2k-Subc'?: string;
  'X-Up2k-Stat'?: string;
}

export interface ChunkPlan {
  hash: string;
  car: number;
  cdr: number;
}

export type UploadPhase = 'stat' | 'hash' | 'handshake' | 'upload' | 'finalize';

export class Up2kError extends Error {
  constructor(
    message: string,
    public readonly phase: UploadPhase,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'Up2kError';
  }
}
