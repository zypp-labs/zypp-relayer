import { createHash } from "node:crypto";

export function sha256Base64(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("base64");
}
