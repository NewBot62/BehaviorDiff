export function charge(amount: number): number {
  if (amount < 0) throw new Error("amount must be >= 0");
  return amount * 100;
}
