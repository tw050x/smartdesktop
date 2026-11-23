// The part of JSON Schema a contract's shapes use, checked with no dependencies: types, enum and
// const, objects (properties, required, additionalProperties), arrays (items, minItems, maxItems),
// strings (minLength, maxLength, pattern, a few formats), numbers (minimum, maximum and their
// exclusive forms, multipleOf), allOf, anyOf, oneOf and not, and $ref: "#/$defs/x" within a shape,
// or another shape by its id (so Order can say its items are LineItem). Unknown keywords are left
// alone, as JSON Schema says. Gives the first thing that doesn't fit, with where it is, or null.

const FORMATS = {
  'date-time': (value) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)),
  date: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)),
  email: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  uri: (value) => { try { new URL(value); return true; } catch { return false; } },
  uuid: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
};

const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
};
const isType = (value, type) => type === 'number' ? typeof value === 'number' : typeOf(value) === type;

function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => same(a[key], b[key]));
}

const show = (value) => {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 60 ? `${text.slice(0, 57)}…` : text;
};
export const pathText = (path) => path.reduce((text, step) => typeof step === 'number' ? `${text}[${step}]` : `${text}${text ? '.' : ''}${step}`, '');

// `shapes`, the contract's shapes by id, for a $ref to another; `root`, the shape a "#/…" ref is in.
export function validate(value, schema, { shapes = {}, path = [], root = schema, seen = 0 } = {}) {
  if (schema === true || schema === undefined) return null;
  if (schema === false) return { path, message: 'should not be there' };
  const at = (message) => ({ path, message });
  const sub = (one, subSchema, subPath, subRoot = root) => validate(one, subSchema, { shapes, path: subPath, root: subRoot, seen: seen + 1 });

  if (seen > 200) return at('goes on too deep (a $ref that leads back to itself?)');
  if (schema.$ref !== undefined) {
    const ref = schema.$ref;
    let target;
    let targetRoot = root;
    if (ref.startsWith('#')) {
      target = ref === '#' ? root : ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((one, key) => one?.[key], root);
    } else if (shapes[ref]) {
      target = shapes[ref];
      targetRoot = target;
    }
    if (target === undefined) return at(`refers to ${ref}, which isn't a shape`);
    const found = sub(value, target, path, targetRoot);
    if (found) return found;
  }

  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((type) => isType(value, type))) return at(`should be ${types.map((type) => (/^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`)).join(' or ')}, not ${typeOf(value) === 'integer' ? 'a number' : `${/^[aeiou]/.test(typeOf(value)) ? 'an' : 'a'} ${typeOf(value)}`} (${show(value)})`);
  }
  if (schema.const !== undefined && !same(value, schema.const)) return at(`should be ${show(schema.const)}, not ${show(value)}`);
  if (schema.enum !== undefined && !schema.enum.some((one) => same(value, one))) return at(`should be one of ${schema.enum.map(show).join(', ')}, not ${show(value)}`);

  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) return at(`should be at least ${schema.minLength} characters, not ${length}`);
    if (schema.maxLength !== undefined && length > schema.maxLength) return at(`should be at most ${schema.maxLength} characters, not ${length}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) return at(`should match ${schema.pattern}, not ${show(value)}`);
    if (schema.format !== undefined && FORMATS[schema.format] && !FORMATS[schema.format](value)) return at(`should be ${/^[aeiou]/.test(schema.format) ? 'an' : 'a'} ${schema.format}, not ${show(value)}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return at(`should be at least ${schema.minimum}, not ${value}`);
    if (schema.maximum !== undefined && value > schema.maximum) return at(`should be at most ${schema.maximum}, not ${value}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return at(`should be more than ${schema.exclusiveMinimum}, not ${value}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return at(`should be less than ${schema.exclusiveMaximum}, not ${value}`);
    if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) return at(`should be a multiple of ${schema.multipleOf}, not ${value}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return at(`should have at least ${schema.minItems} ${schema.minItems === 1 ? 'item' : 'items'}, not ${value.length}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return at(`should have at most ${schema.maxItems} ${schema.maxItems === 1 ? 'item' : 'items'}, not ${value.length}`);
    if (schema.uniqueItems && value.some((one, index) => value.findIndex((other) => same(one, other)) !== index)) return at('should have no item twice');
    if (schema.items !== undefined && !Array.isArray(schema.items)) {
      for (const [index, one] of value.entries()) {
        const found = sub(one, schema.items, [...path, index]);
        if (found) return found;
      }
    }
  }
  if (typeOf(value) === 'object') {
    for (const name of schema.required ?? []) if (!(name in value)) return { path: [...path, name], message: 'is missing' };
    const properties = schema.properties ?? {};
    for (const [name, one] of Object.entries(value)) {
      if (name in properties) {
        const found = sub(one, properties[name], [...path, name]);
        if (found) return found;
      } else if (schema.additionalProperties === false) {
        return { path: [...path, name], message: 'isn\'t expected here' };
      } else if (typeof schema.additionalProperties === 'object') {
        const found = sub(one, schema.additionalProperties, [...path, name]);
        if (found) return found;
      }
    }
  }

  for (const one of schema.allOf ?? []) {
    const found = sub(value, one, path);
    if (found) return found;
  }
  if (schema.anyOf && !schema.anyOf.some((one) => !sub(value, one, path))) return at('fits none of the shapes it could be');
  if (schema.oneOf) {
    const fits = schema.oneOf.filter((one) => !sub(value, one, path)).length;
    if (fits !== 1) return at(fits ? `fits ${fits} of the shapes it could be, not exactly one` : 'fits none of the shapes it could be');
  }
  if (schema.not !== undefined && !sub(value, schema.not, path)) return at('fits what it shouldn\'t');
  return null;
}
