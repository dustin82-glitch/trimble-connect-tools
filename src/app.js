let apiRef = null;
let apiFlavor = "unknown";

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

async function connectWorkspaceApiWithFallbacks(statusEl) {
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

  const legacyConnect = window.ProjectWorkspaceAPI && window.ProjectWorkspaceAPI.connect
    ? window.ProjectWorkspaceAPI.connect
    : null;

  if (!modernConnect && !legacyConnect) {
    throw new Error("No Trimble API connectors found on window.");
  }

  if (modernConnect) {
    for (const candidate of candidates) {
      if (!candidate.target) continue;
      if (seen.has(candidate.target)) continue;
      seen.add(candidate.target);

      statusEl.textContent = "Connecting via modern API (" + candidate.name + ")...";
      try {
        const api = await connectWithTimeout(modernConnect, candidate.target, 10000);
        return { api, flavor: "modern" };
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        errors.push("modern " + candidate.name + ": " + message);
        await sleep(150);
      }
    }
  }

  if (legacyConnect) {
    for (const candidate of candidates) {
      if (!candidate.target) continue;

      statusEl.textContent = "Connecting via legacy API (" + candidate.name + ")...";
      try {
        const api = await connectWithTimeout(legacyConnect, candidate.target, 10000);
        return { api, flavor: "legacy" };
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        errors.push("legacy " + candidate.name + ": " + message);
        await sleep(150);
      }
    }
  }

  throw new Error("Connection failed. " + errors.join(" | "));
}

function supportsViewerMarkup(api) {
  return !!(api && api.viewer && api.viewer.getSelection && api.viewer.getObjectProperties && api.viewer.getObjectBoundingBoxes && api.markup && api.markup.addTextMarkup);
}

async function registerMenuIfAvailable(api) {
  if (!api || !api.ui || !api.ui.setMenu) return;
  await api.ui.setMenu({
    title: "Hello World",
    icon: "https://dustin82-glitch.github.io/trimble-connect-tools/icon.svg",
    command: "hello_world",
    subMenus: [{ title: "Home", command: "hello_world_home" }]
  });
  if (api.ui.setActiveMenuItem) {
    await api.ui.setActiveMenuItem("hello_world_home");
  }
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

function findPropertyValue(objectProperties, propertyName) {
  const wanted = String(propertyName || "").trim().toLowerCase();
  if (!wanted) return null;
  const properties = flattenProperties(objectProperties);
  for (const property of properties) {
    if (String(property.name).toLowerCase() === wanted) return property.value;
  }
  return null;
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

function getSelectionItems(selection) {
  const items = [];
  for (const modelSelection of selection || []) {
    const ids = modelSelection.objectRuntimeIds || [];
    for (const id of ids) items.push({ modelId: modelSelection.modelId, objectRuntimeId: id });
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

async function refreshPropertyDropdown(statusEl) {
  if (!apiRef || !supportsViewerMarkup(apiRef)) return [];

  const selectEl = document.getElementById("propertyName");
  const selection = await apiRef.viewer.getSelection();
  const items = getSelectionItems(selection);

  if (!items.length) {
    setPropertyDropdownOptions(selectEl, []);
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
  const items = getSelectionItems(selection);

  if (!items.length) {
    statusEl.textContent = "No objects selected in the 3D viewer.";
    return;
  }

  let created = 0;
  // Apply to a bounded amount per click to keep the 3D host responsive.
  const applyItems = items.slice(0, 25);
  for (const item of applyItems) {
    const objectProperties = await apiRef.viewer.getObjectProperties(item.modelId, [item.objectRuntimeId]);
    const objectData = objectProperties && objectProperties.length ? objectProperties[0] : null;
    if (!objectData) continue;

    const value = findPropertyValue(objectData, propertyName);
    const textValue = value === null || value === undefined || value === "" ? "N/A" : String(value);

    const boxes = await apiRef.viewer.getObjectBoundingBoxes(item.modelId, [item.objectRuntimeId]);
    const boxData = boxes && boxes.length ? boxes[0].boundingBox : null;
    const center = centerOfBox(boxData);
    if (!center) continue;

    const startPick = toMarkupPick(center, item.modelId, item.objectRuntimeId);
    const endPick = {
      ...startPick,
      positionX: startPick.positionX + 1
    };

    await apiRef.markup.addTextMarkup([
      {
        start: startPick,
        end: endPick,
        text: propertyName + ": " + textValue,
        color: { r: 0, g: 112, b: 192, a: 255 }
      }
    ]);
    created += 1;
  }

  if (items.length > applyItems.length) {
    statusEl.textContent = "Placed text on " + created + " part(s) (limited to first " + applyItems.length + " selected).";
  } else {
    statusEl.textContent = "Placed text on " + created + " selected part(s).";
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

  const hasModern = !!(window.TrimbleConnectWorkspace && window.TrimbleConnectWorkspace.connect);
  const hasLegacy = !!(window.ProjectWorkspaceAPI && window.ProjectWorkspaceAPI.connect);
  if (!hasModern && !hasLegacy) {
    statusEl.textContent = "No supported Trimble API bundle available.";
    return;
  }

  try {
    const connected = await connectWorkspaceApiWithFallbacks(statusEl);
    const api = connected.api;
    apiFlavor = connected.flavor;
    apiRef = api;

    try {
      await registerMenuIfAvailable(api);
    } catch (menuError) {
      console.warn("Menu registration skipped:", menuError);
    }

    if (apiFlavor === "modern") {
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
    } else {
      hostEl.textContent = "legacy";
      try {
        const project = await api.project.getCurrentProject();
        projectEl.textContent = project && project.name ? project.name : "unknown";
      } catch {
        projectEl.textContent = "unknown";
      }
      try {
        const userSettings = await api.user.getUserSettings();
        userEl.textContent = userSettings && userSettings.language ? "lang: " + userSettings.language : "legacy";
      } catch {
        userEl.textContent = "legacy";
      }
    }

    if (supportsViewerMarkup(api)) {
      statusEl.textContent = "Connected via " + apiFlavor + " API. Property markup tool is ready.";
      propertySelect.disabled = false;
      refreshBtn.disabled = false;
      applyBtn.disabled = false;

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
      statusEl.textContent = "Connected via " + apiFlavor + " API. Select parts and click Refresh Properties.";

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
    } else {
      applyBtn.disabled = true;
      statusEl.textContent = "Connected via " + apiFlavor + " API, but viewer markup methods are unavailable in this host.";
    }
  } catch (error) {
    console.error(error);
    statusEl.textContent = "Could not connect to Trimble APIs: " + (error && error.message ? error.message : String(error));
  }
}

initExtension();
