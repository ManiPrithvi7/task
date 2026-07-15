export const BucketTarget = {
  METRICS: 'metrics' as const,
  COMPLIANCE: 'compliance' as const,
} as const;

export type BucketTarget = (typeof BucketTarget)[keyof typeof BucketTarget];
