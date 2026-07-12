let apiRef = null;
const BUILD_VERSION = "20260712-24";
const MARKUP_MIN_OFFSET_MM = 150;
const MARKUP_CLEARANCE_MM = 50;
const SELECTION_MONITOR_MS = 1200;
const HELLO_WORLD_TEXT = "Hello World";

let selectionMonitorHandle = null;
let lastSelectionSignature = "";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectWithTimeout(connectFn, target, timeoutMs) {
  const connectPromise = connectFn(target, (event, args) => {
    if (event === "extension.command") {
      console.log("extension.command", args);
    }
  }, timeoutMs);

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Timed out after " + timeoutMs + "ms")), timeoutMs + 2000);
  });

  return Promise.race([connectPromise, timeoutPromise]);
}

async function connectWorkspaceApi(statusEl) {
  const candidates = [
    { name: "parent", target: window.parent },
    { name: "top", target: window.top },
    { name: "self", target: window }
  ];

  const seen = new Set();
  const errors = [];

  const modernConnect = window.TrimbleConnectWorkspace && window.TrimbleConnectWorkspace.connect
    ? window.TrimbleConnectWorkspace.connect
    : null;

  if (!modernConnect) {
    throw new Error("No Trimble API connectors found on window.");
  }

  if (modernConnect) {
    for (const candidate of candidates) {
      if (!candidate.target) continue;
      if (seen.has(candidate.target)) continue;
      seen.add(candidate.target);

      statusEl.textContent = "Connecting to Workspace API (" + candidate.name + ")...";
      try {
        const api = await connectWithTimeout(modernConnect, candidate.target, 10000);
        return api;
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        errors.push(candidate.name + ": " + message);
        await sleep(150);
      }
    }
  }

  throw new Error("Connection failed. " + errors.join(" | "));
}

function supportsViewerMarkup(api) {
  return !!(api && api.viewer && api.viewer.getSelection && api.viewer.getObjectProperties && api.viewer.getObjectBoundingBoxes && api.markup && api.markup.addTextMarkup);
}

function flattenProperties(objectProperties) {
  const sets = objectProperties && objectProperties.properties ? objectProperties.properties : [];
  const all = [];
  for (const set of sets) {
    const properties = set && set.properties ? set.properties : [];
    for (const property of properties) all.push(property);
  }
  return all;
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function toDisplayValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => toDisplayValue(item)).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    if ("displayValue" in value && value.displayValue !== undefined && value.displayValue !== null) {
      return String(value.displayValue);
    }
    if ("value" in value && value.value !== undefined && value.value !== null) {
      return String(value.value);
    }
    if ("text" in value && value.text !== undefined && value.text !== null) {
      return String(value.text);
    }
  }
  return String(value);
}

function findPropertyValue(objectProperties, propertyName) {
  const wanted = normalizeKey(propertyName);
  if (!wanted) return { value: null, matchedName: null };

  const properties = flattenProperties(objectProperties);

  // Exact normalized match first.
  for (const property of properties) {
    const currentName = property && property.name ? String(property.name) : "";
    if (normalizeKey(currentName) === wanted) {
      return {
        value: toDisplayValue(property.value),
        matchedName: currentName
      };
    }
  }

  // Fallback: partial normalized match.
  for (const property of properties) {
    const currentName = property && property.name ? String(property.name) : "";
    const currentNorm = normalizeKey(currentName);
    if (!currentNorm) continue;
    if (currentNorm.includes(wanted) || wanted.includes(currentNorm)) {
      return {
        value: toDisplayValue(property.value),
        matchedName: currentName
      };
    }
  }

  return { value: null, matchedName: null };
}

function centerOfBox(boundingBox) {
  if (!boundingBox || !boundingBox.min || !boundingBox.max) return null;
  return {
    x: (boundingBox.min.x + boundingBox.max.x) / 2,
    y: (boundingBox.min.y + boundingBox.max.y) / 2,
    z: (boundingBox.min.z + boundingBox.max.z) / 2
  };
}

function toMarkupPick(position, modelId, objectId) {
  return {
    positionX: position.x,
    positionY: position.y,
    positionZ: position.z,
    modelId,
    objectId: Number(objectId),
    type: "point"
  };
}

function getMarkupOffsetX(boundingBox) {
  if (!boundingBox || !boundingBox.min || !boundingBox.max) return MARKUP_MIN_OFFSET_MM;
  const sizeX = Math.abs(Number(boundingBox.max.x) - Number(boundingBox.min.x));
  return Math.max(MARKUP_MIN_OFFSET_MM, sizeX / 2 + MARKUP_CLEARANCE_MM);
}

function getRuntimeIdsFromSelectionEntry(modelSelection) {
  if (!modelSelection || typeof modelSelection !== "object") return [];
  const candidates = [
    modelSelection.objectRuntimeIds,
    modelSelection.runtimeIds,
    modelSelection.ids
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || !candidate.length) continue;
    return candidate.filter(id => Number.isFinite(Number(id))).map(id => Number(id));
  }
  return [];
}

async function getSelectionItems(selection) {
  const items = [];
  for (const modelSelection of selection || []) {
    const modelId = modelSelection && modelSelection.modelId ? modelSelection.modelId : null;
    if (!modelId) continue;

    const runtimeIds = getRuntimeIdsFromSelectionEntry(modelSelection);
    if (runtimeIds.length) {
      for (const runtimeId of runtimeIds) {
        items.push({ modelId, objectRuntimeId: runtimeId });
      }
      continue;
    }

    const objectIds = Array.isArray(modelSelection.objectIds) ? modelSelection.objectIds : [];
    if (objectIds.length && apiRef && apiRef.viewer && apiRef.viewer.convertToObjectRuntimeIds) {
      try {
        const converted = await apiRef.viewer.convertToObjectRuntimeIds(modelId, objectIds);
        for (const runtimeId of converted || []) {
          if (!Number.isFinite(Number(runtimeId))) continue;
          items.push({ modelId, objectRuntimeId: Number(runtimeId) });
        }
      } catch {
        // Conversion can fail on some hosts; debug panel will show no-runtime-ids status.
      }
    }
  }
  return items;
}

function setPropertyDropdownOptions(selectEl, propertyNames) {
  selectEl.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = propertyNames.length ? "Select a property" : "Select parts and refresh properties";
  selectEl.appendChild(placeholder);

  for (const name of propertyNames) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    selectEl.appendChild(option);
  }

  if (!propertyNames.length) return;

  const preferred = propertyNames.find(name => String(name).toLowerCase() === "assembly pos");
  selectEl.value = preferred || propertyNames[0];
}

function renderDebugRows(propertyName, rows, totalSelected, maxShown) {
  const summaryEl = document.getElementById("debugSummary");
  const listEl = document.getElementById("debugList");
  if (!summaryEl || !listEl) return;

  listEl.innerHTML = "";
  const shown = rows.length;
  const label = propertyName ? propertyName : "(none)";
  summaryEl.textContent = "Property: " + label + " | Showing " + shown + " of " + totalSelected + " selected" + (totalSelected > maxShown ? " (limited)" : "") + ".";

  if (!rows.length) {
    const li = document.createElement("li");
    li.textContent = "No selected items to display.";
    listEl.appendChild(li);
    return;
  }

  for (const row of rows) {
    const li = document.createElement("li");
    let text = "model=" + row.modelId + " | id=" + row.objectRuntimeId + " | value=" + row.value + " | status=" + row.status;
    if (row.payload) {
      text += " | payload.start=(" + row.payload.start.positionX + "," + row.payload.start.positionY + "," + row.payload.start.positionZ + ")";
      text += " | payload.end=(" + row.payload.end.positionX + "," + row.payload.end.positionY + "," + row.payload.end.positionZ + ")";
      text += " | payload.text=\"" + row.payload.text + "\"";
    }
    li.textContent = text;
    listEl.appendChild(li);
  }
}

function initializeDebugPanel() {
  const summaryEl = document.getElementById("debugSummary");
  const listEl = document.getElementById("debugList");
  if (!summaryEl || !listEl) return;

  const startedAt = new Date().toISOString();
  summaryEl.textContent = "Build " + BUILD_VERSION + " loaded at " + startedAt + ".";
  listEl.innerHTML = "";

  const li = document.createElement("li");
  li.textContent = "debug-init | build=" + BUILD_VERSION + " | waiting for selection";
  listEl.appendChild(li);
}

function getSelectionSignature(selection) {
  try {
    return JSON.stringify(selection || []);
  } catch {
    return String(Date.now());
  }
}

async function refreshSelectionDebugFromViewer() {
  if (!apiRef || !apiRef.viewer || !apiRef.viewer.getSelection) return;

  const selection = await apiRef.viewer.getSelection();
  const signature = getSelectionSignature(selection);
  if (signature === lastSelectionSignature) return;
  lastSelectionSignature = signature;

  const totalSelected = Array.isArray(selection) ? selection.length : 0;
  const items = await getSelectionItems(selection);

  if (!items.length) {
    const rawEntry = selection && selection.length ? selection[0] : null;
    renderDebugRows("", [
      {
        modelId: rawEntry && rawEntry.modelId ? rawEntry.modelId : "n/a",
        objectRuntimeId: "n/a",
        value: rawEntry ? "selection keys: " + Object.keys(rawEntry).join(",") : "no selection",
        status: "selection-monitor"
      }
    ], totalSelected, 10);
    return;
  }

  const rows = items.slice(0, 10).map(item => ({
    modelId: item.modelId,
    objectRuntimeId: item.objectRuntimeId,
    value: "selected",
    status: "selection-monitor"
  }));
  renderDebugRows("", rows, items.length, 10);
}

function startSelectionMonitor() {
  if (selectionMonitorHandle) {
    clearInterval(selectionMonitorHandle);
    selectionMonitorHandle = null;
  }

  selectionMonitorHandle = setInterval(async () => {
    try {
      await refreshSelectionDebugFromViewer();
    } catch {
      // Keep monitor resilient if host rejects transient selection queries.
    }
  }, SELECTION_MONITOR_MS);
}

async function refreshPropertyDropdown(statusEl) {
  if (!apiRef || !supportsViewerMarkup(apiRef)) return [];

  const selectEl = document.getElementById("propertyName");
  const selection = await apiRef.viewer.getSelection();
  const items = await getSelectionItems(selection);

  if (!items.length) {
    setPropertyDropdownOptions(selectEl, []);
    const rawEntry = selection && selection.length ? selection[0] : null;
    renderDebugRows("", [
      {
        modelId: rawEntry && rawEntry.modelId ? rawEntry.modelId : "n/a",
        objectRuntimeId: "n/a",
        value: rawEntry ? "selection keys: " + Object.keys(rawEntry).join(",") : "no selection",
        status: "no-runtime-ids"
      }
    ], selection && selection.length ? selection.length : 0, 0);
    statusEl.textContent = "No objects selected. Select parts, then click Refresh Properties.";
    return [];
  }

  const names = new Set();
  // Load names from only the first selected object to keep host calls minimal.
  const sampleItem = items[0];
  const objectProperties = await apiRef.viewer.getObjectProperties(sampleItem.modelId, [sampleItem.objectRuntimeId]);
  const objectData = objectProperties && objectProperties.length ? objectProperties[0] : null;
  if (objectData) {
    const flattened = flattenProperties(objectData);
    for (const property of flattened) {
      if (property && property.name) names.add(String(property.name));
    }
  }

  const propertyNames = Array.from(names).sort((a, b) => a.localeCompare(b));
  setPropertyDropdownOptions(selectEl, propertyNames);

  if (!propertyNames.length) {
    statusEl.textContent = "No properties found on current selection.";
  } else {
    statusEl.textContent = "Loaded " + propertyNames.length + " properties from first selected part.";
  }

  return propertyNames;
}

async function applyPropertyToSelection() {
  if (!apiRef) return;

  const statusEl = document.getElementById("status");
  const propertyName = document.getElementById("propertyName").value.trim();
  if (!propertyName) {
    statusEl.textContent = "Select a property first, then click Apply.";
    return;
  }

  const selection = await apiRef.viewer.getSelection();
  const items = await getSelectionItems(selection);

  if (!items.length) {
    const rawEntry = selection && selection.length ? selection[0] : null;
    renderDebugRows(propertyName, [
      {
        modelId: rawEntry && rawEntry.modelId ? rawEntry.modelId : "n/a",
        objectRuntimeId: "n/a",
        value: rawEntry ? "selection keys: " + Object.keys(rawEntry).join(",") : "no selection",
        status: "no-runtime-ids"
      }
    ], selection && selection.length ? selection.length : 0, 0);
    statusEl.textContent = "No objects selected in the 3D viewer.";
    return;
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const payload = [];
  const debugRows = [];
  let firstError = "";
  // Apply to a bounded amount per click to keep the 3D host responsive.
  const applyItems = items.slice(0, 25);
  for (const item of applyItems) {
    try {
      const objectProperties = await apiRef.viewer.getObjectProperties(item.modelId, [item.objectRuntimeId]);
      const objectData = objectProperties && objectProperties.length ? objectProperties[0] : null;
      if (!objectData) {
        skipped += 1;
        debugRows.push({
          modelId: item.modelId,
          objectRuntimeId: item.objectRuntimeId,
          value: "n/a",
          status: "no-properties"
        });
        continue;
      }

      const match = findPropertyValue(objectData, propertyName);
      const textValue = match.value === null || match.value === undefined || match.value === "" ? "N/A" : String(match.value);

      const boxes = await apiRef.viewer.getObjectBoundingBoxes(item.modelId, [item.objectRuntimeId]);
      const boxData = boxes && boxes.length ? boxes[0].boundingBox : null;
      const center = centerOfBox(boxData);
      if (!center) {
        skipped += 1;
        debugRows.push({
          modelId: item.modelId,
          objectRuntimeId: item.objectRuntimeId,
          value: textValue,
          status: "no-bounding-box"
        });
        continue;
      }

      const startPick = toMarkupPick(center, item.modelId, item.objectRuntimeId);
      const offsetX = getMarkupOffsetX(boxData);
      const endPick = {
        ...startPick,
        positionX: startPick.positionX + offsetX
      };

      payload.push({
        start: startPick,
        end: endPick,
        text: textValue,
        color: { r: 0, g: 112, b: 192, a: 255 }
      });
      const payloadEntry = payload[payload.length - 1];
      debugRows.push({
        modelId: item.modelId,
        objectRuntimeId: item.objectRuntimeId,
        value: textValue,
        status: (match.matchedName ? "queued(" + match.matchedName + ")" : "queued(no-match)") + "|dx=" + Math.round(offsetX),
        payload: payloadEntry
      });
    } catch (error) {
      failed += 1;
      debugRows.push({
        modelId: item.modelId,
        objectRuntimeId: item.objectRuntimeId,
        value: "n/a",
        status: "error"
      });
      if (!firstError) {
        firstError = error && error.message ? error.message : String(error);
      }
    }
  }

  renderDebugRows(propertyName, debugRows, items.length, applyItems.length);

  if (!payload.length) {
    statusEl.textContent = "No markups created. Skipped: " + skipped + ", Failed: " + failed + (firstError ? " (" + firstError + ")" : "") + ".";
    return;
  }

  let added = [];
  try {
    added = await apiRef.markup.addTextMarkup(payload);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    statusEl.textContent = "addTextMarkup failed: " + message;
    return;
  }

  created = Array.isArray(added) ? added.length : payload.length;

  if (items.length > applyItems.length) {
    statusEl.textContent = "Placed " + created + " markups (limited to first " + applyItems.length + "). Skipped: " + skipped + ", Failed: " + failed + ".";
  } else {
    statusEl.textContent = "Placed " + created + " markups. Skipped: " + skipped + ", Failed: " + failed + ".";
  }
}

async function addHelloWorldTestMarkup() {
  if (!apiRef || !apiRef.markup || !apiRef.markup.addTextMarkup) return;

  const statusEl = document.getElementById("status");
  const selection = await apiRef.viewer.getSelection();
  const items = await getSelectionItems(selection);
  if (!items.length) {
    statusEl.textContent = "No selected objects found. Select parts first.";
    return;
  }

  const item = items[0];

  try {
    const boxes = await apiRef.viewer.getObjectBoundingBoxes(item.modelId, [item.objectRuntimeId]);
    const boxData = boxes && boxes.length ? boxes[0].boundingBox : null;
    const center = centerOfBox(boxData);
    if (!center) {
      renderDebugRows("hello-world", [
        {
          modelId: item.modelId,
          objectRuntimeId: item.objectRuntimeId,
          value: HELLO_WORLD_TEXT,
          status: "no-bounding-box"
        }
      ], items.length, 1);
      statusEl.textContent = "No Hello World markup created. Selected object has no bounding box.";
      return;
    }

    const startPick = toMarkupPick(center, item.modelId, item.objectRuntimeId);
    const offsetX = getMarkupOffsetX(boxData);
    const endPick = {
      ...startPick,
      positionX: startPick.positionX + offsetX
    };

    const payload = [
      {
        start: startPick,
        end: endPick,
        text: HELLO_WORLD_TEXT,
        color: { r: 0, g: 112, b: 192, a: 255 }
      }
    ];

    renderDebugRows("hello-world", [
      {
        modelId: item.modelId,
        objectRuntimeId: item.objectRuntimeId,
        value: HELLO_WORLD_TEXT,
        status: "hello-world|single|dx=" + Math.round(offsetX),
        payload: payload[0]
      }
    ], items.length, 1);

    const added = await apiRef.markup.addTextMarkup(payload);
    const created = Array.isArray(added) ? added.length : payload.length;
    statusEl.textContent = "Placed " + created + " Hello World markup from selected object's bounding-box center.";
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    statusEl.textContent = "Hello World markup failed: " + message;
  }
}

async function initExtension() {
  const statusEl = document.getElementById("status");
  const hostEl = document.getElementById("host");
  const projectEl = document.getElementById("project");
  const userEl = document.getElementById("user");
  const propertySelect = document.getElementById("propertyName");
  const refreshBtn = document.getElementById("refreshPropertiesBtn");
  const applyBtn = document.getElementById("applyPropertyBtn");
  const helloWorldBtn = document.getElementById("addHelloWorldBtn");
  initializeDebugPanel();

  const hasModern = !!(window.TrimbleConnectWorkspace && window.TrimbleConnectWorkspace.connect);
  if (!hasModern) {
    statusEl.textContent = "No supported Trimble API bundle available.";
    return;
  }

  try {
    const api = await connectWorkspaceApi(statusEl);
    apiRef = api;

    try {
      const host = await api.extension.getHost();
      hostEl.textContent = host && host.name ? host.name : "modern";
    } catch {
      hostEl.textContent = "modern";
    }

    try {
      const project = await api.project.getProject();
      projectEl.textContent = project && project.name ? project.name : "unknown";
    } catch {
      projectEl.textContent = "unknown";
    }

    try {
      const user = await api.user.getUser();
      userEl.textContent = user && user.email ? user.email : (user && user.name ? user.name : "unknown");
    } catch {
      userEl.textContent = "unknown";
    }

    if (supportsViewerMarkup(api)) {
      statusEl.textContent = "Connected to Workspace API. Property markup tool is ready.";
      propertySelect.disabled = false;
      refreshBtn.disabled = false;
      applyBtn.disabled = false;
      helloWorldBtn.disabled = false;

      await refreshSelectionDebugFromViewer();
      startSelectionMonitor();

      refreshBtn.addEventListener("click", async () => {
        refreshBtn.disabled = true;
        applyBtn.disabled = true;
        try {
          const propertyNames = await refreshPropertyDropdown(statusEl);
          applyBtn.disabled = propertyNames.length === 0;
        } catch (error) {
          console.error(error);
          statusEl.textContent = "Failed while loading properties from selection.";
          applyBtn.disabled = true;
        } finally {
          refreshBtn.disabled = false;
        }
      });

      applyBtn.disabled = true;
      statusEl.textContent = "Connected to Workspace API. Select parts and click Refresh Properties.";

      applyBtn.addEventListener("click", async () => {
        applyBtn.disabled = true;
        try {
          await applyPropertyToSelection();
        } catch (error) {
          console.error(error);
          statusEl.textContent = "Failed while placing property markups.";
        } finally {
          applyBtn.disabled = false;
        }
      });

      helloWorldBtn.addEventListener("click", async () => {
        helloWorldBtn.disabled = true;
        try {
          await addHelloWorldTestMarkup();
        } catch (error) {
          console.error(error);
          statusEl.textContent = "Failed while placing Hello World test markup.";
        } finally {
          helloWorldBtn.disabled = false;
        }
      });
    } else {
      applyBtn.disabled = true;
      helloWorldBtn.disabled = true;
      statusEl.textContent = "Connected to Workspace API, but viewer markup methods are unavailable in this host.";
    }
  } catch (error) {
    console.error(error);
    statusEl.textContent = "Could not connect to Trimble APIs: " + (error && error.message ? error.message : String(error));
  }
}

initExtension();
