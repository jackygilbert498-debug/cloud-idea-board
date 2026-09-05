export const RELEASE_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

export class ReleaseBuildShaError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseBuildShaError";
  }
}

export function validateReleaseBuildSha(value, source) {
  if (typeof value !== "string" || !RELEASE_SHA_PATTERN.test(value)) {
    throw new ReleaseBuildShaError(`${source} 必须是 7 至 64 位十六进制提交 SHA。`);
  }
  return value;
}
