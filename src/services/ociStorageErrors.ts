export class OciStorageError extends Error {
  readonly httpStatus: number;
  readonly code: string;

  constructor(message: string, httpStatus: number, code: string) {
    super(message);
    this.name = 'OciStorageError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}
