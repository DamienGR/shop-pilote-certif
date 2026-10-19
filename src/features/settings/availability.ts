import type { StoreSettings } from './db';
import { t } from '../i18n/index.ts';

export interface RuntimeCapabilities {
  vault: boolean;
  authSecret: boolean;
  images: boolean;
  emailBinding: boolean;
  ai: boolean;
  vectorize: boolean;
}

export interface SettingAvailability {
  available: boolean;
  reason?: string;
}

const hasSecret = (settings: StoreSettings, caps: RuntimeCapabilities, name: string): boolean =>
  caps.vault && settings.configuredSecrets.includes(name);

export function stripeConfigured(
  settings: StoreSettings,
  caps: RuntimeCapabilities,
): boolean {
  return (
    hasSecret(settings, caps, 'stripe_secret_key') &&
    hasSecret(settings, caps, 'stripe_webhook_secret')
  );
}

export function emailConfigured(
  settings: StoreSettings,
  caps: RuntimeCapabilities,
): boolean {
  if (!settings.emailEnabled) return false;
  return settings.emailProvider === 'cloudflare'
    ? caps.emailBinding
    : hasSecret(settings, caps, 'resend_api_key');
}

export function featureAvailability(
  key: string,
  settings: StoreSettings,
  caps: RuntimeCapabilities,
): SettingAvailability {
  if (key === 'discounts_enabled' || key === 'tax_enabled') {
    return stripeConfigured(settings, caps)
      ? { available: true }
      : { available: false, reason: t('admin.settings.availability.stripe') };
  }
  if (key === 'accounts_enabled') {
    if (!caps.authSecret) {
      return { available: false, reason: t('admin.settings.availability.authSecret') };
    }
    if (!emailConfigured(settings, caps)) {
      return { available: false, reason: t('admin.settings.availability.email') };
    }
  }
  if (key === 'image_optimize' && !caps.images) {
    return { available: false, reason: t('admin.settings.availability.imagesBinding') };
  }
  return { available: true };
}

export function semanticSearchAvailable(caps: RuntimeCapabilities): boolean {
  return caps.ai && caps.vectorize;
}

export function lightningConfigurationError(
  backend: 'lnbits' | 'phoenixd',
  url: string,
  hasCredential: boolean,
): string | null {
  const label = backend === 'lnbits' ? 'LNbits' : 'phoenixd';
  if (!url) return t('admin.settings.lightning.error.url', { nom: label });
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return t('admin.settings.lightning.error.invalidUrl', { nom: label });
    }
  } catch {
    return t('admin.settings.lightning.error.invalidUrl', { nom: label });
  }
  if (!hasCredential) {
    return backend === 'lnbits'
      ? t('admin.settings.lightning.error.lnbitsKey')
      : t('admin.settings.lightning.error.phoenixdPassword');
  }
  return null;
}

export function turnstileConfigured(
  settings: StoreSettings,
  caps: RuntimeCapabilities,
): boolean {
  return (
    caps.vault &&
    !!settings.turnstileSiteKey &&
    settings.configuredSecrets.includes('turnstile_secret_key')
  );
}
