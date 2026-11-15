/** Alarm push notifications (`/push/*`, Firebase Cloud Messaging web push). */

export interface PushStatus {
  /** false = the backend has no Firebase web app config: hide the button */
  enabled: boolean;
  /** the Firebase web app's public config, needed to get this browser's FCM token */
  config: { apiKey: string; appId: string; messagingSenderId: string; projectId: string } | null;
  vapid_key: string | null;
  /** alarm levels that are pushed, e.g. ["fault"] */
  levels: string[];
  /** devices this user has notifications on for */
  devices: number;
}
