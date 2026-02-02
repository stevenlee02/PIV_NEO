import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

export function ForceGraph({ nodes, links }, {
  nodeId = d => d.id,
  nodeGroup,
  nodeGroups,
  nodeTitle,
  nodeFill = "currentColor",
  nodeStroke = "#fff",
  nodeStrokeWidth = 1.5,
  nodeStrokeOpacity = 1,
  nodeRadius = 5,
  nodeStrength,
  linkSource = ({source}) => source,
  linkTarget = ({target}) => target,
  linkStroke = "#999",
  linkStrokeOpacity = 0.6,
  linkStrokeWidth = 1.5,
  linkStrokeLinecap = "round",
  linkStrength,
  colors = d3.schemeTableau10,
  width = 640,
  height = 400,
  invalidation
} = {}) {

  const N  = d3.map(nodes, nodeId).map(intern);
  const R  = typeof nodeRadius !== "function" ? null : d3.map(nodes, nodeRadius);
  const LS = d3.map(links, linkSource).map(intern);
  const LT = d3.map(links, linkTarget).map(intern);

  if (nodeTitle === undefined) nodeTitle = (_, i) => N[i];
  const T = nodeTitle == null ? null : d3.map(nodes, nodeTitle);
  const G = nodeGroup == null ? null : d3.map(nodes, nodeGroup).map(intern);
  const W = typeof linkStrokeWidth !== "function" ? null : d3.map(links, linkStrokeWidth);
  const L = typeof linkStroke !== "function" ? null : d3.map(links, linkStroke);

  nodes = d3.map(nodes, (node, i) => ({
    ...node,
    id: N[i],
    value: node.value ?? 1,
  }));

  links = d3.map(links, (link, i) => ({
    source: LS[i],
    target: LT[i],
    value: link.value,
  }));

  if (G && nodeGroups === undefined) nodeGroups = d3.sort(G);
  const color = nodeGroup == null ? null : d3.scaleOrdinal(nodeGroups, colors);

  const forceNode = d3.forceManyBody();

  const forceLink = d3.forceLink(links)
    .id((d, i) => N[i])
    .distance(120)
    .strength(0.5);

  if (nodeStrength !== undefined) forceNode.strength(nodeStrength);
  if (linkStrength !== undefined) forceLink.strength(linkStrength);

  const simulation = d3.forceSimulation(nodes)
    .force("link",   forceLink)
    .force("charge", forceNode)
    .force("center", d3.forceCenter())
    .on("tick", ticked);

  const svg = d3.create("svg")
    .attr("width",  width)
    .attr("height", height)
    .attr("viewBox", [-width/2, -height/2, width, height])
    .attr("style", "max-width:100%;height:auto;height:intrinsic;");

  const valueExtent = d3.extent(nodes, d => d.value ?? 1);
  const valueColor = d3.scaleSequential(d3.interpolateTurbo)
    .domain([valueExtent[0] ?? 1, valueExtent[1] ?? 10]);

  const link = svg.append("g")
    .attr("stroke", typeof linkStroke !== "function" ? linkStroke : null)
    .attr("stroke-opacity", linkStrokeOpacity)
    .attr("stroke-width", typeof linkStrokeWidth !== "function" ? linkStrokeWidth : null)
    .attr("stroke-linecap", linkStrokeLinecap)
    .selectAll("line")
    .data(links)
    .join("line")
    .attr("class", "link");

  const node = svg.append("g")
    .attr("stroke", nodeStroke)
    .attr("stroke-opacity", nodeStrokeOpacity)
    .attr("stroke-width", nodeStrokeWidth)
    .selectAll("circle")
    .data(nodes)
    .join("circle")
    .attr("r", nodeRadius)
    .attr("class", "node")
    .attr("fill", d => {
      const fill = (G ? color(G[d.index]) : valueColor(d.value ?? 1));
      d.__baseFill = fill;
      return fill;
    })
    .call(drag(simulation));

  node.on("mouseenter", function (event, d) {
    d3.select(this)
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 3);

    link
      .filter(l => l.source.id === d.id || l.target.id === d.id)
      .attr("stroke", "rgba(110,168,255,.95)")
      .attr("stroke-width", 3)
      .attr("stroke-opacity", 0.95);
  }).on("mouseleave", function (event, d) {
    d3.select(this)
      .attr("fill", d.__baseFill ?? (G ? color(G[d.index]) : valueColor(d.value ?? 1)))
      .attr("stroke", nodeStroke)
      .attr("stroke-width", nodeStrokeWidth);

    link
      .filter(l => l.source.id === d.id || l.target.id === d.id)
      .attr("stroke", typeof linkStroke !== "function" ? linkStroke : null)
      .attr("stroke-width", typeof linkStrokeWidth === "function"
        ? (l, i) => W ? W[i] : 1.5
        : linkStrokeWidth
      )
      .attr("stroke-opacity", linkStrokeOpacity);
  });

  node.on("click", function (event, d) {
    svg.node().dispatchEvent(new CustomEvent("nodeclick", {
      detail: { id: d.id, node: d },
      bubbles: true
    }));
  });

  if (W) link.attr("stroke-width", ({index:i}) => W[i]);
  if (L) link.attr("stroke",       ({index:i}) => L[i]);

  if (G) node.each(function({index:i}) {
    const d = nodes[i];
    const fill = color(G[i]);
    d.__baseFill = fill;
    d3.select(this).attr("fill", fill);
  });

  if (R) node.attr("r", ({index:i}) => R[i]);
  if (T) node.append("title").text(({index:i}) => T[i]);

  if (invalidation != null) invalidation.then(() => simulation.stop());

  function intern(value) {
    return value !== null && typeof value === "object" ? value.valueOf() : value;
  }

  function ticked() {
    link
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x)
      .attr("y2", d => d.target.y);

    node
      .attr("cx", d => d.x)
      .attr("cy", d => d.y);
  }

  function drag(sim) {
    function dragstarted(event) {
      if (!event.active) sim.alphaTarget(0.3).restart();
      event.subject.fx = event.subject.x;
      event.subject.fy = event.subject.y;
    }
    function dragged(event) {
      event.subject.fx = event.x;
      event.subject.fy = event.y;
    }
    function dragended(event) {
      if (!event.active) sim.alphaTarget(0);
      event.subject.fx = null;
      event.subject.fy = null;
    }
    return d3.drag()
      .on("start", dragstarted)
      .on("drag", dragged)
      .on("end", dragended);
  }

  return Object.assign(svg.node(), { scales: { color } });
}
