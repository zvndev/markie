/// <reference types="vite/client" />

/** package.json's version, for Settings when not running on a device. */
declare const __MARKIE_MOBILE_VERSION__: string;

/** True only in `npm run dev` and `npm run build:dev` (vite.config.ts). Undefined under vitest. */
declare const __MARKIE_MOBILE_DEV_SERVERS__: boolean | undefined;
