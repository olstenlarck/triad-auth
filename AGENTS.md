---
name: clean-code
description: Use when writing, refactoring, or reviewing code for readability, maintainability, clarity, naming, structure, and simplicity in any language or project.
---

# Clean code

- Prefer clear, unsurprising code over clever or compressed code.
- Use descriptive names that communicate intent without explanatory comments.
- Keep functions focused on one responsibility and small enough to understand quickly.
- Use early returns to reduce nesting and make invalid states obvious.
- Separate setup, decisions, side effects, and return values with intentional whitespace.
- Add a blank line before a return when it separates the result from preceding work.
- Avoid one-line implementations when multiple statements express the logic more clearly.
- Extract repeated logic only when the extracted abstraction has a meaningful name.
- Keep related behavior close together and unrelated concerns in separate modules.
- Prefer explicit data shapes and narrow types over unstructured values.
- Handle errors at the boundary where useful context is available.
- Remove dead code, stale comments, redundant wrappers, and accidental complexity.
- Preserve existing behavior while refactoring unless behavior changes are explicitly requested.
- Match the established style of the surrounding code unless that style is the problem being fixed.
- Use lowercase Conventional Commit subjects, for example `chore: initial`.
