---
"zagora": patch
---

Fix four defects from the review of the zagora migration. A callable no longer exposes the configured env values through `~zagora`. The cache key includes an ID for each handler function, so procedures with the same handler source no longer share cache entries. The cache stores a handler result only after it passes output validation. The `SpreadTuple` type makes only the trailing elements that accept `undefined` optional, so required tuple arguments stay required.
