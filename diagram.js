"use strict";

const svgNamespace = "http://www.w3.org/2000/svg";

function diagramElement(tag, attributes = {}, text = "") {
  const node = document.createElementNS(svgNamespace, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text) node.textContent = text;
  return node;
}

function geometryNumber(element, key) {
  const value = Number(field(element, key));
  return Number.isFinite(value) ? value : 0;
}

function geometryPoint(geometry, key) {
  const point = [...(geometry?.children ?? [])].find(child => field(child, "as") === key);
  return point ? {x: geometryNumber(point, "x"), y: geometryNumber(point, "y")} : null;
}

function cellPositions(cells) {
  const boxes = new Map();
  const visiting = new Set();
  function find(id) {
    if (boxes.has(id)) return boxes.get(id);
    const cell = cells.get(id);
    if (!cell?.geometry || visiting.has(id)) return null;
    visiting.add(id);
    const parent = find(cell.parent);
    const x = geometryNumber(cell.geometry, "x");
    const y = geometryNumber(cell.geometry, "y");
    const offset = geometryPoint(cell.geometry, "offset");
    const box = {
      x: (parent?.x ?? 0) + x * (cell.relative ? parent?.width ?? 1 : 1) + (offset?.x ?? 0),
      y: (parent?.y ?? 0) + y * (cell.relative ? parent?.height ?? 1 : 1) + (offset?.y ?? 0),
      width: geometryNumber(cell.geometry, "width"),
      height: geometryNumber(cell.geometry, "height")
    };
    visiting.delete(id);
    boxes.set(id, box);
    return box;
  }
  for (const id of cells.keys()) {
    if (cells.get(id).vertex) find(id);
  }
  return boxes;
}

function arrangeDiagram(model) {
  const stages = new Map();
  const outgoing = new Map();
  const waiting = new Map();
  const actors = [];
  const stores = [];
  for (const [id, node] of model.nodes) {
    if (node.kind === "process") {
      stages.set(id, 0);
      outgoing.set(id, []);
      waiting.set(id, 0);
    } else {
      (node.kind === "actor" ? actors : stores).push(id);
    }
  }
  for (const {element} of model.flows) {
    const from = field(element, "from");
    const to = field(element, "to");
    if (!stages.has(from) || !stages.has(to) || from === to) continue;
    outgoing.get(from).push(to);
    waiting.set(to, waiting.get(to) + 1);
  }

  const queue = [...stages.keys()].filter(id => waiting.get(id) === 0);
  for (const id of queue) {
    for (const target of outgoing.get(id)) {
      stages.set(target, Math.max(stages.get(target), stages.get(id) + 1));
      waiting.set(target, waiting.get(target) - 1);
      if (waiting.get(target) === 0) queue.push(target);
    }
  }
  const byStage = new Map();
  for (const [id, stage] of stages) {
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage).push(id);
  }
  const columns = [...byStage.keys()].sort((a, b) => a - b).map(stage => byStage.get(stage));
  if (actors.length) columns.unshift(actors);
  if (stores.length) columns.push(stores);

  const maxRows = Math.max(...columns.map(column => column.length));
  const rowHeight = 126;
  const columnWidth = 332;
  const boxes = new Map();
  const outgoingLength = Math.max(116, ...model.flows.filter(({element}) => !field(element, "to"))
    .map(({name}) => name.length * 10 + 24));
  const storeClearance = Math.max(0, outgoingLength - (columnWidth - 206) + 22);
  columns.forEach((column, x) => {
    column.forEach((id, y) => {
      const node = model.nodes.get(id);
      boxes.set(id, {
        x: x * columnWidth + (node.kind === "store" ? storeClearance : 0),
        y: (y + (maxRows - column.length) / 2) * rowHeight,
        width: node.kind === "process" ? 206 : 166,
        height: node.kind === "process" ? 72 : 56
      });
    });
  });
  return boxes;
}

function normalizedLink(element) {
  if (element.tagName === "access") {
    const process = field(element, "process");
    const store = field(element, "store");
    const writing = field(element, "mode") === "wr";
    return {source: writing ? process : store, target: writing ? store : process, type: "access", label: ""};
  }
  return {
    source: field(element, "from"), target: field(element, "to"),
    type: field(element, "kind") === "signal" ? "signal" : "flow", label: field(element, "name")
  };
}

function center(box) {
  return {x: box.x + box.width / 2, y: box.y + box.height / 2};
}

function connectionSide(box, other, source) {
  if (!other) return source ? "right" : "left";
  const a = center(box);
  const b = center(other);
  if (Math.abs(a.x - b.x) > 20) return b.x > a.x ? "right" : "left";
  return b.y > a.y ? "bottom" : "top";
}

function sidePoint(box, side, fraction) {
  if (side === "left" || side === "right") {
    return {x: box.x + (side === "right" ? box.width : 0), y: box.y + box.height * fraction};
  }
  return {x: box.x + box.width * fraction, y: box.y + (side === "bottom" ? box.height : 0)};
}

function routePoint(route, source, box, boxes) {
  if (!route) return null;
  const {edge, reverse} = route;
  const originalSource = source !== reverse;
  const side = originalSource ? "source" : "target";
  const parent = boxes.get(edge.parent);
  if (!box) {
    const point = geometryPoint(edge.geometry, side + "Point");
    return point && {x: point.x + (parent?.x ?? 0), y: point.y + (parent?.y ?? 0)};
  }
  const portId = edge.style.get(originalSource ? "sourcePort" : "targetPort");
  const terminal = boxes.get(portId || (originalSource ? edge.from : edge.to));
  if (terminal && terminal !== box) return center(terminal);

  const prefix = originalSource ? "exit" : "entry";
  const x = Number(edge.style.get(prefix + "X"));
  const y = Number(edge.style.get(prefix + "Y"));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {x: box.x + box.width * x, y: box.y + box.height * y};
}

function routeWaypoints(route, boxes) {
  if (!route) return [];
  const {edge, reverse} = route;
  const parent = boxes.get(edge.parent);
  const array = [...(edge.geometry?.children ?? [])].find(child => field(child, "as") === "points");
  if (!array) return [];
  const points = [...array.children].map(point => ({
    x: geometryNumber(point, "x") + (parent?.x ?? 0),
    y: geometryNumber(point, "y") + (parent?.y ?? 0)
  }));
  return reverse ? points.reverse() : points;
}

function diagramLinks(model, boxes, nativeBoxes) {
  const links = [...model.root.children].filter(node => ["flow", "access"].includes(node.tagName))
    .map(element => {
      const link = normalizedLink(element);
      const route = nativeBoxes && model.drawing.routes.get(element);
      return route ? {...link, route, source: route.source, target: route.target} : link;
    });
  const bySide = new Map();
  for (const link of links) {
    for (const source of [true, false]) {
      const id = link[source ? "source" : "target"];
      const box = boxes.get(id);
      if (!box) continue;
      const other = boxes.get(link[source ? "target" : "source"]);
      const side = link.source === link.target ? (source ? "right" : "top") : connectionSide(box, other, source);
      const slot = {link, box, side, source, order: other ? center(other)[side === "left" || side === "right" ? "y" : "x"] : 0};
      const key = `${id}:${side}`;
      if (!bySide.has(key)) bySide.set(key, []);
      bySide.get(key).push(slot);
    }
  }
  for (const slots of bySide.values()) {
    slots.sort((a, b) => a.order - b.order);
    slots.forEach(({link, box, side, source}, index) => {
      const fallback = sidePoint(box, side, (index + 1) / (slots.length + 1));
      link[source ? "start" : "end"] = routePoint(link.route, source, box, nativeBoxes) ?? fallback;
    });
  }

  return links.map(link => {
    const boundaryLength = Math.max(114, link.label.length * 10 + 24);
    const start = link.start ?? routePoint(link.route, true, null, nativeBoxes) ??
      {x: link.end.x - boundaryLength, y: link.end.y};
    const end = link.end ?? routePoint(link.route, false, null, nativeBoxes) ??
      {x: start.x + boundaryLength, y: start.y};
    let waypoints = routeWaypoints(link.route, nativeBoxes);
    if (link.source && link.source === link.target && !waypoints.length) {
      waypoints = [{x: start.x + 32, y: start.y}, {x: start.x + 32, y: end.y - 27}, {x: end.x, y: end.y - 27}];
    }
    return {...link, points: [start, ...waypoints, end]};
  });
}

function halfway(points) {
  const length = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const segments = points.slice(1).map((point, i) => length(points[i], point));
  let distance = segments.reduce((total, value) => total + value, 0) / 2;
  for (const [i, segment] of segments.entries()) {
    if (segment > 0 && distance <= segment) {
      const start = points[i];
      const end = points[i + 1];
      return {x: start.x + (end.x - start.x) * distance / segment, y: start.y + (end.y - start.y) * distance / segment};
    }
    distance -= segment;
  }
  return points[0];
}

function addArrows(svg) {
  const defs = diagramElement("defs");
  for (const [kind, color] of [["flow", "#465d56"], ["access", "#748178"]]) {
    const marker = diagramElement("marker", {
      id: `diagram-arrow-${kind}`, markerWidth: 8, markerHeight: 8, refX: 7.4, refY: 4, orient: "auto-start-reverse"
    });
    marker.append(diagramElement("path", {d: "M0 0 L8 4 L0 8 Z", fill: color}));
    defs.append(marker);
  }
  svg.append(defs);
}

function graphicsNode(node, box, activate) {
  const {x, y, width, height} = box;
  const group = diagramElement("g", {class: `diagram-node ${node.kind}`});
  group.append(diagramElement("rect", {x, y, width, height, rx: node.kind === "store" ? 15 : 6}));
  const fontSize = Math.min(21, (width - 10) / Math.max(1, node.name.length * .59), height * .45);
  group.append(diagramElement("text", {
    x: x + width / 2, y: y + height / 2, "dominant-baseline": "central", "text-anchor": "middle",
    "font-size": Math.max(4, fontSize)
  }, node.name));
  if (node.kind !== "process") return group;

  group.setAttribute("role", "button");
  group.setAttribute("tabindex", "0");
  group.setAttribute("aria-label", node.name);
  group.setAttribute("aria-pressed", "false");
  group.dataset.section = node.key;
  group.addEventListener("click", () => activate(node.key));
  group.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activate(node.key);
  });
  return group;
}

function drawDiagram(svg, model, activate) {
  const imported = model.drawing ? cellPositions(model.drawing.cells) : null;
  const useImported = imported && [...model.nodes.keys()].every(id => {
    const box = imported.get(id);
    return box?.width > 0 && box.height > 0;
  });
  const boxes = useImported ? new Map([...model.nodes.keys()].map(id => [id, imported.get(id)])) : arrangeDiagram(model);
  const links = diagramLinks(model, boxes, useImported ? imported : null);

  const bounds = {left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity};
  const include = (x, y) => {
    bounds.left = Math.min(bounds.left, x);
    bounds.top = Math.min(bounds.top, y);
    bounds.right = Math.max(bounds.right, x);
    bounds.bottom = Math.max(bounds.bottom, y);
  };
  svg.replaceChildren();
  addArrows(svg);
  const lines = diagramElement("g");
  const labels = diagramElement("g");
  svg.append(lines, labels);
  for (const {points, type, route, label} of links) {
    for (const {x, y} of points) include(x, y);
    const arrow = `url(#diagram-arrow-${type === "access" ? "access" : "flow"})`;
    const line = diagramElement("polyline", {
      points: points.map(({x, y}) => `${x},${y}`).join(" "), class: `diagram-line ${type}`, "marker-end": arrow
    });
    if (route?.twoWay) line.setAttribute("marker-start", arrow);
    lines.append(line);
    if (label) {
      const {x, y} = halfway(points);
      const labelWidth = label.length * 9;
      include(x - labelWidth / 2, y - 22);
      include(x + labelWidth / 2, y + 4);
      labels.append(diagramElement("text", {x, y: y - 5, "text-anchor": "middle", class: "diagram-label"}, label));
    }
  }
  for (const [id, box] of boxes) {
    include(box.x, box.y);
    include(box.x + box.width, box.y + box.height);
    svg.append(graphicsNode(model.nodes.get(id), box, activate));
  }
  const width = bounds.right - bounds.left + 44;
  const height = bounds.bottom - bounds.top + 44;
  svg.setAttribute("viewBox", `${bounds.left - 22} ${bounds.top - 22} ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  return {width, height};
}
