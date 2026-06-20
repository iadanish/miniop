# Internationalization Strategy

## Overview

MiniOp processes video content with UI text, captions, timestamps, and metadata that must render correctly across 40+ locales. This document defines the i18n architecture for both the free tier (self-hosted, single locale) and scaled production (multi-tenant, dynamic locale switching).

## Architecture

### Message Extraction Pipeline

MiniOp uses `react-intl` (FormatJS) as the i18n runtime. All user-facing strings live in ICU MessageFormat syntax inside `src/i18n/messages/`:

```
src/i18n/messages/
  en.json          # source locale
  ar.json          # Arabic
  ja.json          # Japanese
  pt-BR.json       # Brazilian Portuguese
  zh-Hans.json     # Simplified Chinese
```

Each message file follows this structure:

```json
{
  "app.title": "MiniOp - AI Video Clipping",
  "clip.duration": "{count, plural, one {# second} other {# seconds}}",
  "upload.progress": "{percent, number, ::percent} uploaded",
  "export.eta": "Estimated {time, time, short} remaining",
  "date.created": "Created {date, date, medium}"
}
```

### Extraction Command

Run `formatjs extract` to generate a message catalog from source code:

```bash
npx formatjs extract \
  --format simple \
  'src/**/*.{ts,tsx}' \
  --out-file src/i18n/messages/en.json
```

Add to `package.json`:

```json
{
  "scripts": {
    "i18n:extract": "formatjs extract --format simple 'src/**/*.{ts,tsx}' --out-file src/i18n/messages/en.json",
    "i18n:compile": "formatjs compile-folder --ast src/i18n/messages src/i18n/compiled",
    "i18n:manage": "npm run i18n:extract && npm run i18n:compile"
  }
}
```

### Runtime Provider

Wrap the application with `IntlProvider`:

```tsx
// src/providers/I18nProvider.tsx
import { IntlProvider } from 'react-intl';
import { useLocale } from '../hooks/useLocale';

const compiledMessages = import.meta.glob('../i18n/compiled/*.json', {
  eager: true,
  import: 'default',
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const { locale, timezone } = useLocale();

  const messages = compiledMessages[`../i18n/compiled/${locale}.json`];

  return (
    <IntlProvider
      locale={locale}
      messages={messages}
      timeZone={timezone}
      onError={(err) => {
        if (err.code === 'MISSING_TRANSLATION') return;
        console.error(err);
      }}
    >
      {children}
    </IntlProvider>
  );
}
```

### Locale Detection and Switching

Use `Accept-Language` header parsing on the server and `navigator.language` on the client:

```ts
// src/utils/locale.ts
import { match } from '@formatjs/intl-localematcher';
import Negotiator from 'negotiator';

export const SUPPORTED_LOCALES = ['en', 'ar', 'ja', 'pt-BR', 'zh-Hans'] as const;
export const DEFAULT_LOCALE = 'en';

export function detectLocale(acceptLanguage: string | null): string {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  try {
    const languages = new Negotiator({
      headers: { 'accept-language': acceptLanguage },
    }).languages();
    return match(languages, SUPPORTED_LOCALES, DEFAULT_LOCALE);
  } catch {
    return DEFAULT_LOCALE;
  }
}
```

## Free Tier (Self-Hosted)

For single-locale deployments, strip the locale detection overhead entirely:

```ts
// src/config/locale.ts
const isFreeTier = import.meta.env.VITE_TIER === 'free';

export const localeConfig = {
  defaultLocale: isFreeTier ? 'en' : detectLocale(null),
  enableLocaleSwitch: !isFreeTier,
  loadStrategy: isFreeTier ? 'eager' : 'lazy',
};
```

Free tier compiles messages into the main bundle (no dynamic imports):

```bash
VITE_TIER=free npm run build
```

This eliminates 3 network requests and ~120KB of async locale data.

## Scaled Production

### CDN-Based Locale Loading

For multi-tenant deployments, serve compiled locale files from a CDN:

```ts
// src/i18n/loader.ts
const CDN_BASE = import.meta.env.VITE_CDN_URL;

export async function loadLocale(locale: string): Promise<Record<string, string>> {
  const cacheKey = `i18n:${locale}`;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) return JSON.parse(cached);

  const resp = await fetch(`${CDN_BASE}/i18n/compiled/${locale}.json`, {
    headers: { 'Cache-Control': 'public, max-age=86400' },
  });

  if (!resp.ok) throw new Error(`Failed to load locale: ${locale}`);

  const messages = await resp.json();
  sessionStorage.setItem(cacheKey, JSON.stringify(messages));
  return messages;
}
```

### Server-Side Rendering

For SSR (Next.js), inject the locale into the HTML document:

```ts
// src/server/locale.ts
import { detectLocale } from '../utils/locale';

export function getLocaleFromRequest(req: Request): string {
  const cookie = req.headers.get('cookie');
  const cookieLocale = cookie?.match(/miniop_locale=([^;]+)/)?.[1];
  if (cookieLocale && SUPPORTED_LOCALES.includes(cookieLocale)) {
    return cookieLocale;
  }
  return detectLocale(req.headers.get('accept-language'));
}
```

### Translation Management

Use Crowdin or Lokalise for translation workflows. Crowdin CLI integration:

```yaml
# crowdin.yml
"project_id_env": "CROWDIN_PROJECT_ID"
"api_token_env": "CROWDIN_API_TOKEN"
"base_path": "./src/i18n/messages"
"base_url": "https://api.crowdin.com"

"preserve_hierarchy": true

"files":
  - source: "/en.json"
    translation: "/%locale%.json"
```

```bash
# Upload source strings
crowdin upload sources

# Download translations
crowdin download --translations-only
```

## Number, Date, and Currency Formatting

Never format numbers manually. Use `react-intl` components:

```tsx
// Correct
<FormattedNumber value={1234567.89} style="currency" currency="USD" />
// Output (en): $1,234,567.89
// Output (ar): ١٬٢٣٤٬٥٦٧٫٨٩ ر.س.

<FormattedDate value={new Date()} dateStyle="medium" timeStyle="short" />
// Output (en): Jan 15, 2026, 3:30 PM
// Output (ja): 2026年1月15日 15:30

// Wrong - hardcoded format
{new Date().toLocaleDateString()}
```

For hooks:

```tsx
const intl = useIntl();
const formatted = intl.formatNumber(0.85, { style: 'percent' });
const relative = intl.formatRelativeTime(-2, 'hour');
// "2 hours ago"
```

## Pluralization

ICU handles plural rules automatically across all CLDR languages:

```json
{
  "clip.count": "{count, plural, =0 {No clips} one {# clip} other {# clips}}"
}
```

For Arabic (6 plural forms):

```json
{
  "clip.count": "{count, plural, =0 {لا مقاطع} zero {لا مقاطع} one {مقطع واحد} two {مقطعان} few {# مقاطع} many {# مقطعًا} other {# مقطع}}"
}
```

## Gender-Select

```json
{
  "notification": "{gender, select, female {She shared a clip} male {He shared a clip} other {They shared a clip}}"
}
```

## Testing

Add i18n linting to CI:

```bash
npm install --save-dev @formatjs/eslint-plugin
```

```js
// eslint.config.js
import formatjs from '@formatjs/eslint-plugin';

export default [
  {
    plugins: { '@formatjs': formatjs },
    rules: {
      '@formatjs/no-literal-string-in-jsx': 'error',
      '@formatjs/no-missing-icu-plural-one-syntax': 'error',
    },
  },
];
```

Verify pseudo-localization in dev:

```bash
# Generate pseudo-locale for testing
npx formatjs compile --pseudo-locale en-XA src/i18n/messages/en.json > src/i18n/compiled/en-XA.json
```

`en-XA` wraps strings in `[!! Ḡéř Ḡéř !!]` to catch truncation and hardcoded strings.

## Performance Budget

| Metric | Free Tier | Scaled |
|--------|-----------|--------|
| i18n bundle size | 0 KB (inline) | 8 KB (loader) |
| Locale file size | N/A | ~35 KB gzipped |
| Parse time | <5ms | <15ms (async) |
| Supported locales | 1 | 40+ |
| SSR hydration | N/A | Full locale flash prevention |
