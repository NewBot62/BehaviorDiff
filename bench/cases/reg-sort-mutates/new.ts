export interface User { name: string; age: number }
export function sortByAge(users: User[]): User[] {
  return users.sort((a, b) => a.age - b.age);
}
