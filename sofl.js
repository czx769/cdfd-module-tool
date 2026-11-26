"use strict";

const moduleSections = new Set(["const", "type", "var", "inv", "behav", "process", "function", "end_module"]);
const processSections = new Set(["ext", "pre", "post", "comment", "end_process", "process", "function", "end_module"]);
const closingTokens = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);

function soflTokens(text) {
  const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|--[^\n]*|"(?:\\.|""|[^"\\])*"|【待填[^】\n]*】|[A-Za-z][A-Za-z0-9_]*|\S/g;
  return [...text.matchAll(pattern)]
    .filter(([value]) => !/^(\/\*|\/\/|--)/.test(value))
    .map(match => ({value: match[0], start: match.index, end: match.index + match[0].length}));
}

function soflError(text, token, message) {
  const line = text.slice(0, token?.start ?? text.length).split("\n").length;
  return new Error(`第 ${line} 行  ${message}`);
}

class SoflReader {
  constructor(text, tokens = soflTokens(text)) {
    this.text = text;
    this.tokens = tokens;
    this.index = 0;
  }

  get next() {
    return this.tokens[this.index];
  }

  get value() {
    return this.next?.value;
  }

  take(value) {
    if (this.value !== value) return false;
    this.index++;
    return true;
  }

  expect(value) {
    if (!this.take(value)) this.fail(`应为 ${value}，实际为 ${this.value ?? "文件结束"}。`);
  }

  fail(message) {
    throw soflError(this.text, this.next, message);
  }

  name(allowPlaceholder = false) {
    const token = this.next;
    if (allowPlaceholder && token?.value.startsWith("【待填")) {
      this.index++;
      return {...token, value: ""};
    }
    if (!identifierPattern.test(token?.value ?? "")) this.fail("缺少有效的标识符。");
    this.index++;
    return token;
  }

  until(stops, balanced = true) {
    const start = this.index;
    const closing = [];
    while (this.next) {
      const value = this.value;
      if (!closing.length && stops.has(value)) break;
      if (balanced && closingTokens.has(value)) {
        closing.push(closingTokens.get(value));
      } else if (balanced && /^[)\]}]$/.test(value)) {
        if (closing.pop() !== value) this.fail(`括号 ${value} 与前面的声明不匹配。`);
      }
      this.index++;
    }
    if (closing.length) this.fail(`缺少结束括号 ${closing.at(-1)}。`);
    return this.tokens.slice(start, this.index);
  }

  content(tokens) {
    if (!tokens.length || (tokens.length === 1 && tokens[0].value.startsWith("【待填"))) return "";
    const start = tokens[0].start;
    const indent = this.text.slice(this.text.lastIndexOf("\n", start - 1) + 1, start);
    const content = this.text.slice(start, tokens.at(-1).end);
    if (!indent || indent.trim()) return content;
    return content.split("\n").map((line, index) =>
      index && line.startsWith(indent) ? line.slice(indent.length) : line).join("\n");
  }

  type(stops) {
    const token = this.next;
    const tokens = this.until(stops);
    if (!tokens.length) throw soflError(this.text, token, "缺少类型声明。");
    return this.content(tokens);
  }
}

function soflNames(reader) {
  const names = [reader.name()];
  while (reader.take(",")) names.push(reader.name());
  return names;
}

function rememberDeclaration(reader, fields, token, declaration) {
  if (fields.has(token.value)) throw soflError(reader.text, token, `重复声明 ${token.value}。`);
  fields.set(token.value, {...declaration, token});
}

function readSoflPorts(text, tokens) {
  if (!tokens.length) return [];
  const reader = new SoflReader(text, tokens);
  const stops = new Set([",", "|"]);
  const ports = [];
  do {
    const fields = new Map();
    do {
      const names = soflNames(reader);
      reader.expect(":");
      const type = reader.type(stops);
      for (const token of names) rememberDeclaration(reader, fields, token, {type});
    } while (reader.take(","));
    ports.push(fields);
  } while (reader.take("|"));
  if (reader.next) reader.fail("无法识别端口声明。");
  return ports;
}

function readSoflStores(text, tokens) {
  const reader = new SoflReader(text, tokens);
  const stores = new Map();
  const end = new Set([";"]);
  while (reader.next) {
    let scope = "local";
    if (reader.take("【待填存储范围】")) scope = "";
    else if (reader.take("ext")) scope = reader.take("#") ? "existing" : "external";
    const names = soflNames(reader);
    reader.expect(":");
    const type = reader.type(end);
    for (const token of names) rememberDeclaration(reader, stores, token, {type, scope});
    reader.take(";");
  }
  return stores;
}

function readSoflAccess(text, tokens) {
  const reader = new SoflReader(text, tokens);
  const access = new Map();
  const stops = new Set(["rd", "wr", ";", ","]);
  while (reader.next) {
    const mode = reader.value;
    if (!reader.take("rd") && !reader.take("wr")) reader.fail("存储访问应以 rd 或 wr 开头。");
    do {
      const token = reader.name();
      const type = reader.take(":") ? reader.type(stops) : "";
      rememberDeclaration(reader, access, token, {mode, type});
    } while (reader.take(",") && !["rd", "wr"].includes(reader.value));
    reader.take(";");
  }
  return access;
}

function readSoflProcess(reader) {
  const token = reader.name();
  reader.expect("(");
  const inputs = readSoflPorts(reader.text, reader.until(new Set([")"])));
  reader.expect(")");
  const outputs = readSoflPorts(reader.text, reader.until(processSections));
  const access = reader.take("ext") ? readSoflAccess(reader.text, reader.until(processSections)) : new Map();
  const pre = reader.take("pre") ? reader.content(reader.until(processSections)) : "";
  const post = reader.take("post") ? reader.content(reader.until(processSections)) : "";
  const comment = reader.take("comment") ? reader.content(reader.until(new Set(["end_process"]), false)) : "";
  reader.expect("end_process");
  reader.take(";");
  return {token, inputs, outputs, access, pre, post, comment};
}

function readSofl(text) {
  const reader = new SoflReader(text);
  reader.expect("module");
  const name = reader.name(true);
  const parentModule = reader.take("/") ? reader.name().value : "";
  reader.take(";");
  const sections = new Map();
  const processes = new Map();
  const moduleNames = new Set(["const", "type", "var", "inv", "behav"]);
  while (moduleNames.has(reader.value)) {
    const keyword = reader.value;
    if (sections.has(keyword)) reader.fail(`重复的 ${keyword} 段。`);
    reader.take(keyword);
    sections.set(keyword, reader.until(moduleSections));
  }
  const behavior = new SoflReader(text, sections.get("behav") ?? []);
  const behaviorToken = behavior.next ? behavior.name(true) : {value: "", start: name.start};
  if (behaviorToken.value && !behaviorPattern.test(behaviorToken.value)) {
    throw soflError(text, behaviorToken, "behav 的值应为 CDFD_编号。");
  }
  behavior.take(";");
  if (behavior.next) behavior.fail("behav 段只能有一个 CDFD 编号。");

  while (reader.take("process")) {
    const process = readSoflProcess(reader);
    rememberDeclaration(reader, processes, process.token, process);
  }
  const functions = reader.value === "function" ? reader.content(reader.until(new Set(["end_module"]))) : "";
  reader.expect("end_module");
  reader.take(";");
  if (reader.next) reader.fail("end_module 后还有无法识别的内容。");

  return {
    name, behavior: behaviorToken, parentModule, functions, processes,
    constants: reader.content(sections.get("const") ?? []),
    typeDeclarations: reader.content(sections.get("type") ?? []),
    invariant: reader.content(sections.get("inv") ?? []),
    stores: readSoflStores(text, sections.get("var") ?? [])
  };
}

function portSignature(fields) {
  return JSON.stringify([...fields.keys()].sort());
}

function validateSofl(model, text) {
  const draft = readSofl(text);
  const updates = new Map();
  const conflict = (token, title, expected, actual) => {
    throw soflError(text, token,
      `${title}与 CDFD 冲突。CDFD 为 ${expected || "无"}，SOFL 为 ${actual || "无"}。`);
  };
  const typeKey = type => JSON.stringify(soflTokens(type).map(token => token.value));
  const sameType = (a, b) => typeKey(a) === typeKey(b);

  function checkType(current, type, token, title) {
    const baseline = current.type.trim();
    const expected = baseline || updates.get(current) || "";
    if ((baseline && !type) || (expected && type && !sameType(expected, type))) {
      conflict(token, title, expected, type);
    }
    if (type && !baseline) updates.set(current, type);
  }

  const moduleName = model.moduleName.trim();
  if (moduleName && moduleName !== draft.name.value) conflict(draft.name, "模块名", moduleName, draft.name.value);
  const behavior = model.behavior.trim();
  if (behavior && behavior !== draft.behavior.value) conflict(draft.behavior, "behav", behavior, draft.behavior.value);

  const stores = new Map(model.stores.map(store => [store.name, store]));
  for (const [name, store] of draft.stores) {
    if (!stores.has(name)) conflict(store.token, "数据存储", "", name);
  }
  for (const [name, store] of stores) {
    const saved = draft.stores.get(name);
    if (!saved) conflict(draft.name, "缺少数据存储", name, "");
    if (store.scope && store.scope !== saved.scope) {
      conflict(saved.token, `${name} 的存储范围`, storeLabels.get(store.scope), storeLabels.get(saved.scope));
    }
    checkType(store, saved.type, saved.token, `${name} 的类型`);
  }

  const locals = model.stores.filter(store => (store.scope || draft.stores.get(store.name).scope) === "local");
  const expectedProcesses = new Map(model.processes.map(process => [process.name, process]));
  if (locals.length || draft.processes.has("Init")) {
    expectedProcesses.set("Init", {stores: new Map(locals.map(store => [store.name, "wr"]))});
  }
  for (const [name, process] of draft.processes) {
    if (!expectedProcesses.has(name)) conflict(process.token, "过程名", "", name);
  }
  for (const [name, process] of expectedProcesses) {
    const saved = draft.processes.get(name);
    if (!saved) conflict(draft.name, "缺少过程", name, "");
    for (const [direction, label] of [["inputs", "输入"], ["outputs", "输出"]]) {
      const expected = describePorts(process[direction] ?? new Map(), direction);
      const actual = saved[direction];
      const remaining = [...actual];
      for (const port of expected) {
        const signature = portSignature(port.records);
        const group = remaining.findIndex(fields => portSignature(fields) === signature);
        if (group === -1) break;
        const [fields] = remaining.splice(group, 1);
        for (const [flowName, record] of port.records) {
          const {type, token} = fields.get(flowName);
          checkType(record.group, type, token, `${name} ${port.label} 数据流 ${flowName} 的类型`);
        }
      }
      if (remaining.length || actual.length !== expected.length) {
        conflict(saved.token, `${name} 的${label}端口分组`,
          expected.map(port => `${port.label} (${[...port.records.keys()].join(", ")})`).join(" | "),
          actual.map(port => `(${[...port.keys()].join(", ")})`).join(" | "));
      }
    }

    for (const [store, {mode, type, token}] of saved.access) {
      const expected = process.stores.get(store);
      if (expected !== mode) conflict(token, `${name} 对 ${store} 的访问`, expected, mode);
      if (type) checkType(stores.get(store), type, token, `${name} 中 ${store} 的类型`);
    }
    for (const [store, mode] of process.stores) {
      if (!saved.access.has(store)) conflict(saved.token, `${name} 对 ${store} 的访问`, mode, "");
    }
  }

  return {draft, updates};
}

function applySofl(model, {draft, updates}) {
  if (draft.name.value) model.moduleName = draft.name.value;
  if (draft.behavior.value) model.behavior = draft.behavior.value;
  for (const key of ["parentModule", "constants", "typeDeclarations", "invariant", "functions"]) {
    model[key] = draft[key];
  }
  for (const [declaration, type] of updates) declaration.type = type;
  for (const store of model.stores) store.scope ||= draft.stores.get(store.name).scope;
  model.includeInit = draft.processes.has("Init") && !model.stores.some(store => store.scope === "local");
  for (const process of activeProcesses(model)) {
    const {pre, post, comment} = draft.processes.get(process.name);
    Object.assign(process, {pre, post, comment});
  }
}
