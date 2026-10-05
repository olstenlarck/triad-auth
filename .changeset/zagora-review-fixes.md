---
"zagora": patch
---

Fix defects from the review of the zagora migration. A callable no longer exposes the configured env values through `~zagora`. The cache stores only the validated output, so a failed call leaves nothing in the cache, and a cache hit returns the stored output without validating it again. The `SpreadTuple` type makes only the trailing elements that accept `undefined` optional, so required tuple arguments stay required.
