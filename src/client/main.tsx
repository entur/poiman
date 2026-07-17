import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { signal, computed, effect, batch } from "@preact/signals";
import {
  AuthProvider,
  hasAuthParams,
  useAuth,
} from "react-oidc-context";
import { WebStorageStateStore, type UserManagerSettings } from "oidc-client-ts";
import {
  accessToken,
  authDisabled,
  currentUser,
  editors,
  idToken,
  isEditor,
  onLogout,
  onUnauthorized,
} from "./api.ts";
import { POI_TYPES, type PoiType } from "../shared/poiTypes.ts";
import maplibregl, {
  type Map as MlMap,
  type GeoJSONSource,
  type MapMouseEvent,
  type MapTouchEvent,
  type FlyToOptions,
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
const showRecent = signal(false);
const recentPage = signal(0);

// Which panel the narrow-screen layout shows. Ignored above the mobile
// breakpoint, where the list and map are side by side.
const mobileView = signal<"list" | "map">("map");

// Keep in sync with the CSS breakpoint in style.css.
const MOBILE_MEDIA = "(max-width: 720px)";

// Reactive "is the narrow layout active" flag, driven once off matchMedia.
const isNarrow = signal(false);
{
  const mq = window.matchMedia(MOBILE_MEDIA);
  isNarrow.value = mq.matches;
  mq.addEventListener("change", (e) => (isNarrow.value = e.matches));
}

// How many entries the Recent changes dialog renders per page.
const RECENT_PAGE_SIZE = 10;

// Form draft, lifted to module scope so dirty-checking and navigation
// blocking can read it from outside the Form component. Mutated by the
// form inputs, by drag-to-move, and by address search confirmations.
type Draft = {
  name: string;
  poi_type: string;
  longitude: number;
  latitude: number;
  valid_from: string;
  valid_to: string;
};
const draft = signal<Draft | null>(null);

// Pending navigation when the user tries to switch away from a dirty
// form. The `to` is the next selectedId we'd jump to (null = clear).
const pendingNav = signal<number | null | undefined>(undefined);

// Pending address-search pick. When set, the form shows a confirm modal
// asking whether to move the location.
const pendingAddressMove = signal<{ label: string; lon: number; lat: number } | null>(null);

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

// POIs drawn on the map: the filtered set, plus the selected POI even when
// the active filter would hide it - so you never end up editing a marker
// that isn't on the map.
const mapPois = computed(() => {
  const rows = visiblePois.value;
  const sel = selectedPoi.value;
  return sel && !rows.some((p) => p.id === sel.id) ? [...rows, sel] : rows;
});

// Loading / empty / no-match message, shared by the list and the map so a
// blank map view (the mobile default) still explains itself. null = have rows.
const statusMessage = computed(() => {
  if (loading.value) return "Loading...";
  if (pois.value.length === 0)
    return 'No POIs yet. Use "+ Add POI" or import a NeTEx file.';
  if (visiblePois.value.length === 0) return "No POIs match the current filters.";
  return null;
});

function draftFromPoi(p: Poi): Draft {
  return {
    name: p.name,
    poi_type: p.poi_type,
    longitude: round5(p.longitude),
    latitude: round5(p.latitude),
    valid_from: toDateInput(p.valid_from),
    valid_to: toDateInput(p.valid_to),
  };
}

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

const draftBaseline = computed(() => {
  const p = selectedPoi.value;
  return p ? draftFromPoi(p) : null;
});

// Dirty if any field of the live draft differs from the baseline (the
// last server-known state for the selected POI).
const isDirty = computed(() => {
  const d = draft.value;
  const b = draftBaseline.value;
  if (!d || !b) return false;
  return (
    d.name !== b.name ||
    d.poi_type !== b.poi_type ||
    d.longitude !== b.longitude ||
    d.latitude !== b.latitude ||
    d.valid_from !== b.valid_from ||
    d.valid_to !== b.valid_to
  );
});

// Reset draft from baseline whenever the selection changes (and the
// existing draft isn't dirty - if it is, the navigation gate should
// have caught the change before it landed here).
effect(() => {
  const b = draftBaseline.value;
  draft.value = b ? { ...b } : null;
});

// Navigation gate: requested target id (number | null) goes through
// here. If the form is dirty, stash in pendingNav so the modal can ask;
// otherwise commit immediately.
function requestSelect(id: number | null): void {
  if (id === selectedId.value) return;
  if (isDirty.value) {
    pendingNav.value = id;
    return;
  }
  selectedId.value = id;
}

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

function formatRelative(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, now - t);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
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

const UndoIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);

const EyeIcon = () => (
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
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
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

const ChevronIcon = () => (
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
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

// A styled, keyboard-accessible replacement for <select>. Native option
// popups render at an OS size that mobile shrinks to near-unreadable and
// can't be styled; this is normal DOM we control. The open menu is
// positioned `fixed` so it isn't clipped by the edit sheet's scroll box.
function Dropdown<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  dirty = false,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  dirty?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<
    { top: number; left: number; width: number } | null
  >(null);
  const ref = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const openMenu = () => {
    const r = toggleRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 2, left: r.left, width: r.width });
    setActive(selectedIndex);
    setOpen(true);
  };
  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) toggleRef.current?.focus();
  };
  const choose = (i: number) => {
    const o = options[i];
    if (o) onChange(o.value);
    close();
  };

  // Roving focus: keep the active option focused so keyboard + SR users
  // land on it.
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelectorAll<HTMLButtonElement>(".dropdown-option")
      ?.[active]?.focus();
  }, [open, active]);

  // While open, close on an outside pointer or on any scroll (the fixed
  // menu can't follow a scrolling ancestor).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (
        t instanceof Node &&
        !ref.current?.contains(t) &&
        !menuRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(i + 1, options.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(active);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <div class="dropdown" ref={ref} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={toggleRef}
        class={`dropdown-toggle ${dirty ? "dirty" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
      >
        <span class="dropdown-label">{current?.label ?? value}</span>
        <ChevronIcon />
      </button>
      {open && pos && (
        <div
          class="dropdown-menu"
          role="listbox"
          aria-label={ariaLabel}
          ref={menuRef}
          style={{
            top: `${pos.top}px`,
            left: `${pos.left}px`,
            width: `${pos.width}px`,
          }}
        >
          {options.map((o, i) => (
            <button
              type="button"
              key={o.value}
              role="option"
              tabIndex={-1}
              aria-selected={o.value === value}
              class={`dropdown-option ${o.value === value ? "selected" : ""}`}
              onClick={() => choose(i)}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- map ----------

// Module-level handle to the map's imperative API (set once by MapView).
let mapApi: { focus: (p: Poi) => void } | null = null;

const COLORS: Record<string, string> = {
  concert: "#e63946",
  festival: "#1d4ed8",
  event: "#f59e0b",
};

type DragOverride = {
  id: number;
  lng: number;
  lat: number;
  // Screen-pixel coords at mousedown. Used to distinguish "click on the
  // marker" (no movement) from "drag to nudge" - a click should never
  // mutate the draft, even if the lngLat under the cursor differs by a
  // hair from the marker's stored position.
  startX: number;
  startY: number;
};

// Cursor must travel at least this many CSS pixels between mousedown
// and mouseup to count as a drag.
const DRAG_THRESHOLD_PX = 4;

function toGeoJSON(rows: Poi[], drag: DragOverride | null) {
  // Render the selected POI at the draft's lat/lon (if set) so that
  // form-side changes (address pick, manual edit, drag-into-draft) show
  // up live on the map without saving. drag override wins over draft.
  const selId = selectedId.value;
  const d = draft.value;
  return {
    type: "FeatureCollection" as const,
    features: rows.map((p) => {
      let coords: [number, number] = [p.longitude, p.latitude];
      if (drag && drag.id === p.id) coords = [drag.lng, drag.lat];
      else if (selId === p.id && d) coords = [d.longitude, d.latitude];
      return {
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
        geometry: { type: "Point" as const, coordinates: coords },
      };
    }),
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
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );

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
      src.setData(toGeoJSON(mapPois.value, dragRef.current));
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
        const opts: FlyToOptions = {
          center: [p.longitude, p.latitude],
          zoom: Math.max(map.getZoom(), 13),
          speed: 1.6,
        };
        // On narrow screens the bottom sheet covers the lower part of the
        // map, so bias the camera upward to keep the marker visible above
        // it. Only set padding when needed - passing undefined trips
        // MapLibre's padding comparison.
        if (isNarrow.value) {
          opts.padding = {
            top: 0,
            right: 0,
            left: 0,
            bottom: Math.round(window.innerHeight * 0.55),
          };
        }
        map.flyTo(opts);
      },
    };

    map.on("load", () => {
      styleLoaded.current = true;
      map.addSource("pois", {
        type: "geojson",
        data: toGeoJSON(mapPois.value, dragRef.current),
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
      // Fit the camera to all POIs the first time data lands.
      // initialFitDone gates this so it runs exactly once per mount;
      // we don't bother disposing the effect since MapView lives for
      // the app's lifetime. (Self-disposing here would TDZ: when the
      // body runs synchronously the first time, the const holding the
      // effect's dispose hasn't been assigned yet.)
      effect(() => {
        const list = pois.value;
        if (list.length === 0 || initialFitDone.current) return;
        initialFitDone.current = true;
        const b = new maplibregl.LngLatBounds();
        for (const p of list) b.extend([p.longitude, p.latitude]);
        map.fitBounds(b, { padding: 40, maxZoom: 12, duration: 0 });
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
        requestSelect(Number((f.properties as { id: number }).id));
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
      if (hits.length === 0) requestSelect(null);
    });

    // Drag: mousedown on a feature -> disable map pan, track drag in ref.
    // mousemove updates the source live. mouseup commits via PUT.
    map.on(
      "mousedown",
      "pois-fill",
      (e: MapMouseEvent & { features?: any[] }) => {
        if (pinning.value) return;
        // Dragging mutates the POI; non-editors get read-only markers.
        if (!isEditor.value) return;
        const f = e.features?.[0];
        if (!f) return;
        const id = Number((f.properties as { id: number }).id);
        // Only the selected POI is draggable - dragging is a form edit,
        // not a navigation. Click selects first, then drag to nudge.
        if (id !== selectedId.value) return;
        e.preventDefault();
        dragRef.current = {
          id,
          lng: e.lngLat.lng,
          lat: e.lngLat.lat,
          startX: e.point.x,
          startY: e.point.y,
        };
        map.getCanvas().style.cursor = "grabbing";
        tooltip.remove();
      },
    );
    // Touch equivalent of the mousedown drag start. Panning is disabled for
    // the duration so a finger-drag nudges the marker instead of the map.
    map.on(
      "touchstart",
      "pois-fill",
      (e: MapTouchEvent & { features?: any[] }) => {
        if (pinning.value || !isEditor.value) return;
        const f = e.features?.[0];
        if (!f) return;
        const id = Number((f.properties as { id: number }).id);
        if (id !== selectedId.value) return;
        e.preventDefault();
        map.dragPan.disable();
        dragRef.current = {
          id,
          lng: e.lngLat.lng,
          lat: e.lngLat.lat,
          startX: e.point.x,
          startY: e.point.y,
        };
        tooltip.remove();
      },
    );
    const trackDrag = (e: MapMouseEvent | MapTouchEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.lng = e.lngLat.lng;
      drag.lat = e.lngLat.lat;
      setSourceData();
    };
    map.on("mousemove", trackDrag);
    map.on("touchmove", trackDrag);
    // Drag commits to the open form's draft (NOT to the API). The user
    // has to click Save to persist. If the dragged POI isn't currently
    // selected, this is a no-op for the draft - the existing GeoJSON
    // override falls away on the next sync.
    const finishDrag = (point?: { x: number; y: number }) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      map.getCanvas().style.cursor = "";
      map.dragPan.enable();
      // Treat tiny down/up jitter as a click/tap, not a drag.
      const dx = (point?.x ?? drag.startX) - drag.startX;
      const dy = (point?.y ?? drag.startY) - drag.startY;
      const moved = Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
      if (moved && selectedId.value === drag.id && draft.value) {
        draft.value = {
          ...draft.value,
          longitude: round5(drag.lng),
          latitude: round5(drag.lat),
        };
      } else {
        // Click/tap (or drag of a non-selected POI) - snap the visual back.
        setSourceData();
      }
    };
    map.on("mouseup", (e) => finishDrag(e.point));
    map.on("touchend", (e) => finishDrag(e.point));
    map.on("touchcancel", () => finishDrag());
    // Releasing outside the canvas should still commit/cancel.
    map.getCanvas().addEventListener("mouseleave", () => {
      if (dragRef.current) finishDrag();
    });

    // Push data + selection updates whenever signals change. Reading
    // mapPois subscribes to the filters (and the selected POI), so the map
    // markers track the sidebar filters. Draft lat/lon reads keep
    // address-pick / manual edits live on the map without a save.
    const stopSync = effect(() => {
      void mapPois.value;
      void draft.value;
      void selectedId.value;
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
      {!pinning.value && statusMessage.value && (
        <div class="map-status">{statusMessage.value}</div>
      )}
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
    requestSelect(created.id);
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
      <img class="logo" src="/entur.png" alt="Entur" />
      <h1>poiman</h1>
      <span class="status">{pois.value.length} POIs</span>
      <span class="spacer" />
      {currentUser.value && (
        <>
          <span class="status user" title="Signed in as">
            {currentUser.value}
          </span>
          {onLogout.value && (
            <button
              class="ghost"
              title="Sign out"
              onClick={() => onLogout.value?.()}
            >
              Logout
            </button>
          )}
        </>
      )}
      {isEditor.value && (
        <>
          <button
            class="primary"
            onClick={() => {
              pinning.value = !pinning.value;
              // Placing a pin needs the map; surface it on mobile.
              if (pinning.value) mobileView.value = "map";
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
        </>
      )}
      <button
        onClick={() => {
          recentPage.value = 0;
          showRecent.value = true;
        }}
      >
        Recent changes
      </button>
      <a class="button" href="/api/export/netex" download>
        Download NeTEx
      </a>
    </header>
  );
}

function List() {
  const rows = visiblePois.value;
  const emptyText = statusMessage.value;

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
            onClick={() => {
              // On mobile the row tap is how you open a POI, so select it
              // too; desktop keeps zoom-to and edit as separate actions.
              if (!isNarrow.value) {
                mapApi?.focus(p);
                return;
              }
              requestSelect(p.id);
              // Only reveal/fly the map once the selection actually commits
              // (a dirty form routes through the confirm gate instead).
              if (selectedId.value === p.id) {
                mobileView.value = "map";
                mapApi?.focus(p);
              }
            }}
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
                title={isEditor.value ? "Edit" : "View"}
                aria-label={isEditor.value ? "Edit" : "View"}
                onClick={() => {
                  requestSelect(p.id);
                  mapApi?.focus(p);
                }}
              >
                {isEditor.value ? <PencilIcon /> : <EyeIcon />}
              </button>
              {isEditor.value && (
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
              )}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function AddressSearch({
  onPick,
}: {
  onPick: (label: string, lon: number, lat: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    { label: string; lon: number; lat: number }[]
  >([]);
  const [open, setOpen] = useState(false);

  // Debounced fetch on every query change. AbortController cancels any
  // in-flight request when the user keeps typing.
  useEffect(() => {
    if (query.trim().length < 3) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await api.searchAddress(query);
        if (!ctrl.signal.aborted) {
          setResults(r);
          setOpen(true);
        }
      } catch (err) {
        if (!ctrl.signal.aborted) console.error("address search failed", err);
      }
    }, 300);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <div class="address-search">
      <input
        type="search"
        placeholder="Search for address"
        value={query}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && results.length > 0 && (
        <div class="address-results">
          {results.map((r, i) => (
            <button
              key={i}
              type="button"
              class="address-result"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(r.label, r.lon, r.lat);
                setQuery(r.label);
                setOpen(false);
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Form() {
  const sel = selectedPoi.value;
  const d = draft.value;
  const baseline = draftBaseline.value;

  if (!sel || !d || !baseline) {
    return (
      <div class="form form-empty">
        <h3>No POI selected</h3>
        <div style="grid-column:1/-1;color:#6b7280;font-size:12px">
          Click a POI on the map or in the list to edit, or use "+ Add POI".
        </div>
      </div>
    );
  }

  const update = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    draft.value = { ...d, [k]: v };
  };

  const dirtyClass = (k: keyof Draft) =>
    d[k] !== baseline[k] ? "dirty" : "";

  const save = async () => {
    try {
      const updated = await api.update(sel.id, {
        name: d.name,
        poi_type: d.poi_type,
        longitude: Number(d.longitude),
        latitude: Number(d.latitude),
        valid_from: fromDateInput(d.valid_from, "00:00:00"),
        valid_to: fromDateInput(d.valid_to, "23:59:59"),
      });
      pois.value = pois.value.map((p) => (p.id === sel.id ? updated : p));
    } catch (e) {
      showError(e);
    }
  };

  const remove = () => {
    pendingDelete.value = sel;
  };

  const ro = !isEditor.value;
  return (
    <div class="form">
      <button
        class="form-close"
        type="button"
        aria-label="Close"
        onClick={() => requestSelect(null)}
      >
        {"×"}
      </button>
      <h3>{ro ? `POI #${sel.id}` : `Edit POI #${sel.id}`}</h3>
      <label>Name</label>
      <input
        class={dirtyClass("name")}
        value={d.name}
        readOnly={ro}
        onInput={(e) => update("name", (e.target as HTMLInputElement).value)}
      />
      <label>Type</label>
      <Dropdown
        ariaLabel="Type"
        value={d.poi_type}
        disabled={ro}
        dirty={d.poi_type !== baseline.poi_type}
        onChange={(v) => update("poi_type", v)}
        options={POI_TYPES.map((t) => ({ value: t, label: t }))}
      />
      {!ro && (
        <>
          <label>Address</label>
          <AddressSearch
            onPick={(label, lon, lat) => {
              pendingAddressMove.value = { label, lon, lat };
            }}
          />
        </>
      )}
      <label>Lon / Lat</label>
      <div class="form-pair">
        <input
          type="number"
          step="0.00001"
          aria-label="Longitude"
          class={dirtyClass("longitude")}
          value={d.longitude}
          readOnly={ro}
          onInput={(e) =>
            update("longitude", Number((e.target as HTMLInputElement).value))
          }
        />
        <input
          type="number"
          step="0.00001"
          aria-label="Latitude"
          class={dirtyClass("latitude")}
          value={d.latitude}
          readOnly={ro}
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
          class={dirtyClass("valid_from")}
          value={d.valid_from}
          readOnly={ro}
          onInput={(e) =>
            update("valid_from", (e.target as HTMLInputElement).value)
          }
        />
        <input
          type="date"
          aria-label="Valid to"
          class={dirtyClass("valid_to")}
          value={d.valid_to}
          readOnly={ro}
          onInput={(e) =>
            update("valid_to", (e.target as HTMLInputElement).value)
          }
        />
      </div>
      {!ro && (
        <div class="actions">
          <button class="primary" onClick={save} disabled={!isDirty.value}>
            Save
          </button>
          <button class="danger" onClick={remove}>
            Delete
          </button>
          <button class="ghost" onClick={() => requestSelect(null)}>
            Close
          </button>
          <button
            class="icon-btn"
            title="Discard unsaved changes"
            aria-label="Discard unsaved changes"
            disabled={!isDirty.value}
            onClick={() => {
              draft.value = { ...baseline };
            }}
          >
            <UndoIcon />
          </button>
        </div>
      )}
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

// Narrow-screen List/Map switch. Hidden by CSS above the breakpoint. It's a
// pair of toggle buttons (aria-pressed), not a tablist - there are no
// separate tabpanels, the same panes just show/hide.
function MobileTabs() {
  return (
    <div class="mobile-tabs">
      <button
        aria-pressed={mobileView.value === "list"}
        class={mobileView.value === "list" ? "active" : ""}
        onClick={() => (mobileView.value = "list")}
      >
        List
      </button>
      <button
        aria-pressed={mobileView.value === "map"}
        class={mobileView.value === "map" ? "active" : ""}
        onClick={() => (mobileView.value = "map")}
      >
        Map
      </button>
    </div>
  );
}

// The filters apply to both the list and the map markers, so they live
// outside the collapsible list panel and stay visible in every view.
function Filters() {
  return (
    <div class="filters">
      <input
        placeholder="Search names..."
        value={filterText.value}
        onInput={(e) =>
          (filterText.value = (e.target as HTMLInputElement).value)
        }
      />
      <Dropdown
        ariaLabel="Filter by type"
        value={filterType.value}
        onChange={(v) => (filterType.value = v)}
        options={[
          { value: "all", label: "All types" },
          ...POI_TYPES.map((t) => ({ value: t, label: `${t}s` })),
        ]}
      />
      <Dropdown
        ariaLabel="Filter by time"
        value={filterTime.value}
        onChange={(v) => (filterTime.value = v)}
        options={[
          { value: "all", label: "All times" },
          { value: "current", label: "current" },
          { value: "future", label: "future" },
          { value: "outdated", label: "outdated" },
        ]}
      />
    </div>
  );
}

function Sidebar() {
  return (
    <aside class="side">
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

function AddressMoveDialog() {
  const pick = pendingAddressMove.value;
  const sel = selectedPoi.value;
  if (!pick || !sel) return null;
  const cancel = () => {
    pendingAddressMove.value = null;
  };
  const apply = () => {
    const d = draft.value;
    if (!d) return;
    draft.value = {
      ...d,
      longitude: round5(pick.lon),
      latitude: round5(pick.lat),
    };
    mapApi?.focus({ ...sel, longitude: pick.lon, latitude: pick.lat });
    pendingAddressMove.value = null;
  };
  return (
    <div class="modal-backdrop" onClick={cancel}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Move location</h2>
        <p>
          Move <strong>{sel.name}</strong> to <code>{pick.label}</code>?
          The change is staged in the form; click Save to persist.
        </p>
        <div class="modal-actions">
          <button class="ghost" onClick={cancel}>
            Cancel
          </button>
          <button class="primary" onClick={apply}>
            Move here
          </button>
        </div>
      </div>
    </div>
  );
}

function RecentChangesDialog() {
  if (!showRecent.value) return null;
  const close = () => {
    showRecent.value = false;
  };
  const now = Date.now();
  const sorted = [...pois.value].sort(
    (a, b) =>
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );
  const total = sorted.length;
  const pageCount = Math.max(1, Math.ceil(total / RECENT_PAGE_SIZE));
  // Clamp without writing back during render; the button handlers always
  // produce a valid page, but pois mutations under us could shrink the list.
  const page = Math.min(recentPage.value, pageCount - 1);
  const start = page * RECENT_PAGE_SIZE;
  const rows = sorted.slice(start, start + RECENT_PAGE_SIZE);
  const pick = (p: Poi) => {
    showRecent.value = false;
    requestSelect(p.id);
    mapApi?.focus(p);
  };
  return (
    <div class="modal-backdrop" onClick={close}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <button
          class="modal-close"
          type="button"
          aria-label="Close"
          onClick={close}
        >
          {"×"}
        </button>
        <h2>Recent changes</h2>
        {total === 0 ? (
          <p>No POIs yet.</p>
        ) : (
          <>
            <div class="recent-list">
              {rows.map((p) => {
                const sameAsCreate = p.updated_at === p.created_at;
                const who = p.last_edited_by ?? p.created_by ?? "unknown";
                return (
                  <button
                    type="button"
                    key={p.id}
                    class="recent-row"
                    onClick={() => pick(p)}
                  >
                    <span class={`type type-${p.poi_type}`}>{p.poi_type}</span>
                    <span class="recent-name">{p.name}</span>
                    <span
                      class="recent-when"
                      title={new Date(p.updated_at).toLocaleString()}
                    >
                      {sameAsCreate ? "created" : "edited"}{" "}
                      {formatRelative(p.updated_at, now)} by {who}
                    </span>
                  </button>
                );
              })}
            </div>
            <div class="pager">
              <button
                class="ghost"
                disabled={page <= 0}
                onClick={() => (recentPage.value = page - 1)}
              >
                Prev
              </button>
              <span class="pager-status">
                Page {page + 1} of {pageCount} ({total} POIs)
              </span>
              <button
                class="ghost"
                disabled={page >= pageCount - 1}
                onClick={() => (recentPage.value = page + 1)}
              >
                Next
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function NavBlockDialog() {
  const target = pendingNav.value;
  if (target === undefined) return null;
  const cancel = () => {
    pendingNav.value = undefined;
  };
  const discard = () => {
    pendingNav.value = undefined;
    selectedId.value = target;
  };
  const saveAndGo = async () => {
    const sel = selectedPoi.value;
    const d = draft.value;
    if (!sel || !d) {
      cancel();
      return;
    }
    try {
      const updated = await api.update(sel.id, {
        name: d.name,
        poi_type: d.poi_type,
        longitude: Number(d.longitude),
        latitude: Number(d.latitude),
        valid_from: fromDateInput(d.valid_from, "00:00:00"),
        valid_to: fromDateInput(d.valid_to, "23:59:59"),
      });
      pois.value = pois.value.map((p) => (p.id === sel.id ? updated : p));
      pendingNav.value = undefined;
      selectedId.value = target;
    } catch (e) {
      showError(e);
    }
  };
  return (
    <div class="modal-backdrop" onClick={cancel}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Unsaved changes</h2>
        <p>
          You have unsaved changes on this POI. Save them before navigating
          away, discard them, or stay on the current POI.
        </p>
        <div class="modal-actions">
          <button class="ghost" onClick={cancel}>
            Stay
          </button>
          <button class="danger" onClick={discard}>
            Discard
          </button>
          <button class="primary" onClick={saveAndGo}>
            Save and continue
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
      if (pendingNav.value !== undefined) pendingNav.value = undefined;
      else if (pendingAddressMove.value) pendingAddressMove.value = null;
      else if (pendingDelete.value) pendingDelete.value = null;
      else if (pendingImport.value && !importing.value) pendingImport.value = null;
      else if (showRecent.value) showRecent.value = false;
      else pinning.value = false;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Track the on-screen keyboard so the fixed bottom sheet (mobile) can sit
  // above it instead of being covered - iOS doesn't shift fixed elements.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty("--kb-inset", `${inset}px`);
    };
    onResize();
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);
    return () => {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", onResize);
    };
  }, []);

  return (
    <div
      class={`app mobile-${mobileView.value}${
        selectedId.value != null ? " sheet-open" : ""
      }`}
    >
      <Header />
      <MobileTabs />
      <Filters />
      <div class="content">
        <Sidebar />
        <MapView />
      </div>
      <ImportDialog />
      <DeleteDialog />
      <AddressMoveDialog />
      <NavBlockDialog />
      <RecentChangesDialog />
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
    // Surface auth errors (silent-renew failure, expired SSO session)
    // instead of looping back into signinRedirect, which would mask the
    // root cause. The user can then either retry or report what they see.
    if (auth.error) {
      console.error("auth error", auth.error);
      return;
    }
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
  }, [auth.isAuthenticated, auth.activeNavigator, auth.isLoading, auth.error]);

  // Mirror access + ID tokens and the user email synchronously in
  // render so api.ts sees them on the same commit as <App />. Doing this
  // in useEffect bites: effects run child-first, so App's mount-effect
  // (refresh -> /api/pois) fires BEFORE this parent effect, the bearer
  // is missing, the request 401s, onUnauthorized triggers a
  // signinRedirect, and F5 always bounces through Auth0. Signal writes
  // in render are explicitly supported by @preact/signals; writes to
  // unchanged values are no-ops.
  accessToken.value = auth.user?.access_token ?? null;
  idToken.value = auth.user?.id_token ?? null;
  // Lower-cased to match the server's canonical form, so isEditor can
  // compare directly against editors.json.
  const email = auth.user?.profile.email?.toLowerCase() ?? null;
  currentUser.value = email;

  useEffect(() => {
    if (auth.user && !email) {
      console.warn(
        "ID token has no `email` claim - last_edited_by will fall back to `sub`. " +
          "Check the Auth0 client's allowed scopes and tenant rules.",
      );
    }
    onUnauthorized.value = () => {
      auth.signinRedirect().catch((err: unknown) => {
        console.error("re-auth failed", err);
      });
    };
    onLogout.value = () => {
      auth.signoutRedirect().catch((err: unknown) => {
        console.error("signout failed", err);
      });
    };
  }, [auth, email]);

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
      editors: string[];
      authDisabled: boolean;
    };
    oidcConfig = cfg.oidcConfig;
    editors.value = cfg.editors;
    authDisabled.value = cfg.authDisabled;
  } catch (err) {
    console.error("failed to load /config.json", err);
  }

  if (!oidcConfig) {
    // Local dev with no Auth0 wired up: render the app directly. The
    // backend's DISABLE_AUTH bypass stamps edits with dev@local.
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
      // Persist the user across tab close and refresh; oidc-client-ts
      // defaults to sessionStorage which is wiped when the tab closes.
      // Trade-off: an XSS could exfiltrate tokens for off-origin reuse
      // until they expire; the same XSS can already drive the API
      // in-page, so the marginal risk is small for an internal tool.
      userStore={new WebStorageStateStore({ store: localStorage })}
    >
      <AuthenticatedApp />
    </AuthProvider>,
    root,
  );
}

bootstrap();
