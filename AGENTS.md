- always use `vp run check` and `vp run build`.
- do not touch vite.config.ts!
- always use typescript v6, for now.

# Product design

Triad should feel like a precise identity instrument, not a generic software dashboard. Its visual language combines editorial confidence with protocol-level clarity: large statements explain the promise, structured ledgers expose the data, and a restrained signal color marks the parts that matter.

## Establish a strong hierarchy

- Lead each page with one unmistakable idea. Use a small technical eyebrow, an oversized display statement, and a concise supporting explanation.
- Let headings behave like editorial composition rather than ordinary UI labels. Deliberate line breaks, tight leading, and strong contrast should create rhythm without sacrificing comprehension.
- Keep supporting copy quieter and narrower than the headline. The eye should encounter promise, explanation, evidence, then action in that order.
- Give protocol results and identity values their own hierarchy. Labels, values, explanations, metadata, and actions must not compete at the same visual weight.
- Use generous vertical space between major ideas and compact spacing inside one data relationship.

```html
<div class="section-heading">
  <h2>ASK FOR LESS.<br />REVEAL LESS.</h2>
  <p>Identity works without turning profile data into a permanent key.</p>
</div>
```

The heading carries the argument. The paragraph clarifies it; it does not repeat it.

## Use typography as structure

- Use the display face for promises, outcomes, section titles, and decisive status. Use the monospaced face for protocol language, controls, metadata, claims, and explanatory copy.
- Favor bold, tightly tracked display type and calm, highly legible monospaced text.
- Keep tiny uppercase labels purposeful. They should identify a category or state, never carry essential long-form information.
- Preserve readable body sizes. Small technical labels may be compact, but claim values and user-facing explanations must remain comfortably legible.
- Wrap identifiers and URLs safely without shrinking them into insignificance.
- Balance headings and pretty-wrap prose, but use explicit line breaks when the composition depends on a specific phrase boundary.

## Treat color as a signal

- Build from a near-black field, warm white text, restrained gray surfaces, and thin neutral rules.
- Reserve coral-orange for identity signals, verified states, selected controls, important values, and primary actions.
- Use secondary blue for keyboard focus and danger red only for destructive or failed states.
- Do not distribute accent color decoratively. A colored element must communicate state, priority, or identity.
- Keep contrast high and verify that muted text remains readable. Never rely on color alone to convey meaning.
- Avoid gradients, glass effects, soft shadows, and decorative glow. Depth comes from hierarchy, spacing, borders, and contrast.

## Expose the underlying system

- Present identity and protocol information as ledgers, manifests, tickets, and ordered flows rather than generic cards.
- Use hairline borders to reveal page structure. Borders should connect related regions and make the information architecture visible.
- Prefer square or nearly square corners. Components should feel engineered and direct, not soft or ornamental.
- Let real protocol vocabulary appear where it helps understanding: `pairwise_sub`, `account_sub`, `provider_sub`, PKCE, JWKS, issuer, and expiry.
- Pair technical names with plain explanations. Precision should make the product more understandable, not more exclusive.
- Show security and privacy properties as concrete data behavior, not as trust badges or vague claims.

```html
<dl class="claim-ledger">
  <div>
    <dt>pairwise_sub</dt>
    <dd>pws_9c0e...</dd>
    <p>Stable inside one app. Different client, different identifier.</p>
  </div>
</dl>
```

The label names the contract, the value demonstrates its shape, and the description explains its consequence.

## Write with confidence and restraint

- Use short declarative sentences and active verbs.
- Make the primary message memorable, then make the supporting copy exact.
- Avoid inflated marketing language, cute metaphors, and generic claims such as "seamless," "powerful," or "next-generation."
- Prefer concrete promises: what is shared, what is withheld, what changes per client, and what gets verified.
- Keep button labels decisive and specific: `APPROVE CONNECTION`, `RUN ANOTHER FLOW`, `SIGN OUT`.
- Use punctuation and capitalization consistently. Uppercase is a visual device for short labels and actions, not for paragraphs.

## Compose pages, do not assemble templates

- Give each major page a distinct composition suited to its job while preserving the same typography, palette, rules, and interaction language.
- Use asymmetry when it strengthens hierarchy: a large statement beside compact evidence, or a protocol example beside an ordered explanation.
- Avoid interchangeable dashboard grids, floating card collections, pill-heavy navigation, and repeated centered sections.
- Keep the number of visual primitives small. Recombine headings, ledgers, rules, status marks, code windows, and decisive buttons instead of inventing a new component for every section.
- Make whitespace carry structure. Empty space should separate arguments and create tension, not merely pad containers.
- Keep decoration subordinate to information. Every visible shape should frame content, indicate state, or guide reading.

## Make interaction states explicit

- Every asynchronous surface needs clear idle, working, success, failure, and recovery states.
- Disable controls only when the action is genuinely unavailable, and explain why nearby.
- Keep consent factual. List exactly what the client requests; do not present mandatory claims as optional controls.
- Separate verified claims from token metadata and follow-up actions so users can understand what was shared.
- Preserve keyboard focus, minimum touch targets, semantic elements, labels, live regions, and reduced-motion behavior.
- Motion should confirm a transition or active check. Keep it brief, restrained, and removable through reduced-motion preferences.

## Recompose for narrow screens

- Preserve hierarchy rather than scaling the desktop page down uniformly.
- Collapse multi-column ledgers into readable label-value-explanation sequences.
- Reduce headline sizes enough to preserve intentional line breaks and prevent isolated words.
- Stack actions and page regions when needed, while retaining clear borders and spacing between phases.
- Keep identifiers, code, and URLs wrap-safe at every width.
- Test the actual composition at mobile and desktop sizes; responsive correctness includes visual rhythm, not only the absence of overflow.

## Preserve the visual system

- Extend existing tokens and primitives before introducing new ones.
- Reuse the established black, white, gray, coral, blue, and red roles consistently.
- Review neighboring sections before changing a component. A local improvement must still belong to the whole page.
- Do not copy a fashionable layout or default component-library pattern into Triad. Derive the design from the page's message and data.
- Treat screenshots as evidence of hierarchy and composition problems, not merely pixel differences.
- When a design feels weak, strengthen the idea, contrast, grouping, or wording before adding decoration.

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
