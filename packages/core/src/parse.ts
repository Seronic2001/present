// Slide files: YAML frontmatter, then the finished drawing as XML-style markup.
// Parsed as data and never executed. Source positions are kept so ops can patch in place.
import { parseDocument as parseXml } from 'htmlparser2';
import { parse as parseYaml } from 'yaml';

export interface XNode {
  type: 'tag' | 'text' | 'comment' | 'directive';
  name?: string;
  attribs?: Record<string, string>;
  children?: XNode[];
  data?: string;
  parent?: XNode | null;
  startIndex?: number | null;
  endIndex?: number | null;
}

export interface ParsedSlide {
  front: Record<string, any>;
  frontEnd: number;     // offset of the first body character
  body: string;
  root: XNode;
  frontError?: string;
}

const VOID = new Set(['br', 'hr', 'img']);

export function parseMarkup(markup: string): XNode {
  return parseXml(markup, {
    xmlMode: true, recognizeSelfClosing: true, lowerCaseTags: false, lowerCaseAttributeNames: false,
    decodeEntities: false, withStartIndices: true, withEndIndices: true,
  }) as unknown as XNode;
}

export function splitFront(src: string): { yaml: string; bodyStart: number } {
  const s = src.replace(/^﻿/, '');
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return m ? { yaml: m[1], bodyStart: m[0].length } : { yaml: '', bodyStart: 0 };
}

export function parseSlide(src: string): ParsedSlide {
  const { yaml, bodyStart } = splitFront(src);
  let front: Record<string, any> = {}, frontError: string | undefined;
  try { front = (parseYaml(yaml) as any) ?? {}; } catch (e: any) { frontError = e.message; }
  const body = src.slice(bodyStart);
  return { front, frontEnd: bodyStart, body, root: parseMarkup(body), frontError };
}

export const attrStr = (a: Record<string, string>) =>
  Object.entries(a).map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('');

export function serialize(n: XNode): string {
  if (n.type === 'text') return n.data ?? '';
  if (n.type === 'comment' || n.type === 'directive') return '';
  const inner = (n.children ?? []).map(serialize).join('');
  if (!n.name) return inner;
  if (VOID.has(n.name)) return `<${n.name}${attrStr(n.attribs ?? {})}/>`;
  return `<${n.name}${attrStr(n.attribs ?? {})}>${inner}</${n.name}>`;
}

export function walk(n: XNode, fn: (el: XNode) => void) {
  if (n.type === 'tag') fn(n);
  for (const c of n.children ?? []) walk(c, fn);
}
export const textOf = (n: XNode): string => (n.type === 'text' ? n.data ?? '' : (n.children ?? []).map(textOf).join(''));
export const classes = (n: XNode) => (n.attribs?.class ?? '').split(/\s+/).filter(Boolean);
export function findById(root: XNode, id: string): XNode | null {
  let hit: XNode | null = null;
  walk(root, e => { if (!hit && e.attribs?.id === id) hit = e; });
  return hit;
}
