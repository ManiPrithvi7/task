import { mapGmbStarRating, getReview, listReviews } from '@/services/googleBusiness/googleBusinessApi';

function mockAuth(requestImpl: jest.Mock) {
  return { request: requestImpl } as never;
}

describe('mapGmbStarRating', () => {
  it('passes through numeric ratings 0-5', () => {
    expect(mapGmbStarRating(0)).toBe(0);
    expect(mapGmbStarRating(3.5)).toBe(3.5);
    expect(mapGmbStarRating(5)).toBe(5);
  });

  it('maps string enum ratings', () => {
    expect(mapGmbStarRating('ONE')).toBe(1);
    expect(mapGmbStarRating('FIVE')).toBe(5);
    expect(mapGmbStarRating('STAR_RATING_UNSPECIFIED')).toBe(0);
  });

  it('returns 0 for invalid inputs', () => {
    expect(mapGmbStarRating(-1)).toBe(0);
    expect(mapGmbStarRating(6)).toBe(0);
    expect(mapGmbStarRating('TEN')).toBe(0);
    expect(mapGmbStarRating(null)).toBe(0);
    expect(mapGmbStarRating(undefined)).toBe(0);
  });
});

describe('getReview', () => {
  it('requests review by name (strips leading slash) and returns data', async () => {
    const request = jest.fn().mockResolvedValue({ data: { name: 'r1', rating: 5 } });
    const result = await getReview(mockAuth(request), '/locations/123/reviews/456');
    expect(result).toEqual({ name: 'r1', rating: 5 });
    expect(request).toHaveBeenCalledWith({
      url: 'https://mybusiness.googleapis.com/v4/locations/123/reviews/456',
      method: 'GET'
    });
  });

  it('returns null on empty data', async () => {
    const request = jest.fn().mockResolvedValue({ data: null });
    expect(await getReview(mockAuth(request), 'locations/123/reviews/456')).toBeNull();
  });

  it('returns null when request throws', async () => {
    const request = jest.fn().mockRejectedValue(new Error('http 500'));
    expect(await getReview(mockAuth(request), 'locations/123/reviews/456')).toBeNull();
  });
});

describe('listReviews', () => {
  it('collects reviews from single page', async () => {
    const request = jest.fn().mockResolvedValue({ data: { reviews: [{ id: 'a' }, { id: 'b' }] } });
    const result = await listReviews(mockAuth(request), '/locations/123');
    expect(result).toHaveLength(2);
    expect(request).toHaveBeenCalledWith({
      url: 'https://mybusiness.googleapis.com/v4/locations/123/reviews',
      method: 'GET',
      params: { pageSize: 50 }
    });
  });

  it('paginates until nextPageToken exhausted, passing pageToken onward', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce({ data: { reviews: [{ id: 'a' }], nextPageToken: 'tok1' } })
      .mockResolvedValueOnce({ data: { reviews: [{ id: 'b' }], nextPageToken: 'tok2' } })
      .mockResolvedValueOnce({ data: { reviews: [{ id: 'c' }] } });
    const result = await listReviews(mockAuth(request), 'locations/123', 50, 0);
    expect(result).toHaveLength(3);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1][0].params).toEqual({ pageSize: 50, pageToken: 'tok1' });
    expect(request.mock.calls[2][0].params).toEqual({ pageSize: 50, pageToken: 'tok2' });
  });

  it('respects maxPages limit', async () => {
    const request = jest.fn().mockResolvedValue({ data: { reviews: [{ id: 'a' }], nextPageToken: 'tok' } });
    const result = await listReviews(mockAuth(request), 'locations/123', 10, 2);
    expect(request).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it('honors custom pageSize', async () => {
    const request = jest.fn().mockResolvedValue({ data: {} });
    await listReviews(mockAuth(request), 'locations/123', 25);
    expect(request.mock.calls[0][0].params).toEqual({ pageSize: 25 });
  });

  it('returns empty array when request throws', async () => {
    const request = jest.fn().mockRejectedValue(new Error('boom'));
    expect(await listReviews(mockAuth(request), 'locations/123')).toEqual([]);
  });

  it('maxPages 0 means unlimited until token exhausted', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce({ data: { reviews: [{ id: 'a' }], nextPageToken: 'tok' } })
      .mockResolvedValueOnce({ data: { reviews: [{ id: 'b' }], nextPageToken: 'tok' } })
      .mockResolvedValueOnce({ data: { reviews: [{ id: 'c' }] } });
    const result = await listReviews(mockAuth(request), 'locations/123', 50, 0);
    expect(request).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(3);
  });
});
