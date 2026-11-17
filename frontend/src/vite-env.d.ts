/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** AI Assistant chat only (SSE): the Cloud Run API, bypassing Firebase Hosting's buffering rewrite */
  readonly VITE_ASSISTANT_API_BASE_URL?: string;
  /** Plant Map basemap: a public Mapbox `pk.` token (frontend/.env); empty = Esri tiles */
  readonly VITE_MAPBOX_TOKEN?: string;
}
