# vault

Shelved UI. Nothing here is reachable from the running app — `App.tsx` no longer imports it, so vite drops it
from the bundle — but it still typechecks, so it does not rot while it waits.

- `lenses/Graph.tsx`, `lenses/GraphView.tsx` — the force/tree node-graph visualiser. Vaulted because it was more
  distraction than help: at realistic node counts its labels collide, and the tree in the left pane answers
  "where am I" better. Its unresolved issue is label placement on a crowded level, not the fit maths.
- `lenses/Flow.tsx` — call-tree lens over the structure index.
- `lenses/Queue.tsx`, `Verify.tsx`, `Orphans.tsx`, `Runs.tsx`, `Propose.tsx`, `Stage.tsx` — workflow lenses.
  These are closest to being worth restoring; each is a list the right pane could host as a tab.

To bring one back: import it from `App.tsx` and give it somewhere to render. They read the same zustand store,
so nothing else needs changing.
