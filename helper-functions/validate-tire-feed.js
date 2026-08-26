#!/usr/bin/env node
/**
 * Validates a built Walmart MP_ITEM tire feed (or a bare Orderable/Visible.Tires
 * item, or an array of them) against the REAL downloaded schema in _raw.json --
 * not a hand-copied summary of it. Reads the schema's actual `required`,
 * `type`/`enum`/`minLength`/`maxLength`/`minimum`/`maximum`/`minItems`/`maxItems`,
 * `additionalProperties`, custom `comments` annotations (e.g.
 * "@minimumWordCount=60" on shortDescription), and the real `allOf`/`if`/`then`
 * conditional-requirement rules (e.g. tireType containing certain values ->
 * constructionType/tireAspectRatio/tireLoadIndex/tireSpeedRating/
 * uniformTireQualityGrade become required; vehicleType -> tireTreadwearRating/
 * mileageWarranty; isProp65WarningRequired="Yes" -> prop65WarningText;
 * has_written_warranty -> warrantyText/warrantyURL) directly out of the schema
 * file, so this stays correct if Walmart ever changes those rules rather than
 * needing to be manually kept in sync with them.
 *
 * No external dependencies (no ajv/etc.) -- self-contained, same "no lib/
 * dependencies" convention as this project's SuiteScript files, and safely
 * runnable anywhere Node is available without an install step.
 *
 * Usage:
 *   node validate-tire-feed.js <path-to-feed-or-item.json>
 *
 * Accepts any of:
 *   - a full feed envelope: { MPItemFeedHeader: {...}, MPItem: [ {Orderable, Visible:{Tires}}, ... ] }
 *   - a bare array of items: [ {Orderable, Visible:{Tires}}, ... ]
 *   - a single item: { Orderable, Visible: { Tires } }
 *
 * Exits 0 if every item passes, 1 if any violation is found (so this can be
 * used as a pass/fail check in a script, not just eyeballed).
 */
const fs = require('fs');
const path = require('path');

const raw = require(path.join(__dirname, '_raw.json'));
const feedHeaderSchema = raw.schema.properties.MPItemFeedHeader;
const orderableSchema = raw.schema.properties.MPItem.items.properties.Orderable;
const tiresSchema = raw.schema.properties.MPItem.items.properties.Visible.properties.Tires;

/** Same semantics as this project's SuiteScript isBlank() helpers -- keeps "required" checks consistent with how the rest of the codebase judges presence. */
function isBlank(value) {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
}

function actualType(value) {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
}

function checkType(value, expectedType) {
    if (expectedType === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (expectedType === 'number') return typeof value === 'number';
    return actualType(value) === expectedType;
}

function wordCount(str) {
    return String(str).trim().split(/\s+/).filter(Boolean).length;
}

/** Parses Walmart's custom "@key=value;@key2=value2" comments string into an object. */
function parseAnnotations(comments) {
    const result = {};
    if (!comments) return result;
    comments.split(';').forEach((part) => {
        const m = part.match(/^@(\w+)=(.+)$/);
        if (m) result[m[1]] = m[2];
    });
    return result;
}

/**
 * Evaluates whether `instance` satisfies an `if` condition schema, in the
 * shape Walmart's real allOf/if blocks actually use: `{properties: {key:
 * {type, enum} | {type:'array', contains:{enum}}}, required: [...]}`, or an
 * `anyOf`/`allOf` of such blocks.
 */
function matchesCondition(instance, condSchema) {
    if (condSchema.anyOf) return condSchema.anyOf.some((sub) => matchesCondition(instance, sub));
    if (condSchema.allOf) return condSchema.allOf.every((sub) => matchesCondition(instance, sub));

    const required = condSchema.required || [];
    if (required.some((key) => isBlank(instance[key]))) return false;

    const props = condSchema.properties || {};
    return Object.keys(props).every((key) => {
        const propCond = props[key];
        const value = instance[key];
        if (value === undefined) return false;
        if (propCond.type === 'array' && propCond.contains) {
            return Array.isArray(value) && (!propCond.contains.enum
                || value.some((v) => propCond.contains.enum.includes(v)));
        }
        return !propCond.enum || propCond.enum.includes(value);
    });
}

/**
 * Recursively validates `instance` against `schema`, appending human-readable
 * violation strings to `errors`. Handles the subset of JSON Schema draft-07
 * this feed's schema actually uses: type, enum, minLength/maxLength,
 * minimum/maximum, minItems/maxItems, items, properties/required,
 * additionalProperties:false, allOf/if/then conditional requirements, and
 * Walmart's custom comments-based @minimumWordCount annotation.
 */
function validate(instance, schema, fieldPath, errors) {
    if (isBlank(instance)) {
        if (schema.type) errors.push(`${fieldPath}: missing`);
        return;
    }

    const expectedType = schema.type;
    if (expectedType && !checkType(instance, expectedType)) {
        errors.push(`${fieldPath}: expected type "${expectedType}", got "${actualType(instance)}" (value=${JSON.stringify(instance)})`);
        return; // further constraints are meaningless if the type itself is wrong
    }

    if (schema.enum && !schema.enum.includes(instance)) {
        const shown = schema.enum.length > 10
            ? `${JSON.stringify(schema.enum.slice(0, 10))} ... (${schema.enum.length} total allowed values)`
            : JSON.stringify(schema.enum);
        errors.push(`${fieldPath}: value ${JSON.stringify(instance)} is not one of the allowed enum values (${shown})`);
    }

    if (expectedType === 'string') {
        if (schema.minLength !== undefined && instance.length < schema.minLength) {
            errors.push(`${fieldPath}: string length ${instance.length} is below minLength ${schema.minLength}`);
        }
        if (schema.maxLength !== undefined && instance.length > schema.maxLength) {
            errors.push(`${fieldPath}: string length ${instance.length} exceeds maxLength ${schema.maxLength}`);
        }
        const annotations = parseAnnotations(schema.comments);
        if (annotations.minimumWordCount) {
            const min = parseInt(annotations.minimumWordCount, 10);
            const wc = wordCount(instance);
            if (wc < min) errors.push(`${fieldPath}: word count ${wc} is below the required @minimumWordCount of ${min}`);
        }
    }

    if (expectedType === 'number' || expectedType === 'integer') {
        if (schema.minimum !== undefined && instance < schema.minimum) {
            errors.push(`${fieldPath}: value ${instance} is below minimum ${schema.minimum}`);
        }
        if (schema.maximum !== undefined && instance > schema.maximum) {
            errors.push(`${fieldPath}: value ${instance} exceeds maximum ${schema.maximum}`);
        }
    }

    if (expectedType === 'array') {
        if (schema.minItems !== undefined && instance.length < schema.minItems) {
            errors.push(`${fieldPath}: array has ${instance.length} item(s), below minItems ${schema.minItems}`);
        }
        if (schema.maxItems !== undefined && instance.length > schema.maxItems) {
            errors.push(`${fieldPath}: array has ${instance.length} item(s), exceeds maxItems ${schema.maxItems}`);
        }
        if (schema.items) {
            instance.forEach((item, i) => validate(item, schema.items, `${fieldPath}[${i}]`, errors));
        }
    }

    if (expectedType === 'object' && schema.properties) {
        (schema.required || []).forEach((key) => {
            if (isBlank(instance[key])) errors.push(`${fieldPath}.${key}: required field is missing/blank`);
        });

        if (schema.additionalProperties === false) {
            Object.keys(instance).forEach((key) => {
                if (!schema.properties[key]) {
                    errors.push(`${fieldPath}.${key}: field is not defined in the schema (additionalProperties: false)`);
                }
            });
        }

        Object.keys(instance).forEach((key) => {
            if (schema.properties[key]) validate(instance[key], schema.properties[key], `${fieldPath}.${key}`, errors);
        });

        (schema.allOf || []).forEach((rule) => {
            if (rule.if && rule.then && rule.then.required && matchesCondition(instance, rule.if)) {
                rule.then.required.forEach((key) => {
                    if (isBlank(instance[key])) {
                        errors.push(`${fieldPath}.${key}: conditionally required (trigger condition met) but missing/blank`);
                    }
                });
            }
        });
    }
}

function main() {
    const inputPath = process.argv[2];
    if (!inputPath) {
        console.error('Usage: node validate-tire-feed.js <path-to-feed-or-item.json>');
        process.exit(1);
    }

    const parsed = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), inputPath), 'utf8'));

    let items;
    if (Array.isArray(parsed.MPItem)) items = parsed.MPItem;
    else if (Array.isArray(parsed)) items = parsed;
    else items = [parsed];

    let totalErrors = 0;

    if (parsed.MPItemFeedHeader) {
        const headerErrors = [];
        validate(parsed.MPItemFeedHeader, feedHeaderSchema, 'MPItemFeedHeader', headerErrors);
        if (headerErrors.length) {
            console.log(`FAIL  MPItemFeedHeader (${headerErrors.length} issue(s))`);
            headerErrors.forEach((e) => console.log(`  - ${e}`));
        } else {
            console.log('PASS  MPItemFeedHeader');
        }
        totalErrors += headerErrors.length;
    }

    items.forEach((item, i) => {
        const label = (item.Orderable && item.Orderable.sku) || `item[${i}]`;
        const errors = [];
        validate(item.Orderable, orderableSchema, `${label}.Orderable`, errors);
        validate(item.Visible && item.Visible.Tires, tiresSchema, `${label}.Visible.Tires`, errors);

        if (errors.length === 0) {
            console.log(`PASS  ${label}`);
        } else {
            console.log(`FAIL  ${label} (${errors.length} issue(s))`);
            errors.forEach((e) => console.log(`  - ${e}`));
        }
        totalErrors += errors.length;
    });

    console.log('');
    console.log(`${items.length} item(s) checked, ${totalErrors} total issue(s).`);
    process.exit(totalErrors > 0 ? 1 : 0);
}

main();
