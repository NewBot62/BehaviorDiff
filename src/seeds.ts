import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Test files next to a source file. Their string/number literals are good generated inputs. */
export function seedsFor(file: string, root = "."): string[] {
  const dir = dirname(file);
  const base = basename(file).replace(/\.[^.]+$/, "");
  const out: string[] = [];
  const py = file.endsWith(".py");
  for (const d of [dir, join(dir, "test"), join(dir, "tests"), join(dir, "__tests__"), join(root, "test"), join(root, "tests")]) {
    if (!existsSync(d)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      if (py) {
        if (n === `test_${base}.py` || n === `${base}_test.py`) out.push(join(d, n));
        continue;
      }
      if (new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(test|spec)\\.`).test(n) || (d !== dir && n.startsWith(base + ".")) || /^test\.(js|mjs|cjs|ts)$/.test(n)) out.push(join(d, n));
    }
  }
  return [...new Set(out)].slice(0, 4);
}
