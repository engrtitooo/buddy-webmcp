export type ExtensionOriginPolicy = 'allowlist' | 'chrome-extensions';

// Chrome IDs contain exactly 32 lowercase characters in the a-p alphabet.
// Match the entire serialized origin, never a prefix, URL path, or caller-supplied ID.
export function isChromeExtensionOrigin(origin: string): boolean {
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

export function extensionOriginPolicy(environment: NodeJS.ProcessEnv = process.env): ExtensionOriginPolicy {
  const policy = environment.BUDDY_EXTENSION_ORIGIN_POLICY?.trim() || 'allowlist';
  if (policy !== 'allowlist' && policy !== 'chrome-extensions') {
    throw new Error('BUDDY_EXTENSION_ORIGIN_POLICY must be allowlist or chrome-extensions.');
  }
  return policy;
}

export function isAllowedOrigin(origin: string, allowedOrigins: Set<string>, policy: ExtensionOriginPolicy): boolean {
  if (origin.startsWith('chrome-extension:')) {
    return isChromeExtensionOrigin(origin) && (policy === 'chrome-extensions' || allowedOrigins.has(origin));
  }
  // Even a misconfigured allowlist must not allow null, wildcards, or URL lookalikes.
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === origin && allowedOrigins.has(origin);
  } catch { return false; }
}
