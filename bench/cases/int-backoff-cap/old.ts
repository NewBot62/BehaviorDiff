export function retryDelay(attempt: number): number {
  return Math.pow(2, attempt) * 100;
}
