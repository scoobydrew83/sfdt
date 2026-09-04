import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// WEB-1: no D1, no R2, no KV. Public cache lands in WEB-3.
export default defineCloudflareConfig({});
