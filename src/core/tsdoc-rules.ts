import { Node, JSDoc, ParameterDeclaration } from "ts-morph";

import type { DocumentableNode } from "./analyze";
import type { Violation } from "./types";

/**
 * Inputs available to the "is this TSDoc incomplete?" predicate.
 */
export interface TsDocCheckContext {
  node: DocumentableNode;
  jsDocs: JSDoc[];
  kind: Violation["kind"];
}

/**
 * Returns `true` if the symbol's TSDoc is missing or incomplete.
 *
 * Rules (Option C — tag-aware structural check):
 *  1. No JSDoc block at all → incomplete.
 *  2. Empty / whitespace-only description → incomplete.
 *  3. Functions & methods: every non-underscore parameter needs a `@param`
 *     whose name matches, and a non-empty comment.
 *  4. Functions & methods returning anything other than `void` / `Promise<void>`
 *     need a `@returns` with a non-empty comment.
 *  5. Classes, interfaces, type-aliases: description only (per design decision).
 *
 * Prose quality is explicitly not evaluated — that's scope for a future version.
 */
export function isTsDocIncomplete(ctx: TsDocCheckContext): boolean {
  const doc = ctx.jsDocs[0];
  if (!doc) return true;
  if (!doc.getDescription().trim()) return true;

  if (ctx.kind === "function" || ctx.kind === "method") {
    const tags = doc.getTags();
    const paramTags = new Map<string, string>();
    let returnsTag: string | undefined;
    for (const tag of tags) {
      const name = tag.getTagName();
      const comment = (tag.getCommentText() ?? "").trim();
      if (name === "param") {
        const paramName = extractParamName(tag.getText());
        if (paramName) paramTags.set(paramName, comment);
      } else if (name === "returns" || name === "return") {
        returnsTag = comment;
      }
    }

    const params = getParams(ctx.node) ?? [];
    for (const p of params) {
      const pname = p.getName();
      if (pname.startsWith("_")) continue; // convention: intentionally ignored
      const comment = paramTags.get(pname);
      if (comment === undefined || comment === "") return true;
    }

    if (needsReturnsTag(ctx.node)) {
      if (returnsTag === undefined || returnsTag === "") return true;
    }
  }

  return false;
}

/**
 * Pulls the parameter name out of a raw `@param foo - description` tag string.
 * ts-morph doesn't expose a `getName()` on JSDocTag (only on `JSDocParameterTag`),
 * and narrowing to that subtype is fiddly across versions, so we parse.
 */
function extractParamName(rawTag: string): string | undefined {
  // Optional `{type}` block, then the identifier. Non-greedy on the type so a
  // plain `@param foo - desc` (no braces) doesn't swallow `foo`.
  const match = rawTag.match(/@param\s+(?:\{[^}]*\}\s*)?(\[?[A-Za-z_$][\w$]*)/);
  if (!match) return undefined;
  return match[1].replace(/^\[/, ""); // optional-param syntax `[foo]`
}

function needsReturnsTag(node: DocumentableNode): boolean {
  if (!Node.isFunctionDeclaration(node) && !Node.isMethodDeclaration(node)) {
    return false;
  }
  const ret = node.getReturnType().getText();
  return ret !== "void" && ret !== "Promise<void>";
}

/**
 * Returns the parameters of a function-like node, or `undefined` for kinds
 * that don't take parameters (interfaces, type-aliases, classes).
 */
export function getParams(
  node: DocumentableNode,
): ParameterDeclaration[] | undefined {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
    return node.getParameters();
  }
  return undefined;
}
