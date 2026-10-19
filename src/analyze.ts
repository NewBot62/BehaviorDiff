// Static pass over a source file: parameter types of top-level functions
// and literals worth using as boundary inputs. No type checker needed.
import ts from "typescript";

export type Shape =
  | { k: "number" | "string" | "boolean" | "null" | "undefined" | "date" | "unknown" }
  | { k: "array"; of: Shape }
  | { k: "record"; of: Shape }
  | { k: "object"; props: { name: string; optional: boolean; shape: Shape }[] }
  | { k: "literal"; values: unknown[] }
  | { k: "union"; of: Shape[] }
  | { k: "tuple"; of: Shape[] }
  /** untyped parameter that the body reads properties from (`options.binary`): probe each key */
  | { k: "options"; keys: string[] };

export interface ParamInfo {
  name: string;
  optional: boolean;
  rest: boolean;
  shape: Shape;
}
export interface FnSig {
  name: string;
  params: ParamInfo[];
}
export interface Analysis {
  sigs: Map<string, FnSig>;
  /** source text of each top-level function (trimmed), for LLM review */
  sources: Map<string, string>;
  numbers: number[];
  strings: string[];
}

const U: Shape = { k: "unknown" };

export function analyze(source: string, fileName: string, lim: { maxStrings?: number; maxNumbers?: number; maxStringLength?: number } = {}): Analysis {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
  const decls = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
  for (const s of sf.statements) {
    if ((ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) && s.name) decls.set(s.name.text, s);
  }

  const members = (ms: readonly ts.TypeElement[], depth: number) => {
    const props: { name: string; optional: boolean; shape: Shape }[] = [];
    for (const m of ms) {
      if (!ts.isPropertySignature(m) || !m.name) continue;
      const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : undefined;
      if (name === undefined) continue;
      props.push({ name, optional: !!m.questionToken, shape: toShape(m.type, depth + 1) });
    }
    return props;
  };

  function resolve(name: string, depth: number): Shape {
    const d = decls.get(name);
    if (!d || depth > 4) return U;
    if (ts.isTypeAliasDeclaration(d)) return toShape(d.type, depth + 1);
    const props = [];
    for (const h of d.heritageClauses ?? []) {
      for (const t of h.types) {
        const base = resolve(t.expression.getText(), depth + 1);
        if (base.k === "object") props.push(...base.props);
      }
    }
    props.push(...members(d.members, depth));
    return { k: "object", props };
  }

  function literalValue(t: ts.LiteralTypeNode): { ok: boolean; v?: unknown } {
    const l = t.literal;
    if (ts.isStringLiteral(l) || ts.isNoSubstitutionTemplateLiteral(l)) return { ok: true, v: l.text };
    if (ts.isNumericLiteral(l)) return { ok: true, v: Number(l.text) };
    if (l.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, v: true };
    if (l.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, v: false };
    if (l.kind === ts.SyntaxKind.NullKeyword) return { ok: true, v: null };
    if (ts.isPrefixUnaryExpression(l) && ts.isNumericLiteral(l.operand)) return { ok: true, v: -Number(l.operand.text) };
    return { ok: false };
  }

  function toShape(n: ts.TypeNode | undefined, depth = 0): Shape {
    if (!n || depth > 5) return U;
    switch (n.kind) {
      case ts.SyntaxKind.NumberKeyword: return { k: "number" };
      case ts.SyntaxKind.StringKeyword: return { k: "string" };
      case ts.SyntaxKind.BooleanKeyword: return { k: "boolean" };
      case ts.SyntaxKind.UndefinedKeyword: return { k: "undefined" };
      case ts.SyntaxKind.NullKeyword: return { k: "null" };
    }
    if (ts.isParenthesizedTypeNode(n)) return toShape(n.type, depth + 1);
    if (ts.isLiteralTypeNode(n)) {
      const lv = literalValue(n);
      return lv.ok ? { k: "literal", values: [lv.v] } : U;
    }
    if (ts.isArrayTypeNode(n)) return { k: "array", of: toShape(n.elementType, depth + 1) };
    if (ts.isTupleTypeNode(n)) {
      return { k: "tuple", of: n.elements.map((e) => toShape(ts.isNamedTupleMember(e) ? e.type : e, depth + 1)) };
    }
    if (ts.isTypeLiteralNode(n)) return { k: "object", props: members(n.members, depth) };
    if (ts.isUnionTypeNode(n)) {
      const parts = n.types.map((t) => toShape(t, depth + 1));
      const lits = parts.filter((p) => p.k === "literal") as { k: "literal"; values: unknown[] }[];
      const rest = parts.filter((p) => p.k !== "literal");
      const merged: Shape[] = lits.length ? [{ k: "literal", values: lits.flatMap((l) => l.values) }] : [];
      const all = [...merged, ...rest];
      return all.length === 1 ? all[0]! : { k: "union", of: all };
    }
    if (ts.isTypeReferenceNode(n)) {
      const name = n.typeName.getText();
      const args = n.typeArguments ?? [];
      if ((name === "Array" || name === "ReadonlyArray") && args[0]) return { k: "array", of: toShape(args[0], depth + 1) };
      if (name === "Record" && args[1]) return { k: "record", of: toShape(args[1], depth + 1) };
      if (name === "Date") return { k: "date" };
      if ((name === "Partial" || name === "Readonly" || name === "Required") && args[0]) return toShape(args[0], depth + 1);
      return resolve(name, depth + 1);
    }
    if (n.kind === ts.SyntaxKind.TypeOperator) {
      const op = n as ts.TypeOperatorNode;
      if (op.operator === ts.SyntaxKind.ReadonlyKeyword) return toShape(op.type, depth + 1);
    }
    return U;
  }

  function inferFromInit(e: ts.Expression | undefined): Shape {
    if (!e) return U;
    if (ts.isNumericLiteral(e)) return { k: "number" };
    if (ts.isStringLiteral(e)) return { k: "string" };
    if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return { k: "boolean" };
    if (ts.isArrayLiteralExpression(e)) return { k: "array", of: U };
    return U;
  }

  /** Property names read from an untyped parameter anywhere in the function body. */
  function accessedKeys(fn: ts.SignatureDeclarationBase & { body?: ts.Node }, pname: string): string[] {
    const keys = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === pname) keys.add(n.name.text);
      else if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === pname && ts.isStringLiteralLike(n.argumentExpression)) keys.add(n.argumentExpression.text);
      else if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && ts.isIdentifier(n.initializer) && n.initializer.text === pname) {
        for (const el of n.name.elements) if (!el.dotDotDotToken) keys.add(((el.propertyName ?? el.name) as ts.Identifier).text);
      }
      ts.forEachChild(n, visit);
    };
    if (fn.body) visit(fn.body);
    // members of built-in strings, arrays and numbers are not option keys
    for (const k of "length push pop shift unshift map filter slice splice join split trim trimStart trimEnd replace replaceAll toString toLowerCase toUpperCase toLocaleLowerCase toLocaleUpperCase includes indexOf lastIndexOf startsWith endsWith padStart padEnd charAt charCodeAt codePointAt normalize match matchAll concat reduce forEach some every find findIndex flat hasOwnProperty toFixed toPrecision localeCompare substring substr repeat at sort reverse keys values entries".split(" ")) keys.delete(k);
    return [...keys].slice(0, 12);
  }

  /** Guess "number" / "string" for an untyped parameter from how the body uses it. */
  function usageKind(fn: ts.SignatureDeclarationBase & { body?: ts.Node }, pname: string): "number" | "string" | undefined {
    let num = 0;
    let str = 0;
    const isP = (e: ts.Node | undefined) => !!e && ts.isIdentifier(e) && e.text === pname;
    const STR_METHODS = new Set(["trim", "replace", "replaceAll", "split", "toLowerCase", "toUpperCase", "charAt", "startsWith", "endsWith", "padStart", "padEnd", "normalize", "match", "localeCompare", "codePointAt", "charCodeAt", "substring", "substr", "includes", "indexOf", "slice"]);
    const visit = (n: ts.Node) => {
      if (ts.isBinaryExpression(n)) {
        const k = n.operatorToken.kind;
        const arith = [ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.AsteriskAsteriskToken];
        if (arith.includes(k) && (isP(n.left) || isP(n.right))) num++;
      }
      if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && isP(n.operand)) num++;
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText();
        if (/^(Math\.\w+|Number\.\w+|Number|parseFloat|parseInt|isFinite|isNaN|BigInt)$/.test(callee) && n.arguments.some(isP)) num++;
        if (ts.isPropertyAccessExpression(n.expression) && isP(n.expression.expression) && STR_METHODS.has(n.expression.name.text)) str++;
      }
      if (ts.isTypeOfExpression(n) && isP(n.expression)) {
        const par = n.parent;
        if (par && ts.isBinaryExpression(par) && ts.isStringLiteral(par.right)) {
          if (par.right.text === "number") num += 2;
          if (par.right.text === "string") str += 2;
        }
      }
      ts.forEachChild(n, visit);
    };
    if (fn.body) visit(fn.body);
    return num > str ? "number" : str > num ? "string" : undefined;
  }

  function sigOf(name: string, fn: ts.SignatureDeclarationBase): FnSig {
    const params: ParamInfo[] = fn.parameters.map((p, i) => {
      const pname = ts.isIdentifier(p.name) ? p.name.text : `arg${i}`;
      let shape = p.type ? toShape(p.type) : inferFromInit(p.initializer);
      if (!p.type && shape.k === "unknown" && ts.isIdentifier(p.name) && !p.dotDotDotToken) {
        const keys = accessedKeys(fn, pname);
        if (keys.length && (i > 0 || fn.parameters.length === 1)) shape = { k: "options", keys };
        else {
          const kind = usageKind(fn, pname);
          // keep a few wrong-type probes so type-check branches are still reached
          if (kind === "number") shape = { k: "union", of: [{ k: "number" }, { k: "literal", values: [NaN, Infinity, "abc", null] }] };
          else if (kind === "string") shape = { k: "union", of: [{ k: "string" }, { k: "literal", values: [42, null] }] };
        }
      }
      return { name: pname, optional: !!p.questionToken || !!p.initializer, rest: !!p.dotDotDotToken, shape };
    });
    return { name, params };
  }

  const sigs = new Map<string, FnSig>();
  const sources = new Map<string, string>();
  const clip = (t: string) => (t.length > 6000 ? t.slice(0, 6000) + "\n// ...truncated" : t);
  const isDefault = (s: ts.Node) =>
    ts.canHaveModifiers(s) && !!ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s)) {
      if (s.name) (sigs.set(s.name.text, sigOf(s.name.text, s)), sources.set(s.name.text, clip(s.getText())));
      if (isDefault(s)) (sigs.set("default", sigOf("default", s)), sources.set("default", clip(s.getText())));
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          sigs.set(d.name.text, sigOf(d.name.text, d.initializer));
          sources.set(d.name.text, clip(s.getText()));
        }
      }
    } else if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // CommonJS: module.exports = fn   /   module.exports.name = fn   /   exports.name = fn
      const { left, right } = s.expression;
      const target = left.getText();
      const fnNode = ts.isArrowFunction(right) || ts.isFunctionExpression(right) ? right : undefined;
      if (fnNode) {
        const nm = target === "module.exports" ? "default" : target.replace(/^(module\.)?exports\./, "");
        if (target === "module.exports" || /^(module\.)?exports\.\w+$/.test(target)) (sigs.set(nm, sigOf(nm, fnNode)), sources.set(nm, clip(s.getText())));
      } else if (target === "module.exports" && ts.isIdentifier(right) && sigs.has(right.text)) {
        sigs.set("default", { ...sigs.get(right.text)!, name: "default" });
        sources.set("default", sources.get(right.text) ?? "");
      }
    } else if (ts.isExportAssignment(s)) {
      const e = s.expression;
      if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) (sigs.set("default", sigOf("default", e)), sources.set("default", clip(s.getText())));
      else if (ts.isIdentifier(e) && sigs.has(e.text)) (sigs.set("default", { ...sigs.get(e.text)!, name: "default" }), sources.set("default", sources.get(e.text) ?? ""));
    }
  }
  for (const s of sf.statements) {
    if (ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause)) {
      for (const el of s.exportClause.elements) {
        const local = (el.propertyName ?? el.name).text;
        if (sigs.has(local)) (sigs.set(el.name.text, { ...sigs.get(local)!, name: el.name.text }), sources.set(el.name.text, sources.get(local) ?? ""));
      }
    }
  }

  // Harvest literals as boundary-input candidates.
  const nums = new Set<number>();
  const strs = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isNumericLiteral(n)) {
      const v = Number(n.text);
      if (Number.isFinite(v)) nums.add(v);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (n.text.length <= (lim.maxStringLength ?? 40)) strs.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { sigs, sources, numbers: [...nums].slice(0, lim.maxNumbers ?? 40), strings: [...strs].slice(0, lim.maxStrings ?? 30) };
}
