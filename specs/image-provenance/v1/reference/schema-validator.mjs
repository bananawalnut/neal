/**
 * Small dependency-free evaluator for the JSON Schema keywords used by the
 * self-contained v1 schema. It exists so the diagnostic evaluator can validate
 * only root-reachable hostile objects instead of accepting malformed signed
 * bodies or letting unrelated bundle objects poison the selected root.
 */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isObject(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
}

const TCHAR = /^[!#$%&'*+.^_`|~0-9A-Za-z-]$/u;

function isOws(character) {
  return character === ' ' || character === '\t';
}

function isQdText(character) {
  const code = character.codePointAt(0);
  return character === '\t'
    || character === ' '
    || code === 0x21
    || (code >= 0x23 && code <= 0x5b)
    || (code >= 0x5d && code <= 0x7e)
    || (code >= 0x80 && code <= 0xff);
}

function isQuotedPairCharacter(character) {
  const code = character.codePointAt(0);
  return character === '\t' || character === ' '
    || (code >= 0x21 && code <= 0x7e)
    || (code >= 0x80 && code <= 0xff);
}

/** Exact RFC 9110 media-type/parameters grammar, without ambient field OWS. */
function isRfc9110MediaType(value) {
  let cursor = 0;
  const readToken = () => {
    const start = cursor;
    while (cursor < value.length && TCHAR.test(value[cursor])) cursor += 1;
    return cursor > start;
  };
  if (!readToken() || value[cursor] !== '/') return false;
  cursor += 1;
  if (!readToken()) return false;
  while (cursor < value.length) {
    while (cursor < value.length && isOws(value[cursor])) cursor += 1;
    if (value[cursor] !== ';') return false;
    cursor += 1;
    while (cursor < value.length && isOws(value[cursor])) cursor += 1;
    // RFC 9110 parameters permits an empty element after a semicolon.
    if (cursor === value.length || value[cursor] === ';') continue;
    if (!readToken() || value[cursor] !== '=') return false;
    cursor += 1;
    if (value[cursor] === '"') {
      cursor += 1;
      let closed = false;
      while (cursor < value.length) {
        const character = value[cursor];
        if (character === '"') {
          cursor += 1;
          closed = true;
          break;
        }
        if (character === '\\') {
          cursor += 1;
          if (cursor >= value.length || !isQuotedPairCharacter(value[cursor])) return false;
          cursor += 1;
        } else {
          if (!isQdText(character)) return false;
          cursor += 1;
        }
      }
      if (!closed) return false;
    } else if (!readToken()) {
      return false;
    }
  }
  return true;
}

function isRfc3339DateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (month < 1 || month > 12
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= monthLengths[month - 1];
}

export function createSchemaValidator(rootSchema) {
  function resolve(ref) {
    if (!ref.startsWith('#/')) throw new TypeError(`Only local schema refs are supported: ${ref}`);
    return ref.slice(2).split('/').reduce((value, token) => (
      value[token.replaceAll('~1', '/').replaceAll('~0', '~')]
    ), rootSchema);
  }

  function evaluate(schema, value, path) {
    if (schema === true) return { errors: [], evaluated: new Set() };
    if (schema === false) return { errors: [`${path} is forbidden`], evaluated: new Set() };
    if (!isObject(schema)) return { errors: [`${path} has an invalid schema`], evaluated: new Set() };

    const errors = [];
    const evaluated = new Set();
    if (schema.$ref) {
      const result = evaluate(resolve(schema.$ref), value, path);
      errors.push(...result.errors);
      for (const key of result.evaluated) evaluated.add(key);
    }
    if (Array.isArray(schema.allOf)) {
      for (const branch of schema.allOf) {
        const result = evaluate(branch, value, path);
        errors.push(...result.errors);
        for (const key of result.evaluated) evaluated.add(key);
      }
    }
    if (Array.isArray(schema.oneOf)) {
      const results = schema.oneOf.map((branch) => evaluate(branch, value, path));
      const valid = results.filter((result) => result.errors.length === 0);
      if (valid.length !== 1) errors.push(`${path} must match exactly one schema variant`);
      if (valid.length === 1) {
        for (const key of valid[0].evaluated) evaluated.add(key);
      }
    }
    if (schema.not !== undefined && evaluate(schema.not, value, path).errors.length === 0) {
      errors.push(`${path} matches a forbidden schema`);
    }
    if (schema.type && !typeMatches(value, schema.type)) {
      errors.push(`${path} must be ${schema.type}`);
      return { errors, evaluated };
    }
    if (schema.const !== undefined && stable(value) !== stable(schema.const)) {
      errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((item) => stable(item) === stable(value))) {
      errors.push(`${path} is outside its enum`);
    }

    if (typeof value === 'string') {
      if (schema.minLength !== undefined && [...value].length < schema.minLength) {
        errors.push(`${path} is shorter than ${schema.minLength}`);
      }
      if (schema.maxLength !== undefined && [...value].length > schema.maxLength) {
        errors.push(`${path} is longer than ${schema.maxLength}`);
      }
      if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
        errors.push(`${path} does not match its lexical pattern`);
      }
      if (schema['x-loom-format'] === 'rfc9110-media-type' && !isRfc9110MediaType(value)) {
        errors.push(`${path} is not an RFC 9110 media type`);
      }
      if (schema.format === 'date-time' && !isRfc3339DateTime(value)) {
        errors.push(`${path} is not a parseable date-time`);
      }
      if (schema.format === 'uri') {
        try { new URL(value); } catch { errors.push(`${path} is not an absolute URI`); }
      }
    }

    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${path} has fewer than ${schema.minItems} items`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${path} has more than ${schema.maxItems} items`);
      }
      if (schema.uniqueItems && new Set(value.map(stable)).size !== value.length) {
        errors.push(`${path} contains duplicate items`);
      }
      if (schema.items !== undefined) {
        value.forEach((item, index) => {
          errors.push(...evaluate(schema.items, item, `${path}[${index}]`).errors);
        });
      }
    }

    if (isObject(value)) {
      const properties = isObject(schema.properties) ? schema.properties : {};
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
      }
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key)) continue;
        evaluated.add(key);
        errors.push(...evaluate(propertySchema, value[key], `${path}.${key}`).errors);
      }
      if (schema.propertyNames !== undefined) {
        for (const key of Object.keys(value)) {
          errors.push(...evaluate(schema.propertyNames, key, `${path} key ${JSON.stringify(key)}`).errors);
        }
      }
      const extras = Object.keys(value).filter((key) => !Object.hasOwn(properties, key));
      if (schema.additionalProperties === false) {
        for (const key of extras) errors.push(`${path}.${key} is not allowed`);
      } else if (isObject(schema.additionalProperties) || typeof schema.additionalProperties === 'boolean') {
        for (const key of extras) {
          evaluated.add(key);
          errors.push(...evaluate(schema.additionalProperties, value[key], `${path}.${key}`).errors);
        }
      }
      if (schema.unevaluatedProperties === false) {
        for (const key of Object.keys(value)) {
          if (!evaluated.has(key)) errors.push(`${path}.${key} is not allowed`);
        }
      }
    }
    return { errors, evaluated };
  }

  return function validate(ref, value) {
    const result = evaluate(resolve(ref), value, '$');
    return { valid: result.errors.length === 0, errors: result.errors };
  };
}
