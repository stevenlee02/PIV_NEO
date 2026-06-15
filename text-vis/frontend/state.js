// Centralized mutable state.
// ESM imports are read-only, so all shared mutable state lives inside this object.
export const S = {
  currentGraphData: null,
  selectedEdgeKey: null,
  selectedNodeId: null,
  activePanel: "timeline",
  activeChapter: null,
  graphInnerSvg: null,
  graphNodes: [],
  graphLinks: [],
  nodeById: new Map(),
  graphWidth: 0,
  graphHeight: 0,
  labelLayer: null,
  rafLabelLoop: null,
  labelItems: [],
};
