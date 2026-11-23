# Code in many languages

```js
// Fetch a note and render it
import { render } from "./render.js";
const MAX = 3, retries = [1, 2.5, 0x1f];
export async function load(path, { force = false } = {}) {
  const res = await fetch(`/api/notes/${path}?force=${force}`);
  if (!res.ok) throw new Error("failed: " + res.status);
  return res.json().then((note) => render(note, null, true));
}
class Note extends Base {
  constructor(title) { super(); this.title = title; }
}
```

```ts
interface Note { id: string; tags?: string[]; pinned: boolean }
type Id = number | string;
function first<T>(items: T[]): T | undefined {
  return items.length > 0 ? items[0] : undefined;
}
const notes: Note[] = [];
```

```python
import os
from pathlib import Path

def count_words(path: str, limit=10) -> int:
    """Count the words in a file."""
    text = Path(path).read_text()  # read it all
    if not text or len(text) > 1_000_000:
        return 0
    return sum(1 for word in text.split() if word)

class Library(object):
    def __init__(self, root=None):
        self.root = root or os.getcwd()
        print(f"library at {self.root}", True, None)
```

```bash
#!/usr/bin/env bash
set -euo pipefail
for f in "$HOME"/notes/*.md; do
  echo "file: $f" | grep -c note || true
done
export PATH="/usr/local/bin:$PATH"
```

```json
{
  "name": "markie",
  "version": 3,
  "private": true,
  "tags": ["notes", null, 1.5]
}
```

```css
.markdown-body pre > code:hover {
  color: #24292e;
  margin: 0 auto !important;
  font-size: 0.85em;
}
@media print { body { padding: 2cm; } }
```

```html
<!doctype html>
<div class="note" data-id="7">
  <a href="https://markiedocs.com">Markie</a>
  <!-- a comment -->
</div>
```

```yaml
name: Markie
version: 1.2
features:
  - notes
  - sync # comment
enabled: true
```

```rust
use std::collections::HashMap;

/// Counts words.
fn count(text: &str) -> usize {
    let mut seen: HashMap<String, u32> = HashMap::new();
    for word in text.split_whitespace() {
        *seen.entry(word.to_string()).or_insert(0) += 1;
    }
    println!("{} words", seen.len());
    seen.len()
}
```

```go
package main

import "fmt"

func main() {
	notes := []string{"a", "b"}
	for i, n := range notes {
		fmt.Println(i, n, len(n) > 0, nil)
	}
}
```

```sql
SELECT id, title FROM notes WHERE pinned = TRUE AND views > 10 ORDER BY title;
```
