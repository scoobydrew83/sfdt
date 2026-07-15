// Single source of truth for the Salesforce API version every surface pins to.
// The background worker stamps proxied REST/Tooling/SOAP calls with this; the
// thin client re-exports it as `api.apiVersion` so features can build paths
// synchronously. Bump this one line to move the whole extension to a new API
// version — never hardcode `v62.0` anywhere else.
export const SF_API_VERSION = 'v62.0';
