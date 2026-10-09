export const APP_NAME = 'Museta';
export const APP_VERSION = globalThis.chrome?.runtime?.getManifest?.().version || 'dev';
