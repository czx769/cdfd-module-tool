"use strict";

const storePrefixes = new Map([
  ["local", ""], ["external", "ext "], ["existing", "ext #"]
]);
const storeLabels = new Map([
  ["local", "本地存储"], ["external", "上层传入"], ["existing", "系统外已有"]
]);
const identifierPattern = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const behaviorPattern = /^CDFD_[0-9]+$/;

const field = (element, key) => (element?.getAttribute(key) ?? "").trim();

function identifier(value, label) {
  if (!identifierPattern.test(value)) {
    const name = value ? `“${value}”` : "";
    throw new Error(`${label}${name}须以英文字母开头，只能包含英文字母、数字和下划线。`);
  }
  return value;
}

function parseXml(xml) {
  const doc = new DOMParser().parseFromString(xml.trim(), "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("XML 格式有误，请检查标签和文件编码。");
  if (doc.doctype) throw new Error("CDFD 文件不能包含 DOCTYPE。");
  return doc.documentElement;
}

function readSources(xml, filename) {
  const root = parseXml(xml);
  if (root.tagName === "cdfd") {
    return [{name: filename, load: () => buildModel(root)}];
  }
  if (root.tagName === "mxGraphModel") {
    return [{name: filename, load: () => readDrawio(root, filename, "")}];
  }
  if (root.tagName !== "mxfile") {
    throw new Error("请选择 .drawio 原文件、draw.io 导出的 XML 或 CDFD XML。");
  }

  const pages = [...root.children].filter(element => element.tagName === "diagram");
  if (!pages.length) throw new Error("draw.io 文件里没有图页。");
  return pages.map((page, index) => {
    const pageName = field(page, "name");
    return {
      name: pageName || `第 ${index + 1} 页`,
      async load() {
        const graph = [...page.children].find(element => element.tagName === "mxGraphModel");
        return readDrawio(graph ?? await decompressPage(page.textContent), filename, pageName);
      }
    };
  });
}

async function decompressPage(contents) {
  const payload = contents.trim();
  if (!payload) throw new Error("图页中没有可读取的内容。");
  if (payload.startsWith("<")) return parseXml(payload);
  let stream;
  try {
    stream = new DecompressionStream("deflate-raw");
  } catch {
    throw new Error("当前浏览器无法解压此图页。请使用新版浏览器，或在 draw.io 导出未压缩的 XML。");
  }
  try {
    const bytes = Uint8Array.from(atob(payload), char => char.charCodeAt(0));
    const decoded = await new Response(new Blob([bytes]).stream().pipeThrough(stream)).text();
    return parseXml(decodeURIComponent(decoded));
  } catch {
    throw new Error("无法解压 draw.io 图页，请核对文件是否完整。");
  }
}

function cdfdElement(root, tag, attributes) {
  const element = root.ownerDocument.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value) element.setAttribute(key, value);
  }
  root.append(element);
  return element;
}

function drawioCell(element) {
  const cell = element.tagName === "mxCell" ? element : element.querySelector(":scope > mxCell");
  if (!cell) return null;
  const geometry = cell.querySelector(":scope > mxGeometry");
  const style = new Map(field(cell, "style").split(";").filter(Boolean).map(part => part.split("=")));
  const meta = key => field(element, key) || field(cell, key);
  const rawLabel = field(element, "label") || field(cell, "value");
  const label = style.get("html") === "1" ? drawioText(rawLabel) : rawLabel;
  return {
    id: field(element, "id") || field(cell, "id"),
    parent: field(cell, "parent"), from: field(cell, "source"), to: field(cell, "target"),
    vertex: field(cell, "vertex") === "1", edge: field(cell, "edge") === "1",
    geometry, relative: field(geometry, "relative") === "1",
    kind: meta("cdfdKind"), label, style, meta
  };
}

function drawioText(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script, style").forEach(element => element.remove());
  return template.content.textContent.trim();
}

function drawioKind(cell) {
  const shape = cell.style.get("shape") ?? "";
  if (/cylinder|data[_-]?store|stored_data|database/i.test(shape)) return "store";
  if (/actor/i.test(shape) || cell.style.has("umlActor") || cell.style.get("dashed") === "1") return "actor";
  return "process";
}

function drawioName(label) {
  return label.trim().replace(/\s+/g, "_");
}

function readDrawio(graph, filename, pageName) {
  const drawioRoot = graph.tagName === "mxGraphModel" && graph.querySelector(":scope > root");
  if (!drawioRoot) throw new Error("找不到 draw.io 的 mxGraphModel 图结构。");

  const cells = [...drawioRoot.children].map(drawioCell).filter(Boolean);
  const byId = new Map();
  for (const cell of cells) {
    if (!cell.id || byId.has(cell.id)) throw new Error("draw.io 图中有缺失或重复的图元 ID。");
    byId.set(cell.id, cell);
  }

  const moduleInfo = cells.find(cell => cell.kind === "module");
  const fileName = filename.replace(/\.(drawio|xml)$/i, "").replace(/[^a-zA-Z0-9_]+/g, "_");
  const moduleName = moduleInfo?.meta("cdfdModule") || field(graph, "cdfdModule") ||
    (identifierPattern.test(fileName) ? fileName : "CDFD_Module");
  const behavior = moduleInfo?.meta("cdfdBehavior") || field(graph, "cdfdBehavior") ||
    (behaviorPattern.test(pageName) ? pageName : "");

  const cdfd = document.implementation.createDocument(null, "cdfd").documentElement;
  cdfd.setAttribute("module", moduleName);
  if (behavior) cdfd.setAttribute("behavior", behavior);

  const edges = cells.filter(cell => cell.edge && cell.kind !== "ignore");
  const terminals = new Set(edges.flatMap(({from, to}) => [from, to]).filter(Boolean));
  const ports = new Map();
  const labelsByEdge = new Map();
  for (const cell of cells) {
    const parent = byId.get(cell.parent);
    if (cell.vertex && parent?.edge && cell.label) {
      if (!labelsByEdge.has(parent.id)) labelsByEdge.set(parent.id, []);
      labelsByEdge.get(parent.id).push(cell.label);
    }
    if (cell.vertex && (cell.kind === "port" ||
        (!cell.kind && cell.relative && parent?.vertex && terminals.has(cell.id)))) {
      if (!parent?.vertex) throw new Error("CDFD 端口须属于一个过程图形。");
      ports.set(cell.id, {nodeId: parent.id, port: cell.meta("cdfdPort") || cell.label || cell.id});
    }
  }

  const connected = new Set([...terminals].map(id => ports.get(id)?.nodeId ?? id));
  const nodes = new Map();
  const routes = new Map();
  for (const cell of cells) {
    if (!cell.vertex || ports.has(cell.id) || byId.get(cell.parent)?.edge ||
        ["module", "ignore"].includes(cell.kind)) continue;
    if (!cell.kind && !connected.has(cell.id)) continue;
    const kind = cell.kind || drawioKind(cell);
    if (!["actor", "store", "process"].includes(kind)) {
      throw new Error(`图元 ${cell.label || cell.id} 的 cdfdKind 无法识别。`);
    }
    nodes.set(cell.id, kind);
    cdfdElement(cdfd, kind, {
      id: cell.id,
      name: kind === "actor" ? cell.label : drawioName(cell.label),
      scope: cell.meta("cdfdScope"),
      type: cell.meta("cdfdType")
    });
  }

  for (const [index, edge] of edges.entries()) {
    const label = edge.label || labelsByEdge.get(edge.id)?.join(" ") || "";
    const description = label ? `连线“${label}”` : `第 ${index + 1} 条连线`;
    const hasStart = edge.style.has("startArrow") && edge.style.get("startArrow") !== "none";
    const hasEnd = edge.style.get("endArrow") !== "none";
    const reverse = hasStart && !hasEnd;
    const source = drawioEndpoint(reverse ? edge.to : edge.from, ports, nodes, description);
    const target = drawioEndpoint(reverse ? edge.from : edge.to, ports, nodes, description);
    const fromKind = nodes.get(source.nodeId);
    const toKind = nodes.get(target.nodeId);
    const touchesStore = fromKind === "store" || toKind === "store";
    const route = {edge, source: source.nodeId, target: target.nodeId, reverse, twoWay: hasStart && hasEnd};

    if (touchesStore) {
      if (!((fromKind === "store" && toKind === "process") ||
            (fromKind === "process" && toKind === "store"))) {
        throw new Error(`${description}须连接一个过程和一个数据存储。`);
      }
      const mode = edge.meta("cdfdAccess");
      if (!mode && !hasStart && !hasEnd) throw new Error(`${description}缺少读写方向。`);
      const access = cdfdElement(cdfd, "access", {
        process: fromKind === "process" ? source.nodeId : target.nodeId,
        store: fromKind === "store" ? source.nodeId : target.nodeId,
        mode: mode || (fromKind === "process" || (hasStart && hasEnd) ? "wr" : "rd")
      });
      routes.set(access, route);
      continue;
    }

    if (!hasStart && !hasEnd) throw new Error(`${description}缺少数据流箭头。`);
    if (hasStart && hasEnd) throw new Error(`${description}是双向数据流，请分别绘制两个方向并命名。`);
    const signal = edge.meta("cdfdSignal");
    const flow = cdfdElement(cdfd, "flow", {
      name: identifier(drawioName(label), `${description}的数据流名称`),
      from: source.nodeId,
      to: target.nodeId,
      "in-port": edge.meta("cdfdInPort") || target.port,
      "out-port": edge.meta("cdfdOutPort") || source.port,
      kind: signal === "1" || signal === "true" || (!signal && edge.style.get("dashed") === "1") ? "signal" : "",
      type: edge.meta("cdfdType")
    });
    routes.set(flow, route);
  }

  const model = buildModel(cdfd);
  model.drawing = {cells: byId, routes};
  return model;
}

function drawioEndpoint(id, ports, nodes, label) {
  const endpoint = ports.get(id) ?? {nodeId: id, port: ""};
  if (id && !nodes.has(endpoint.nodeId)) {
    throw new Error(`${label}连接的图元 ${id} 无法识别。`);
  }
  return endpoint;
}

function buildModel(root) {
  const moduleName = identifier(field(root, "module"), "模块名");
  const behavior = field(root, "behavior");
  if (behavior && !behaviorPattern.test(behavior)) throw new Error("behavior 应为 CDFD_编号，例如 CDFD_1。");

  const nodes = new Map();
  const names = new Set();
  const flows = [];
  const accesses = [];
  for (const element of root.children) {
    const kind = element.tagName;
    if (element.childElementCount) throw new Error(`<${kind}> 内不应包含其他元素。`);
    if (kind === "flow") {
      flows.push(element);
      continue;
    }
    if (kind === "access") {
      accesses.push(element);
      continue;
    }
    if (!["process", "store", "actor"].includes(kind)) throw new Error(`未知元素 <${kind}>。`);
    const id = field(element, "id");
    if (!id || nodes.has(id)) throw new Error(`<${kind}> 的 id 缺失或重复。`);
    const name = field(element, "name") || (kind === "actor" ? id : "");
    if (kind !== "actor") {
      identifier(name, `<${kind}> 的 name`);
      if (kind === "process" && name === "Init") {
        throw new Error("Init 用于初始化本地存储，请通过 store 的 scope 声明本地存储。");
      }
      if (names.has(name)) throw new Error(`过程或存储名称重复：${name}。`);
      names.add(name);
    }
    const scope = field(element, "scope");
    if (kind === "store" && scope && !storePrefixes.has(scope)) {
      throw new Error(`存储 ${name} 的 scope 应为 local、external 或 existing。`);
    }
    nodes.set(id, {
      key: `${kind}-${nodes.size}`, element, kind, name, scope, type: field(element, "type"),
      inputs: new Map(), outputs: new Map(), stores: new Map(), pre: "", post: ""
    });
  }

  const processes = [...nodes.values()].filter(node => node.kind === "process");
  const stores = [...nodes.values()].filter(node => node.kind === "store");
  if (!processes.length) throw new Error("CDFD 至少需要一个过程。");

  const records = flows.map((element, index) => {
    const name = identifier(field(element, "name"), "数据流名称");
    const from = flowEndpoint(element, "from", nodes, name);
    const to = flowEndpoint(element, "to", nodes, name);
    if (from?.kind !== "process" && to?.kind !== "process") {
      throw new Error(`数据流 ${name} 至少应连接一个过程。`);
    }
    const kind = field(element, "kind");
    if (kind && !["data", "signal"].includes(kind)) {
      throw new Error(`数据流 ${name} 的 kind 应为 data 或 signal。`);
    }
    const type = field(element, "type");
    if (kind === "signal" && type && type !== "sign") {
      throw new Error(`控制信号 ${name} 的类型应为 sign。`);
    }
    const group = {key: `flow-${index}`, type: kind === "signal" ? "sign" : type, fixed: kind === "signal", members: []};
    const record = {name, element, group};
    group.members.push(record);
    if (from?.kind === "process") addFlow(from.outputs, field(element, "out-port"), record);
    if (to?.kind === "process") addFlow(to.inputs, field(element, "in-port"), record);
    return record;
  });

  for (const access of accesses) {
    const process = nodes.get(field(access, "process"));
    const store = nodes.get(field(access, "store"));
    const mode = field(access, "mode");
    if (process?.kind !== "process" || store?.kind !== "store") {
      throw new Error("<access> 须通过 id 引用已定义的过程和存储。");
    }
    if (mode !== "rd" && mode !== "wr") {
      throw new Error(`过程 ${process.name} 对 ${store.name} 的 mode 应为 rd 或 wr。`);
    }
    if (process.stores.get(store.name) !== "wr") process.stores.set(store.name, mode);
  }

  return {
    moduleName, behavior, processes, stores, nodes, root, flows: records,
    typeDeclarations: "", invariant: "", initialization: {key: "init", name: "Init", pre: "", post: ""}
  };
}

function flowEndpoint(flow, key, nodes, name) {
  const id = field(flow, key);
  if (!id) return null;
  const endpoint = nodes.get(id);
  if (!endpoint || endpoint.kind === "store") {
    throw new Error(`数据流 ${name} 的 ${key} 须引用一个过程或外部参与者。`);
  }
  return endpoint;
}

function addFlow(ports, port, record) {
  const {name} = record;
  const key = port ? `port:${port}` : `flow:${name}`;
  if (!ports.has(key)) ports.set(key, new Map());
  const fields = ports.get(key);
  const previous = fields.get(name);
  if (!previous) {
    fields.set(name, record);
    return;
  }

  const first = previous.group;
  const second = record.group;
  if (first === second) return;
  if (first.type && second.type && first.type !== second.type) {
    throw new Error(`端口内数据流 ${name} 的类型不一致。`);
  }
  first.type ||= second.type;
  first.fixed ||= second.fixed;
  // Branches carrying the same variable through one port share its type.
  for (const member of second.members) {
    member.group = first;
    first.members.push(member);
  }
}

function activeProcesses(model) {
  const locals = model.stores.filter(store => store.scope === "local");
  if (!locals.length) return model.processes;
  model.initialization.stores = new Map(locals.map(store => [store.name, "wr"]));
  return [model.initialization, ...model.processes];
}

function formatPorts(ports, separator) {
  return [...ports.values()].map(records =>
    [...records.values()].map(({name, group}) => `${name}: ${group.type.trim() || "【待填类型】"}`).join(", ")
  ).join(separator);
}

function bodyText(value) {
  return value.trim().split("\n").map(line => line ? `  ${line}` : "").join("\n");
}

function predicate(keyword, value, placeholder) {
  const text = value.trim();
  if (!text) return `${keyword} ${placeholder}`;
  return text.includes("\n") ? `${keyword}\n${bodyText(text)}` : `${keyword} ${text}`;
}

function renderModule(model) {
  const {moduleName, behavior, stores, typeDeclarations, invariant} = model;
  const sections = [`module ${identifierPattern.test(moduleName.trim()) ? moduleName.trim() : "【待填有效模块名】"};`];
  if (typeDeclarations.trim()) sections.push(`type\n${bodyText(typeDeclarations)}`);
  if (stores.length) {
    const vars = stores.map(({name, type, scope}) =>
      `  ${storePrefixes.get(scope) ?? "【待填存储范围】 "}${name}: ${type.trim() || "【待填类型】"};`
    );
    sections.push(["var", ...vars].join("\n"));
  }
  if (invariant.trim()) sections.push(`inv\n${bodyText(invariant)}`);
  sections.push(`behav ${behaviorPattern.test(behavior.trim()) ? behavior.trim() : "【待填有效 CDFD 编号】"};`);

  for (const process of activeProcesses(model)) {
    const inputs = process.inputs ? formatPorts(process.inputs, " | ") : "";
    const outputs = process.outputs ? formatPorts(process.outputs, " |\n    ") : "";
    const access = [...process.stores].map(([store, mode]) => `${mode} ${store}`);
    const lines = [`process ${process.name}(${inputs})`];
    if (outputs) lines.push(`    ${outputs}`);
    if (access.length) lines.push(`ext ${access.join("\n    ")}`);
    lines.push(predicate("pre", process.pre, "【待填前置条件】"));
    lines.push(predicate("post", process.post, process.key === "init" ? "【待填初始状态】" : "【待填后置条件】"));
    sections.push([...lines, "end_process;"].join("\n"));
  }
  return [...sections, "end_module"].join("\n\n") + "\n";
}

function exportGraph(model) {
  const copy = model.root.cloneNode(true);
  const updated = new Map([
    ...model.flows.map(flow => [flow.element, {type: flow.group.type.trim()}]),
    ...model.stores.map(store => [store.element, {type: store.type.trim(), scope: store.scope}])
  ]);
  copy.setAttribute("module", model.moduleName.trim());
  copy.setAttribute("behavior", model.behavior.trim());
  const lines = [...model.root.children].map((original, i) => {
    const node = copy.children[i];
    for (const [key, value] of Object.entries(updated.get(original) ?? {})) {
      if (value) node.setAttribute(key, value);
      else node.removeAttribute(key);
    }
    return "  " + new XMLSerializer().serializeToString(node);
  });
  const header = new XMLSerializer().serializeToString(copy.cloneNode(false)).replace(/\/>$/, ">");
  return ['<?xml version="1.0" encoding="UTF-8"?>', header, ...lines, "</cdfd>", ""].join("\n");
}
