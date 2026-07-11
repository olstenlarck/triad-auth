- always use `vp run check` and `vp run build`.
- do not touch vite.config.ts!
- always use typescript v6, for now.

# Clean code

> Use when writing, refactoring, or reviewing code for readability, maintainability, clarity, naming, structure, and simplicity in any language or project.

The code should read as a sequence of decisions and operations. Structure a function so a reader can scan its phases from top to bottom without mentally untangling unrelated work.

## Organize by purpose

- Give each function one clear responsibility.
- Order work as a natural timeline: receive input, validate it, load dependencies, perform the operation, then produce the result.
- Keep setup, decisions, side effects, and results in distinct blocks.
- Keep statements together when they form one small operation. Do not mechanically put a blank line after every declaration or every `if`.
- Put a blank line where the purpose changes, such as moving from validation to a database lookup, from preparation to a side effect, or from a completed side effect to the response.
- Keep related guards together when they validate the same concept. Separate the next guard when it starts validating a different concept.

```ts
const provider = parseProvider(value);
if (!provider) {
  return oauthError("invalid_request", "unsupported provider");
}
if (!enabledProviders(env).includes(provider)) {
  return oauthError("invalid_request", "provider unavailable");
}

const client = await getClient(db, clientId);
if (!client) {
  return oauthError("invalid_client");
}
```

The first two guards are one provider-validation phase. The client lookup begins a new phase, so it is separated.

## Keep cohesive work together

- Declare values close to the operation that uses them.
- Group declarations when they collectively prepare one operation.
- Do not interleave preparation for a later operation with current validation or side effects.
- Inside loops, separate each iteration phase: create input, derive data, attempt the operation, inspect its result, then handle fallback conditions.
- When building objects or DOM, group work by action: create the pieces, configure them, compose them, then attach the finished result.

```ts
const input = document.createElement("input");
input.type = "checkbox";
input.name = "granted-scope";
input.value = scope;
input.checked = true;
input.disabled = true;

const content = document.createElement("span");
content.className = "disclosure-copy";
content.appendChild(disclosureText(disclosure));

row.appendChild(input);
row.appendChild(content);

container.appendChild(row);
```

Do not mix element creation, configuration, composition, and insertion line by line. Each block should complete one level of the construction.

## Use whitespace as structure

- Blank lines communicate a semantic boundary, not a formatting ritual.
- Keep a declaration directly beside its immediate validation.
- Keep consecutive guards together when they enforce one invariant.
- Add a blank line after a completed guard phase before starting the next operation.
- Add a blank line before a final return when the return presents the result of preceding work.
- Do not add a blank line between tightly coupled statements merely because one is an `if`, assignment, or `await`.

```ts
const form = await parseOAuthForm(request);
if (form instanceof Response) {
  return form;
}

const duplicateError = rejectDuplicateParameters(form, ["csrf_token"]);
if (duplicateError) {
  return duplicateError;
}

return consumeValidatedForm(form);
```

Here each declaration and guard is a unit. The blank lines separate parsing, duplicate validation, and the final operation.

## Make control flow obvious

- Prefer early returns for invalid input, missing state, unavailable resources, and error cases.
- Keep the successful path at the lowest indentation level.
- Always use braces for control-flow bodies.
- Avoid `else` after a branch that returns or throws.
- Use descriptive error variables such as `originError`, `duplicateError`, and `authorizationError` so the guard explains itself.
- Validate unknown data at the boundary and narrow it before passing it deeper into the system.
- Handle errors where useful context can be added, but do not wrap errors only to restate them.

## Choose compact or expanded shapes deliberately

- Keep simple imports, function signatures, calls, arrays, and conditions on one line when they remain easy to scan.
- Do not vertically expand short syntax merely to make a file taller.
- Expand compound boolean conditions so each independent requirement is visible.
- Expand object literals when each property is meaningful data or when the object is a returned protocol shape.
- Expand argument lists when the arguments represent a long operation, have different roles, or align with a multiline SQL statement.
- Let fluent chains show their pipeline: keep the initial operation readable, indent chained transformations consistently, and place the terminal operation clearly.

```ts
const pairwiseSub = await pairwiseSubject(env.PAIRWISE_SECRET, accountId, clientId);

return {
  pairwiseSub,
  accountSub,
  providerSub,
  expiresAt,
};
```

The call is simple enough to remain on one line. The returned record is expanded because its fields are the result's semantic shape.

```ts
if (
  typeof payload.sub !== "string" ||
  typeof payload.account_sub !== "string" ||
  typeof payload.provider_sub !== "string"
) {
  throw new Error("invalid identity claims");
}
```

Do not compress a compound invariant into a dense line when one-condition-per-line makes auditing easier.

## Prefer direct, readable code

- Prefer clear, unsurprising code over clever, compressed, or overly abstract code.
- Use descriptive names that communicate intent without explanatory comments.
- Avoid one-line implementations when multiple statements better expose the operation's phases.
- Do not extract a helper solely to reduce line count. Extract repeated or conceptually independent logic only when the helper has a meaningful domain name.
- Keep related behavior close together and unrelated concerns in separate modules.
- Prefer explicit data shapes and narrow types over unstructured values.
- Keep constants, types, private helpers, and exported entry points in a predictable order.
- Use comments rarely. Explain a non-obvious constraint or reason, not what the next statement literally does.

## Preserve quality while changing code

- Preserve existing behavior while refactoring unless a behavior change is explicitly requested.
- Remove dead code, stale comments, redundant wrappers, and accidental complexity.
- Match the established structure of the surrounding code. When nearby code conflicts, follow the dominant phase-oriented style described here rather than copying an isolated inconsistency.
- Review the whole function after editing. A locally correct insertion may still belong in a different phase or require the surrounding blocks to be regrouped.
- Treat formatter output as a syntax baseline, not as a substitute for intentional structure. Formatting must preserve the semantic grouping described above.
- Use lowercase Conventional Commit subjects, for example `chore: initial`.
