const codeFromDiscount = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null;
  const d = value as { code?: string; name?: string };
  const code = (d.code || d.name)?.trim();
  return code || null;
};

/** Extract discount codes from Square payment payload (payment-level + order line items). */
export function extractSquareDiscountCodes(payment: Record<string, unknown>): string[] {
  const codes: string[] = [];

  if (Array.isArray(payment.discounts)) {
    for (const d of payment.discounts) {
      const code = codeFromDiscount(d);
      if (code) codes.push(code);
    }
  }

  const order = payment.order;
  if (order && typeof order === 'object' && Array.isArray((order as Record<string, unknown>).line_items)) {
    for (const item of (order as Record<string, unknown>).line_items as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const discounts = (item as Record<string, unknown>).discounts;
      if (!Array.isArray(discounts)) continue;
      for (const d of discounts) {
        const code = codeFromDiscount(d);
        if (code) codes.push(code);
      }
    }
  }

  return [...new Set(codes)];
}

export function squareDiscountAmountCents(payment: Record<string, unknown>): string {
  const discountMoney = payment.total_discount_money as { amount?: number } | undefined;
  if (typeof discountMoney?.amount === 'number') {
    return String(discountMoney.amount / 100);
  }
  return '0';
}
