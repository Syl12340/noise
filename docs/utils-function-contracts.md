# Utils Function Contracts

## Scope
This document defines naming and documentation conventions for functions under `utils/`.

## Naming
- Prefer verb-first names for actions: `getX`, `setX`, `normalizeX`, `calculateX`, `estimateX`.
- Prefer explicit unit suffixes for numeric values: `Seconds`, `Hours`, `Db`, `Ms`.
- Boolean values should use `is/has/can/should` prefixes.

## Function Comment Template
Use this template for exported functions and critical internal functions:

```js
/**
 * One-line purpose statement.
 * @param {type} paramName Meaning and unit if applicable.
 * @param {type} optionalParam Optional behavior and fallback rule.
 * @returns {type} Return value semantics.
 * Side effect: Describe storage/network/state mutation if any.
 */
```

## Side-Effect Rules
- Read-only functions should explicitly state: `Side effect: none.`
- Storage writers should explicitly list keys affected.
- If a function normalizes invalid input, document fallback behavior.

## Risk Config Rules
- Threshold order must be strictly increasing.
- Locked risk segments must remain enabled after normalization.
- Legacy inputs must be normalized to current risk config shape.

## Review Checklist
- Function name conveys domain intent and unit.
- Params/returns are documented for exported APIs.
- Side effects are documented when present.
- No duplicated helper with same semantics across files.
