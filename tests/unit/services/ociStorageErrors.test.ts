import { mapOciError, OciStorageError, isRetryableOciError } from '@/services/ociStorageErrors';

describe('ociStorageErrors', () => {
  it('maps 404 to OBJECT_NOT_FOUND', () => {
    const err = mapOciError({ statusCode: 404, message: 'Not Found' });
    expect(err).toBeInstanceOf(OciStorageError);
    expect(err.httpStatus).toBe(404);
    expect(err.code).toBe('OBJECT_NOT_FOUND');
  });

  it('maps 403 to STORAGE_FORBIDDEN', () => {
    const err = mapOciError({ statusCode: 403, message: 'Not authorized' });
    expect(err.code).toBe('STORAGE_FORBIDDEN');
  });

  it('maps timeout to STORAGE_UNAVAILABLE', () => {
    const err = mapOciError(new Error('socket hang up'));
    expect(err.code).toBe('STORAGE_UNAVAILABLE');
    expect(isRetryableOciError(err)).toBe(true);
  });

  it('does not retry 404', () => {
    const err = mapOciError({ statusCode: 404 });
    expect(isRetryableOciError(err)).toBe(false);
  });
});
