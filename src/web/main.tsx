import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { signal, computed, effect, batch } from "@preact/signals";
import {
  AuthProvider,
  hasAuthParams,
  useAuth,
} from "react-oidc-context";
import type { UserManagerSettings } from "oidc-client-ts";
import { accessToken, onUnauthorized } from "./api.ts";
import { POI_TYPES, type PoiType } from "../poiTypes.ts";
import maplibregl, {
  type Map as MlMap,
  type GeoJSONSource,
  type MapMouseEvent,
} from "maplibre-gl";
import { api, type Poi } from "./api.ts";
import "./style.css";

// ---------- state ----------

const pois = signal<Poi[]>([]);
const loading = signal(true);
const filterText = signal("");
const filterType = signal<"all" | PoiType>("all");
const filterTime = signal<"all" | "current" | "future" | "outdated">("all");
const selectedId = signal<number | null>(null);
const pinning = signal(false);
const errMsg = signal<string | null>(null);
const notice = signal<string | null>(null);
const pendingImport = signal<{ name: string; xml: string } | null>(null);
const pendingDelete = signal<Poi | null>(null);
const importing = signal(false);
const currentUser = signal<string | null>(null);
// Bumped by finishDrag after a successful PUT, so the open form (if any)
// can pick up the new lon/lat without overwriting in-flight keystrokes
// from unrelated refreshes.
const lastDragCommit = signal<{ id: number; lng: number; lat: number; ts: number } | null>(null);

const visiblePois = computed(() => {
  const q = filterText.value.toLowerCase().trim();
  const t = filterType.value;
  const time = filterTime.value;
  const now = Date.now();
  return pois.value
    .filter((p) => {
      if (t !== "all" && p.poi_type !== t) return false;
      if (q && !p.name.toLowerCase().includes(q)) return false;
      if (time !== "all") {
        const from = new Date(p.valid_from).getTime();
        const to = new Date(p.valid_to).getTime();
        if (time === "current" && !(from <= now && now <= to)) return false;
        if (time === "future" && !(from > now)) return false;
        if (time === "outdated" && !(to < now)) return false;
      }
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name, "no"));
});

const selectedPoi = computed(() =>
  pois.value.find((p) => p.id === selectedId.value) ?? null,
);

async function refresh(): Promise<void> {
  try {
    pois.value = await api.list();
    errMsg.value = null;
  } catch (e) {
    errMsg.value = `Failed to load POIs: ${(e as Error).message}`;
  } finally {
    loading.value = false;
  }
}

function flashNotice(msg: string): void {
  notice.value = msg;
  setTimeout(() => {
    if (notice.value === msg) notice.value = null;
  }, 4000);
}

function showError(e: unknown): void {
  errMsg.value = (e as Error).message ?? String(e);
  setTimeout(() => {
    if (errMsg.value !== null) errMsg.value = null;
  }, 5000);
}

// ---------- helpers ----------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tooltipHtml(p: Poi): string {
  const name = escapeHtml(p.name);
  const type = escapeHtml(p.poi_type);
  const from = escapeHtml(p.valid_from.slice(0, 10));
  const to = escapeHtml(p.valid_to.slice(0, 10));
  return `<strong>${name}</strong><br/><small>${type} - ${from} -> ${to}</small>`;
}

function toDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Combine YYYY-MM-DD with a fixed wall-clock time and return an ISO string.
// Browser-local time is used for the conversion to UTC, which matches Oslo
// time for the typical user. ToDate uses 23:59:59 so the converter's strict
// `now <= ToDate` check covers the entire last day.
function fromDateInput(s: string, time: "00:00:00" | "23:59:59"): string {
  if (!s) return "";
  return new Date(`${s}T${time}`).toISOString();
}

const PencilIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </svg>
);

const TrashIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
  </svg>
);

// ---------- map ----------

// Module-level handle to the map's imperative API (set once by MapView).
let mapApi: { focus: (p: Poi) => void } | null = null;

const COLORS: Record<string, string> = {
  concert: "#e63946",
  festival: "#1d4ed8",
  event: "#f59e0b",
};

type DragOverride = { id: number; lng: number; lat: number };

function toGeoJSON(rows: Poi[], drag: DragOverride | null) {
  return {
    type: "FeatureCollection" as const,
    features: rows.map((p) => ({
      type: "Feature" as const,
      id: p.id,
      properties: {
        id: p.id,
        name: p.name,
        poi_type: p.poi_type,
        valid_from: p.valid_from,
        valid_to: p.valid_to,
        color: COLORS[p.poi_type] ?? "#6b7280",
      },
      geometry: {
        type: "Point" as const,
        coordinates:
          drag && drag.id === p.id
            ? [drag.lng, drag.lat]
            : [p.longitude, p.latitude],
      },
    })),
  };
}

function MapView() {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const styleLoaded = useRef(false);
  const dragRef = useRef<DragOverride | null>(null);
  const initialFitDone = useRef(false);

  useEffect(() => {
    if (!ref.current) return;
    const map = new maplibregl.Map({
      container: ref.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
      center: [10.75, 60],
      zoom: 5,
    });
    mapRef.current = map;

    const tooltip = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
    });

    const setSourceData = () => {
      const m = mapRef.current;
      if (!m || !styleLoaded.current) return;
      const src = m.getSource("pois") as GeoJSONSource | undefined;
      if (!src) return;
      src.setData(toGeoJSON(pois.value, dragRef.current));
    };

    const setSelectionFilter = () => {
      const m = mapRef.current;
      if (!m || !styleLoaded.current) return;
      if (!m.getLayer("pois-selected-ring")) return;
      m.setFilter("pois-selected-ring", [
        "==",
        ["get", "id"],
        selectedId.value ?? -1,
      ]);
    };

    mapApi = {
      focus: (p) => {
        map.flyTo({
          center: [p.longitude, p.latitude],
          zoom: Math.max(map.getZoom(), 13),
          speed: 1.6,
        });
      },
    };

    map.on("load", () => {
      styleLoaded.current = true;
      map.addSource("pois", {
        type: "geojson",
        data: toGeoJSON(pois.value, dragRef.current),
      });
      map.addLayer({
        id: "pois-fill",
        type: "circle",
        source: "pois",
        paint: {
          "circle-radius": 7,
          "circle-color": ["get", "color"],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
        },
      });
      map.addLayer({
        id: "pois-selected-ring",
        type: "circle",
        source: "pois",
        filter: ["==", ["get", "id"], selectedId.value ?? -1],
        paint: {
          "circle-radius": 11,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 3,
          "circle-stroke-color": "#111827",
        },
      });
      // Once data lands, fit the camera to all POIs (one-time, only if
      // we've been showing the default view).
      const fitOnce = effect(() => {
        const list = pois.value;
        if (list.length === 0 || initialFitDone.current) return;
        initialFitDone.current = true;
        const b = new maplibregl.LngLatBounds();
        for (const p of list) b.extend([p.longitude, p.latitude]);
        map.fitBounds(b, { padding: 40, maxZoom: 12, duration: 0 });
        fitOnce();
      });
    });

    // Hover tooltip + cursor (grab to telegraph drag-to-move).
    map.on(
      "mousemove",
      "pois-fill",
      (e: MapMouseEvent & { features?: any[] }) => {
        if (pinning.value || dragRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        map.getCanvas().style.cursor = "grab";
        tooltip
          .setLngLat(e.lngLat)
          .setHTML(tooltipHtml(f.properties as Poi))
          .addTo(map);
      },
    );
    map.on("mouseleave", "pois-fill", () => {
      if (!dragRef.current) map.getCanvas().style.cursor = "";
      tooltip.remove();
    });

    // Click feature: select. Click bare map: pin or clear.
    map.on(
      "click",
      "pois-fill",
      (e: MapMouseEvent & { features?: any[] }) => {
        if (pinning.value) return;
        const f = e.features?.[0];
        if (!f) return;
        selectedId.value = Number((f.properties as { id: number }).id);
      },
    );
    map.on("click", async (e) => {
      if (pinning.value) {
        await createAt(e.lngLat.lng, e.lngLat.lat);
        pinning.value = false;
        return;
      }
      const hits = map.queryRenderedFeatures(e.point, {
        layers: ["pois-fill"],
      });
      if (hits.length === 0) selectedId.value = null;
    });

    // Drag: mousedown on a feature -> disable map pan, track drag in ref.
    // mousemove updates the source live. mouseup commits via PUT.
    map.on(
      "mousedown",
      "pois-fill",
      (e: MapMouseEvent & { features?: any[] }) => {
        if (pinning.value) return;
        const f = e.features?.[0];
        if (!f) return;
        e.preventDefault();
        const id = Number((f.properties as { id: number }).id);
        dragRef.current = { id, lng: e.lngLat.lng, lat: e.lngLat.lat };
        map.getCanvas().style.cursor = "grabbing";
        tooltip.remove();
      },
    );
    map.on("mousemove", (e) => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.lng = e.lngLat.lng;
      drag.lat = e.lngLat.lat;
      setSourceData();
    });
    const finishDrag = async () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      map.getCanvas().style.cursor = "";
      const original = pois.value.find((p) => p.id === drag.id);
      if (!original) return;
      try {
        const updated = await api.update(drag.id, {
          name: original.name,
          poi_type: original.poi_type,
          longitude: drag.lng,
          latitude: drag.lat,
          valid_from: original.valid_from,
          valid_to: original.valid_to,
        });
        pois.value = pois.value.map((p) =>
          p.id === drag.id ? updated : p,
        );
        lastDragCommit.value = {
          id: drag.id,
          lng: updated.longitude,
          lat: updated.latitude,
          ts: Date.now(),
        };
      } catch (err) {
        showError(err);
        await refresh();
      }
    };
    map.on("mouseup", finishDrag);
    // Releasing outside the canvas should still commit/cancel.
    map.getCanvas().addEventListener("mouseleave", () => {
      if (dragRef.current) finishDrag();
    });

    // Push data + selection updates whenever signals change.
    const stopSync = effect(() => {
      void pois.value;
      setSourceData();
    });
    const stopSel = effect(() => {
      void selectedId.value;
      setSelectionFilter();
    });
    const stopCursor = effect(() => {
      const m = mapRef.current;
      if (!m) return;
      // Don't override drag cursor.
      if (dragRef.current) return;
      m.getCanvas().style.cursor = pinning.value ? "crosshair" : "";
    });

    return () => {
      stopSync();
      stopSel();
      stopCursor();
      tooltip.remove();
      map.remove();
      mapRef.current = null;
      styleLoaded.current = false;
      dragRef.current = null;
      mapApi = null;
    };
  }, []);

  return (
    <main class="map">
      <div class="map-canvas" ref={ref} />
      {pinning.value && (
        <div class="pinning">Click map to place new POI (esc to cancel)</div>
      )}
      {errMsg.value && <div class="banner-error">{errMsg.value}</div>}
      {notice.value && <div class="banner-notice">{notice.value}</div>}
    </main>
  );
}

async function createAt(lon: number, lat: number): Promise<void> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 24 * 3600 * 1000);
  end.setHours(23, 59, 59, 0);
  try {
    const created = await api.create({
      name: "New POI",
      poi_type: "event",
      longitude: lon,
      latitude: lat,
      valid_from: start.toISOString(),
      valid_to: end.toISOString(),
    });
    pois.value = [...pois.value, created];
    selectedId.value = created.id;
  } catch (e) {
    showError(e);
  }
}

// ---------- sidebar ----------

function Header() {
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickFile = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    pendingImport.value = { name: file.name, xml: await file.text() };
  };

  return (
    <header class="bar">
      <h1>poiman</h1>
      <span class="status">{pois.value.length} POIs</span>
      <span class="spacer" />
      {currentUser.value && (
        <span class="status user" title="Signed in as">
          {currentUser.value}
        </span>
      )}
      <button
        class="primary"
        onClick={() => {
          pinning.value = !pinning.value;
        }}
      >
        {pinning.value ? "Cancel" : "+ Add POI"}
      </button>
      <button onClick={() => fileRef.current?.click()}>Import NeTEx</button>
      <input
        ref={fileRef}
        type="file"
        accept=".xml,application/xml,text/xml"
        style="display:none"
        onChange={onPickFile}
      />
      <a class="button" href="/api/export/netex" download>
        Download NeTEx
      </a>
    </header>
  );
}

function List() {
  const rows = visiblePois.value;
  const isLoading = loading.value;
  const total = pois.value.length;

  let emptyText: string | null = null;
  if (isLoading) emptyText = "Loading...";
  else if (total === 0) emptyText = "No POIs yet. Use \"+ Add POI\" or import a NeTEx file.";
  else if (rows.length === 0) emptyText = "No POIs match the current filters.";

  return (
    <div class="list">
      {emptyText && (
        <div style="padding:12px;color:#9ca3af">{emptyText}</div>
      )}
      {rows.map((p) => (
        <div
          key={p.id}
          class={`row ${selectedId.value === p.id ? "selected" : ""}`}
        >
          <div
            class="row-name"
            title="Zoom to POI"
            onClick={() => mapApi?.focus(p)}
          >
            {p.name}
          </div>
          <div class="row-meta">
            <span class={`type type-${p.poi_type}`}>{p.poi_type}</span>
            <span class="dates">
              {p.valid_from.slice(0, 10)} - {p.valid_to.slice(0, 10)}
            </span>
            <span class="row-actions">
              <button
                class="row-btn"
                title="Edit"
                aria-label="Edit"
                onClick={() => {
                  selectedId.value = p.id;
                  mapApi?.focus(p);
                }}
              >
                <PencilIcon />
              </button>
              <button
                class="row-btn danger"
                title="Delete"
                aria-label="Delete"
                onClick={() => {
                  pendingDelete.value = p;
                }}
              >
                <TrashIcon />
              </button>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

type Draft = {
  name: string;
  poi_type: string;
  longitude: number;
  latitude: number;
  valid_from: string;
  valid_to: string;
};

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

function draftFrom(p: Poi): Draft {
  return {
    name: p.name,
    poi_type: p.poi_type,
    longitude: round5(p.longitude),
    latitude: round5(p.latitude),
    valid_from: toDateInput(p.valid_from),
    valid_to: toDateInput(p.valid_to),
  };
}

function Form() {
  const sel = selectedPoi.value;
  const [draft, setDraft] = useState<Draft | null>(sel ? draftFrom(sel) : null);

  // Reset draft only when the selected id (or selection cleared) changes,
  // not on every server-side refresh of the same row.
  useEffect(() => {
    setDraft(sel ? draftFrom(sel) : null);
  }, [sel?.id]);

  // Drag-to-move on the map commits via PUT and bumps lastDragCommit. Pull
  // those new coordinates into the draft (only when the dragged POI is the
  // one currently being edited). A bare `pois.value` refresh that happens
  // for unrelated reasons no longer overwrites in-flight lon/lat keystrokes.
  const drag = lastDragCommit.value;
  useEffect(() => {
    if (!drag || !sel || drag.id !== sel.id) return;
    setDraft((d) =>
      d ? { ...d, longitude: round5(drag.lng), latitude: round5(drag.lat) } : d,
    );
  }, [drag?.ts]);

  if (!sel || !draft) {
    return (
      <div class="form">
        <h3>No POI selected</h3>
        <div style="grid-column:1/-1;color:#6b7280;font-size:12px">
          Click a POI on the map or in the list to edit, or use "+ Add POI".
        </div>
      </div>
    );
  }

  const update = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => (d ? { ...d, [k]: v } : d));
  };

  const save = async () => {
    try {
      const updated = await api.update(sel.id, {
        name: draft.name,
        poi_type: draft.poi_type,
        longitude: Number(draft.longitude),
        latitude: Number(draft.latitude),
        valid_from: fromDateInput(draft.valid_from, "00:00:00"),
        valid_to: fromDateInput(draft.valid_to, "23:59:59"),
      });
      pois.value = pois.value.map((p) => (p.id === sel.id ? updated : p));
    } catch (e) {
      showError(e);
    }
  };

  const remove = () => {
    pendingDelete.value = sel;
  };

  return (
    <div class="form">
      <h3>Edit POI #{sel.id}</h3>
      <label>Name</label>
      <input
        value={draft.name}
        onInput={(e) => update("name", (e.target as HTMLInputElement).value)}
      />
      <label>Type</label>
      <select
        value={draft.poi_type}
        onChange={(e) =>
          update("poi_type", (e.target as HTMLSelectElement).value)
        }
      >
        <option value="concert">concert</option>
        <option value="festival">festival</option>
        <option value="event">event</option>
      </select>
      <label>Lon / Lat</label>
      <div class="form-pair">
        <input
          type="number"
          step="0.00001"
          aria-label="Longitude"
          value={draft.longitude}
          onInput={(e) =>
            update("longitude", Number((e.target as HTMLInputElement).value))
          }
        />
        <input
          type="number"
          step="0.00001"
          aria-label="Latitude"
          value={draft.latitude}
          onInput={(e) =>
            update("latitude", Number((e.target as HTMLInputElement).value))
          }
        />
      </div>
      <label>From / To</label>
      <div class="form-pair">
        <input
          type="date"
          aria-label="Valid from"
          value={draft.valid_from}
          onInput={(e) =>
            update("valid_from", (e.target as HTMLInputElement).value)
          }
        />
        <input
          type="date"
          aria-label="Valid to"
          value={draft.valid_to}
          onInput={(e) =>
            update("valid_to", (e.target as HTMLInputElement).value)
          }
        />
      </div>
      <div class="actions">
        <button class="primary" onClick={save}>
          Save
        </button>
        <button class="danger" onClick={remove}>
          Delete
        </button>
        <button
          class="ghost"
          onClick={() => {
            selectedId.value = null;
          }}
        >
          Close
        </button>
      </div>
      <div class="form-meta">
        {sel.last_edited_by ? (
          <>
            Last edited by <strong>{sel.last_edited_by}</strong>
            {" on "}
            {new Date(sel.updated_at).toLocaleString()}
          </>
        ) : (
          <>Last updated {new Date(sel.updated_at).toLocaleString()}</>
        )}
      </div>
    </div>
  );
}

function Sidebar() {
  return (
    <aside class="side">
      <div class="filters">
        <input
          placeholder="Search names..."
          value={filterText.value}
          onInput={(e) =>
            (filterText.value = (e.target as HTMLInputElement).value)
          }
        />
        <select
          value={filterType.value}
          onChange={(e) =>
            (filterType.value = (e.target as HTMLSelectElement)
              .value as typeof filterType.value)
          }
        >
          <option value="all">All types</option>
          <option value="concert">concerts</option>
          <option value="festival">festivals</option>
          <option value="event">events</option>
        </select>
        <select
          value={filterTime.value}
          onChange={(e) =>
            (filterTime.value = (e.target as HTMLSelectElement)
              .value as typeof filterTime.value)
          }
        >
          <option value="all">All times</option>
          <option value="current">current</option>
          <option value="future">future</option>
          <option value="outdated">outdated</option>
        </select>
      </div>
      <List />
      <Form />
    </aside>
  );
}

function ImportDialog() {
  const job = pendingImport.value;
  if (!job) return null;

  const cancel = () => {
    if (importing.value) return;
    pendingImport.value = null;
  };

  const run = async (mode: "merge" | "replace") => {
    importing.value = true;
    try {
      const result = await api.importNetex(job.xml, mode);
      await refresh();
      const extra = result.replaced ? `, replaced ${result.replaced}` : "";
      flashNotice(`Imported ${result.imported} POIs (${mode}${extra}).`);
      pendingImport.value = null;
    } catch (err) {
      showError(err);
    } finally {
      importing.value = false;
    }
  };

  // Cheap count: number of <TopographicPlace> open tags in the file.
  const count = (job.xml.match(/<TopographicPlace\b/g) ?? []).length;

  return (
    <div class="modal-backdrop" onClick={cancel}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Import NeTEx</h2>
        <p>
          File: <code>{job.name}</code>
          {count > 0 && (
            <>
              <br />
              <span style="color:#6b7280">{count} POIs detected</span>
            </>
          )}
        </p>
        <div class="modal-options">
          <label>
            <strong>Merge</strong>
            <span>
              Upsert by id. Existing POIs in the file overwrite by id; POIs
              not in the file are kept.
            </span>
          </label>
          <label>
            <strong>Replace</strong>
            <span>
              Soft-delete every current POI first, then insert from the
              file. Drops anything not in the file.
            </span>
          </label>
        </div>
        <div class="modal-actions">
          <button
            class="ghost"
            disabled={importing.value}
            onClick={cancel}
          >
            Cancel
          </button>
          <button
            class="danger"
            disabled={importing.value}
            onClick={() => run("replace")}
          >
            Replace all
          </button>
          <button
            class="primary"
            disabled={importing.value}
            onClick={() => run("merge")}
          >
            {importing.value ? "Importing..." : "Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteDialog() {
  const target = pendingDelete.value;
  if (!target) return null;
  const cancel = () => {
    pendingDelete.value = null;
  };
  const confirm = async () => {
    try {
      await api.remove(target.id);
      batch(() => {
        pois.value = pois.value.filter((x) => x.id !== target.id);
        if (selectedId.value === target.id) selectedId.value = null;
        pendingDelete.value = null;
      });
    } catch (e) {
      showError(e);
      pendingDelete.value = null;
    }
  };
  return (
    <div class="modal-backdrop" onClick={cancel}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Delete POI</h2>
        <p>
          Soft-delete <strong>{target.name}</strong>? It will disappear from
          the map and from the NeTEx export. The row stays in the database
          and can be restored manually if needed.
        </p>
        <div class="modal-actions">
          <button class="ghost" onClick={cancel}>
            Cancel
          </button>
          <button class="danger" onClick={confirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  useEffect(() => {
    refresh();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pendingDelete.value) pendingDelete.value = null;
      else if (pendingImport.value && !importing.value) pendingImport.value = null;
      else pinning.value = false;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div class="app">
      <Header />
      <Sidebar />
      <MapView />
      <ImportDialog />
      <DeleteDialog />
    </div>
  );
}

// ---------- bootstrap ----------

// Wrapper around <App /> that triggers an Auth0 login redirect when the
// user isn't authenticated yet. Mirrors the canonical pattern from
// entur/nirgali/src/index.tsx.
function AuthenticatedApp() {
  const auth = useAuth();
  useEffect(() => {
    if (
      !hasAuthParams() &&
      !auth.isAuthenticated &&
      !auth.activeNavigator &&
      !auth.isLoading
    ) {
      auth.signinRedirect().catch((err: unknown) => {
        console.error("signinRedirect failed", err);
      });
    }
  }, [auth.isAuthenticated, auth.activeNavigator, auth.isLoading]);

  // Mirror the live access token + user email into module-level signals so
  // api.ts and the rest of the app can read them without hooks.
  useEffect(() => {
    accessToken.value = auth.user?.access_token ?? null;
    currentUser.value = auth.user?.profile.email ?? null;
  }, [auth.user]);

  // Stale token -> 401 -> kick the user back through the OIDC flow rather
  // than leaving them stuck on a stuck error banner. signinRedirect() with
  // the existing session just refreshes the access token; if the SSO
  // session is also gone, the user logs in again.
  useEffect(() => {
    onUnauthorized.value = () => {
      auth.signinRedirect().catch((err: unknown) => {
        console.error("re-auth failed", err);
      });
    };
    return () => {
      onUnauthorized.value = null;
    };
  }, [auth.signinRedirect]);

  if (!auth.isAuthenticated) return null;
  return <App />;
}

async function bootstrap(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) return;

  let oidcConfig: UserManagerSettings | null = null;
  try {
    const cfg = (await fetch("/config.json").then((r) => r.json())) as {
      oidcConfig: UserManagerSettings | null;
    };
    oidcConfig = cfg.oidcConfig;
  } catch (err) {
    console.error("failed to load /config.json", err);
  }

  if (!oidcConfig) {
    // Local dev with no Auth0 wired up: render the app directly. The
    // backend's POIMAN_DEV bypass stamps edits with dev@local.
    render(<App />, root);
    return;
  }

  render(
    <AuthProvider
      {...oidcConfig}
      onSigninCallback={() =>
        history.replaceState({}, document.title, location.pathname)
      }
      redirect_uri={location.origin}
    >
      <AuthenticatedApp />
    </AuthProvider>,
    root,
  );
}

bootstrap();
