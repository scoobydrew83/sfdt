import { z, type ZodTypeAny } from 'zod';
export interface Field<T> {
  node: HTMLElement;
  getValue: () => T;
}
export function buildField<T>(schema: ZodTypeAny, initial: T): Field<T> {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    const inner = (schema._def as { innerType?: ZodTypeAny; schema?: ZodTypeAny }).innerType
      ?? (schema._def as { schema?: ZodTypeAny }).schema;
    if (inner) return buildField(inner, initial);
  }
  if (schema instanceof z.ZodBoolean) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(initial);
    return {
      node: input,
      getValue: () => input.checked as unknown as T,
    };
  }
  if (schema instanceof z.ZodString) {
    const input = document.createElement('input');
    const looksHex =
      typeof initial === 'string' && initial.length === 7 && initial.startsWith('#');
    input.type = looksHex ? 'color' : 'text';
    input.value = typeof initial === 'string' ? initial : '';
    return {
      node: input,
      getValue: () => input.value as unknown as T,
    };
  }
  if (schema instanceof z.ZodNumber) {
    const input = document.createElement('input');
    input.type = 'number';
    input.value = typeof initial === 'number' ? String(initial) : '';
    return {
      node: input,
      getValue: () => Number(input.value) as unknown as T,
    };
  }
  if (schema instanceof z.ZodEnum) {
    const select = document.createElement('select');
    const values = (schema._def as { values: readonly string[] }).values;
    for (const v of values) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      if (v === initial) opt.selected = true;
      select.appendChild(opt);
    }
    return {
      node: select,
      getValue: () => select.value as unknown as T,
    };
  }
  if (schema instanceof z.ZodObject) {
    const fieldset = document.createElement('fieldset');
    fieldset.style.border = '0';
    fieldset.style.padding = '0';
    const shape = (schema._def as { shape: () => Record<string, ZodTypeAny> }).shape();
    const children: Record<string, Field<unknown>> = {};
    for (const [key, childSchema] of Object.entries(shape)) {
      const childInitial =
        initial && typeof initial === 'object'
          ? (initial as Record<string, unknown>)[key]
          : undefined;
      const child = buildField<unknown>(childSchema, childInitial);
      children[key] = child;
      const label = document.createElement('label');
      label.style.display = 'block';
      label.style.padding = '4px 0';
      const span = document.createElement('span');
      span.textContent = key;
      span.style.marginRight = '8px';
      label.appendChild(span);
      label.appendChild(child.node);
      fieldset.appendChild(label);
    }
    return {
      node: fieldset,
      getValue: () => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(children)) out[k] = v.getValue();
        return out as unknown as T;
      },
    };
  }
  const typeName = (schema._def as { typeName?: string }).typeName ?? 'unknown';
  throw new Error(`Unsupported zod type for DOM rendering: ${typeName}`);
}
