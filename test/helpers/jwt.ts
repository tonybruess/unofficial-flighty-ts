/**
 * Fake bearer/build JWTs for tests. The SDK only reads the `sub` claim
 * and checks the token has three dots, so we don't need real signing.
 */
function b64url(input: string): string {
  return btoa(input).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function fakeBearer(sub: string): string {
  const header = b64url(JSON.stringify({ alg: "HS512", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub, iat: 1700000000 }));
  return `${header}.${payload}.sig`;
}

export const fakeBuildToken = (): string => {
  const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ build: "test" }));
  return `${header}.${payload}.sig`;
};
