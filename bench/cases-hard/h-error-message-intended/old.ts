export function charge(amount: number): number {
  if (amount < 0) throw new Error("bad");
  return amount * 100;
}
