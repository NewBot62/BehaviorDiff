// Example module used by the live self-test of the BehaviorDiff Action (see .github/workflows/selftest.yml).
export function shippingCost(subtotal: number, express: boolean): number {
  if (subtotal >= 50) return express ? 5 : 0;
  return express ? 15 : 8;
}

export function itemLabel(count: number, name: string): string {
  return count === 1 ? `1 ${name}` : `${count} ${name}s`;
}

export function discount(total: number, code: string | undefined): number {
  if (!code) return total;
  if (code === "HALF") return total / 2;
  return total;
}
