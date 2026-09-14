export const DASHBOARD_DATA_UPDATED_EVENT = "parakh:data-updated";

export function announceDashboardDataUpdated(detail = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DASHBOARD_DATA_UPDATED_EVENT, { detail }));
}
