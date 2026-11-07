import runtimeSource from "./vendor/runtime.js.txt?raw";
import localFormBootstrapSource from "./local-form-bootstrap.js.txt?raw";
import linkBridgeSource from "./link-bridge.js.txt?raw";

/** Data only. Never execute this outside the separately authorized sandbox. */
export const DARKMOWN_RUNTIME_SOURCE = runtimeSource;
export const DARKMOWN_LOCAL_FORM_BOOTSTRAP_SOURCE = localFormBootstrapSource;
/** Desktop link bridge: a real click's href to the host, nothing else (preview.ts). */
export const DARKMOWN_LINK_BRIDGE_SOURCE = linkBridgeSource;
