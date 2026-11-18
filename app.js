"use strict";

const byId = id => document.getElementById(id);
const status = byId("status");
const fileInput = byId("cdfd-file");
const pagePicker = byId("page-select");
const sections = byId("sections");
const form = byId("form");
const editor = byId("editor");
const diagram = byId("diagram");
const diagramViewport = byId("diagram-viewport");
const issues = byId("issues");
const issueList = byId("issue-list");
const example = byId("example-cdfd").textContent.trim();

let model;
let sources = [];
let sourceFile = "";
let currentSection = "module";
let controls = new Map();
let importRequest = 0;
let formDirty = false;
let rawMode = false;
let rawBaseline = "";
let rawLastSaved = "";
let diagramSize;
let diagramZoom = 1;

function setStatus(message, isError = false) {
  status.textContent = message;
  status.toggleAttribute("data-error", isError);
}

function makeElement(tag, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function action(label, onClick, className = "") {
  const button = makeElement("button", label, className);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function formControl(parent, key, label, value, onUpdate, config = {}) {
  const wrapper = makeElement("label", "", "field");
  wrapper.append(makeElement("span", label, "field-label"));
  const input = document.createElement(config.options ? "select" : config.rows ? "textarea" : "input");
  if (config.options) {
    for (const [option, text] of config.options) input.append(new Option(text, option));
  }
  if (config.rows) input.rows = config.rows;
  if (config.placeholder) input.placeholder = config.placeholder;
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "off");
  input.readOnly = Boolean(config.readOnly);
  input.value = value;
  if (!controls.has(key)) controls.set(key, []);
  controls.get(key).push(input);
  input.addEventListener("input", () => {
    onUpdate(input.value);
    formDirty = true;
    for (const peer of controls.get(key)) {
      if (peer !== input) peer.value = input.value;
    }
    if (config.layoutChange) {
      renderSections();
      showSection(currentSection);
      controls.get(key)?.[0]?.focus({preventScroll: true});
    } else {
      updatePreview();
    }
  });
  wrapper.append(input);
  parent.append(wrapper);
}

function renderModuleFields() {
  formControl(form, "module-name", "模块名", model.moduleName, value => { model.moduleName = value; });
  formControl(form, "behavior", "CDFD 编号", model.behavior, value => { model.behavior = value; }, {
    placeholder: "例如 CDFD_1"
  });
  formControl(form, "type-declarations", "自定义类型（可选）", model.typeDeclarations, value => {
    model.typeDeclarations = value;
  }, {rows: 3, placeholder: "例如 Student_Id = string;"});
  formControl(form, "invariant", "模块不变式（可选）", model.invariant, value => {
    model.invariant = value;
  }, {rows: 3});

  if (model.stores.length) {
    const cardset = makeElement("section", "", "cardset");
    cardset.append(makeElement("h3", "数据存储"));
    for (const store of model.stores) {
      const card = makeElement("div", "", "store");
      const grid = makeElement("div", "", "field-grid");
      card.append(makeElement("h3", store.name, "code-label"), grid);
      formControl(grid, `${store.key}-type`, "类型", store.type, value => { store.type = value; }, {
        placeholder: "例如 set of Student"
      });
      formControl(grid, `${store.key}-scope`, "存储范围", store.scope, value => { store.scope = value; }, {
        options: [["", "请选择"], ...storeLabels], layoutChange: true
      });
      cardset.append(card);
    }
    form.append(cardset);
  }
}

function portFields(ports, title) {
  const cardset = makeElement("section", "", "cardset");
  cardset.append(makeElement("h3", title));
  if (!ports.size) cardset.append(makeElement("p", "无", "hint"));
  let index = 0;
  for (const records of ports.values()) {
    const card = makeElement("div", "", "port");
    if (ports.size > 1) card.append(makeElement("p", `端口 ${++index}`, "hint"));
    for (const {name, group} of records.values()) {
      formControl(card, group.key, `${name} 类型`, group.type, value => { group.type = value; }, {
        readOnly: group.fixed, placeholder: "填写数据类型"
      });
    }
    cardset.append(card);
  }
  return cardset;
}

function renderProcessFields(process) {
  const access = makeElement("section", "", "cardset");
  access.append(makeElement("h3", "存储访问"));
  const readWrite = [...process.stores].map(([name, mode]) => `${name}（${mode === "rd" ? "只读" : "可写"}）`);
  access.append(makeElement("p", readWrite.join("、") || "无", "hint code-label"));
  form.append(access);
  formControl(form, `${process.key}-pre`, "前置条件 pre", process.pre, value => { process.pre = value; }, {
    rows: 3, placeholder: "例如 true"
  });
  const label = process.key === "init" ? "初始状态 post" : "后置条件 post";
  formControl(form, `${process.key}-post`, label, process.post, value => { process.post = value; }, {rows: 4});
  if (process.inputs) form.append(portFields(process.inputs, "输入端口"), portFields(process.outputs, "输出端口"));
}

function renderSections() {
  const buttons = activeProcesses(model).map(({key, name}) => {
    const button = action(name, () => selectProcess(key), "section-link");
    button.dataset.section = key;
    return button;
  });
  sections.replaceChildren(...buttons);
}

function selectProcess(key) {
  if (rawMode) return;
  showSection(key, true);
  const fields = byId("fields");
  const heading = byId("fields-title").getBoundingClientRect();
  if (heading.top < 0 || heading.bottom > window.innerHeight) fields.scrollIntoView({block: "start"});
}

function showSection(key, alignPreview = false) {
  const process = activeProcesses(model).find(item => item.key === key);
  currentSection = process?.key ?? "module";
  for (const button of sections.children) {
    if (button.dataset.section === currentSection) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
  byId("module-fields").setAttribute("aria-pressed", String(!process));
  for (const node of diagram.querySelectorAll("[data-section]")) {
    node.setAttribute("aria-pressed", String(node.dataset.section === currentSection));
  }
  byId("fields-title").textContent = process?.name ?? "模块与存储";
  form.replaceChildren();
  controls = new Map();
  if (process) renderProcessFields(process);
  else renderModuleFields();
  updatePreview();

  if (alignPreview) {
    form.scrollTop = 0;
    const marker = process ? `\nprocess ${process.name}(` : "";
    const offset = process ? editor.value.indexOf(marker) + 1 : 0;
    const lines = editor.value.slice(0, offset).split("\n").length - 1;
    editor.scrollTop = lines * parseFloat(getComputedStyle(editor).lineHeight);
  }
}

function missingFields() {
  const missing = [];
  const flag = (section, key, message) => missing.push({section, key, message});
  if (!identifierPattern.test(model.moduleName.trim())) flag("module", "module-name", "填写有效的模块名");
  if (!behaviorPattern.test(model.behavior.trim())) flag("module", "behavior", "填写 CDFD 编号，例如 CDFD_1");
  for (const store of model.stores) {
    if (!store.type.trim()) flag("module", `${store.key}-type`, `${store.name} 缺少类型`);
    if (!store.scope) flag("module", `${store.key}-scope`, `${store.name} 缺少存储范围`);
  }

  const checked = new Set();
  for (const process of activeProcesses(model)) {
    for (const direction of [process.inputs, process.outputs]) {
      if (!direction) continue;
      for (const port of direction.values()) {
        for (const {name, group} of port.values()) {
          if (checked.has(group)) continue;
          checked.add(group);
          if (!group.type.trim()) flag(process.key, group.key, `${process.name} · ${name} 缺少类型`);
        }
      }
    }
    if (!process.pre.trim()) flag(process.key, `${process.key}-pre`, `${process.name} 缺少前置条件`);
    if (!process.post.trim()) {
      const label = process.key === "init" ? "初始状态" : "后置条件";
      flag(process.key, `${process.key}-post`, `${process.name} 缺少${label}`);
    }
  }
  return missing;
}

function focusField(section, key) {
  if (currentSection !== section) showSection(section, true);
  const target = controls.get(key)?.[0];
  target?.focus({preventScroll: true});
  target?.scrollIntoView({block: "nearest"});
}

function rawIssues() {
  return [...editor.value.matchAll(/【待填[^】]*】/g)].map(({0: message, index}) => ({
    message,
    jump() {
      editor.focus();
      editor.setSelectionRange(index, index + message.length);
      editor.scrollTop = (editor.value.slice(0, index).split("\n").length - 1) *
        parseFloat(getComputedStyle(editor).lineHeight);
    }
  }));
}

function updatePreview() {
  if (!rawMode) {
    const scroll = {top: editor.scrollTop, left: editor.scrollLeft};
    editor.value = renderModule(model);
    editor.scrollTop = scroll.top;
    editor.scrollLeft = scroll.left;
  }
  renderIssues();
}

function renderIssues() {
  const list = rawMode ? rawIssues() : missingFields();
  byId("issue-count").textContent = list.length
    ? `待补充 ${list.length} 项`
    : rawMode ? "文本中没有待填标记" : "表单待填项已补齐";
  issueList.replaceChildren(...list.map(item => {
    const row = makeElement("li");
    row.append(action(item.message, item.jump ?? (() => focusField(item.section, item.key))));
    return row;
  }));
  issueList.hidden = !list.length;
  byId("download-draft").hidden = !list.length;
  byId("download-sofl").disabled = !editor.value.trim();
  return list;
}

function setRawMode(editing) {
  rawMode = editing;
  byId("toggle-raw").textContent = editing ? "返回表单" : "编辑文本";
  byId("preview-title").textContent = editing ? "SOFL 文本编辑" : "SOFL 实时预览";
  byId("raw-note").hidden = !editing;
  editor.readOnly = !editing;
  form.inert = editing;
  byId("fields").toggleAttribute("data-locked", editing);
  byId("module-fields").disabled = editing;
  for (const button of sections.children) button.disabled = editing;
  for (const node of diagram.querySelectorAll("[data-section]")) {
    node.setAttribute("aria-disabled", String(editing));
    node.setAttribute("tabindex", editing ? "-1" : "0");
  }
}

function resizeDiagram() {
  if (!diagramSize || !diagramViewport.clientWidth) return;
  const fit = Math.min(
    (diagramViewport.clientWidth - 20) / diagramSize.width,
    (diagramViewport.clientHeight - 20) / diagramSize.height,
    1.4
  );
  diagram.style.width = `${diagramSize.width * fit * diagramZoom}px`;
  byId("diagram-out").disabled = diagramZoom <= .7;
  byId("diagram-in").disabled = diagramZoom >= 4;
}

function openModel(next, label) {
  if ((formDirty || (rawMode && editor.value !== rawLastSaved)) &&
      !window.confirm("导入会替换当前未导出的修改。继续吗？")) return;
  model = next;
  formDirty = false;
  byId("workspace").hidden = false;
  setRawMode(false);
  diagramSize = drawDiagram(diagram, model, selectProcess);
  diagramZoom = 1;
  resizeDiagram();
  diagramViewport.scrollTo(0, 0);
  issues.open = false;
  renderSections();
  showSection("module", true);
  setStatus(`已导入 ${label} · ${model.processes.length} 个过程 · ${model.stores.length} 个数据存储 · ${model.flows.length} 条数据流`);
}

async function loadSource(source, label, request) {
  try {
    const next = await source.load();
    if (request === importRequest) openModel(next, label);
  } catch (error) {
    if (request === importRequest) setStatus(`导入失败。${error.message}`, true);
  }
}

function download(filename, contents, mime) {
  const url = URL.createObjectURL(new Blob([contents], {type: mime}));
  const link = makeElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadSpecification() {
  if (!editor.value.trim()) return;
  const editedName = editor.value.match(/^\s*module\s+([a-zA-Z][a-zA-Z0-9_]*)\s*;/)?.[1];
  download(`${editedName ?? "module"}.sofl`, editor.value, "text/plain;charset=utf-8");
  if (rawMode) rawLastSaved = editor.value;
  else formDirty = false;
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileInput.value = "";
  const request = ++importRequest;
  byId("pages").hidden = true;
  try {
    const xml = new TextDecoder("utf-8", {fatal: true}).decode(await file.arrayBuffer());
    if (request !== importRequest) return;
    sources = readSources(xml, file.name);
    sourceFile = file.name;
    if (sources.length === 1) {
      await loadSource(sources[0], file.name, request);
    } else {
      pagePicker.replaceChildren(new Option("请选择图页", ""));
      sources.forEach(({name}, index) => pagePicker.append(new Option(name, index)));
      byId("pages").hidden = false;
      setStatus(`已读取 ${file.name} · 请选择要导入的图页`);
    }
  } catch (error) {
    if (request !== importRequest) return;
    const detail = error instanceof TypeError ? "请确认文件为 UTF-8 编码。" : error.message;
    setStatus(`导入失败。${detail}`, true);
  }
});

pagePicker.addEventListener("change", () => {
  if (pagePicker.value === "") return;
  const source = sources[Number(pagePicker.value)];
  loadSource(source, `${sourceFile} / ${source.name}`, ++importRequest);
});

byId("load-example").addEventListener("click", () => {
  byId("pages").hidden = true;
  loadSource(readSources(example, "示例")[0], "师生档案系统示例", ++importRequest);
});

byId("module-fields").addEventListener("click", () => showSection("module", true));
byId("diagram-in").addEventListener("click", () => {
  diagramZoom = Math.min(4, diagramZoom * 1.3);
  resizeDiagram();
});
byId("diagram-out").addEventListener("click", () => {
  diagramZoom = Math.max(.7, diagramZoom / 1.3);
  resizeDiagram();
});
byId("diagram-fit").addEventListener("click", () => {
  diagramZoom = 1;
  resizeDiagram();
  diagramViewport.scrollTo(0, 0);
});
new ResizeObserver(resizeDiagram).observe(diagramViewport);

byId("download-example").addEventListener("click", () => {
  download("student-teacher-cdfd.xml", example + "\n", "application/xml;charset=utf-8");
});

byId("toggle-raw").addEventListener("click", () => {
  if (rawMode) {
    if (editor.value !== rawBaseline && editor.value !== rawLastSaved &&
        !window.confirm("返回表单会丢弃未导出的文本修改。继续吗？")) return;
    setRawMode(false);
    updatePreview();
  } else {
    rawLastSaved = rawBaseline = editor.value;
    setRawMode(true);
    renderIssues();
    editor.focus();
  }
});

editor.addEventListener("input", renderIssues);

byId("download-sofl").addEventListener("click", () => {
  const pending = renderIssues();
  if (!pending.length) {
    downloadSpecification();
    return;
  }
  issues.open = true;
  byId("issue-count").focus({preventScroll: true});
  issues.scrollIntoView({block: "nearest"});
});

byId("download-draft").addEventListener("click", downloadSpecification);

byId("download-graph").addEventListener("click", () => {
  const badModule = !identifierPattern.test(model.moduleName.trim());
  const badBehavior = model.behavior.trim() && !behaviorPattern.test(model.behavior.trim());
  if (badModule || badBehavior) {
    const key = badModule ? "module-name" : "behavior";
    setStatus("请修正模块名或 CDFD 编号后再导出 CDFD XML。", true);
    if (rawMode) {
      byId("toggle-raw").focus();
    } else {
      focusField("module", key);
    }
    return;
  }
  download(`${model.moduleName.trim()}-cdfd.xml`, exportGraph(model), "application/xml;charset=utf-8");
  setStatus("已导出 CDFD XML。");
});
