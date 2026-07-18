// Render-tier cap constants - the single source of truth for how much the
// renderer will ever draw. Each cap must trip its truncation banner before the
// corresponding view degrades. See spec 2026-07-02-anubee-desktop-design.md s5.1
// (filter-first + hard slice cap). Values validated against a real 245k-event
// run (both banners observed to fire); see BACKLOG "Shipped this session".

// Max NODES in a focused graph slice before cytoscape/ELK hairballs. Edges are
// not capped separately: every edge among surviving nodes renders, so a node's
// backtrace never fragments on canvas (see capSlice). The node cap is the sole
// hairball guard - the layered java->native->syscall graph is sparse, so edge
// count tracks node count. Real run: heaviest focused subgraph = 152; whole-bridge
// slice = 2156 nodes+edges. 1500 nodes is a safety ceiling below the ~2-3k
// readability threshold - the per-row focused path never reaches it.
export const GRAPH_SLICE_CAP = 1500

// Max distinct stack chains pulled for the flame view (bounds the IPC payload).
// Real run: 3096 distinct chains unfiltered - under this cap (headroom for a
// busier run; this is the IPC-payload guard, not the primary render cap).
export const FLAME_CHAIN_CAP = 5000

// Max tree nodes the flame SVG will build before the icicle degrades. Real run:
// 12,347 tree nodes unfiltered -> truncates here (banner fires); 2000 rects is
// the readable icicle ceiling.
export const FLAME_NODE_CAP = 2000
