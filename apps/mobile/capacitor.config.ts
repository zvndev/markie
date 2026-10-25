import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.zvn.markie.mobile",
  appName: "Markie",
  webDir: "dist",
  // Markie's dark background, so a cold start never flashes white.
  backgroundColor: "#09090b",
  // Capacitor's default logs every plugin call and its result in debug
  // builds: the session read from the Keychain, the Authorization header of
  // every request. None of that belongs in a device log, debug or not.
  loggingBehavior: "none",
  ios: {
    // The page draws under the bars itself and pads with env(safe-area-inset-*).
    contentInset: "never",
    // Pinch-zoom is the document's job, not the app shell's.
    zoomEnabled: false,
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    // Requests go through CapacitorHttp.request explicitly (src/lib/native-http.ts).
    // Neither global patch is wanted: the web view's fetch and document.cookie
    // stay the browser's own, and no cookie is ever relied on.
    CapacitorHttp: { enabled: false },
    CapacitorCookies: { enabled: false },
    SystemBars: { insetsHandling: "css", initialViewportFitValueHint: "cover" },
  },
};

export default config;
