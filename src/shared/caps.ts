// Render-tier cap constants - the single source of truth for how much the
// renderer will ever draw. Tuned against a real busy run (see the
// validation-debt session); each cap must trip its truncation banner before
// the corresponding view degrades. See spec 2026-07-02-ares-desktop-design.md
// s5.1 (filter-first + hard slice cap).

// Max nodes+edges in a focused graph slice before cytoscape/ELK hairballs.
export const GRAPH_SLICE_CAP = 1500

// Max distinct stack chains pulled for the flame view (bounds the IPC payload).
export const FLAME_CHAIN_CAP = 5000

// Max tree nodes the flame SVG will build before the icicle degrades.
export const FLAME_NODE_CAP = 2000
