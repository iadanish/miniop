# WCAG 2.1 Compliance Guide for MiniOp

## Overview

MiniOp targets **WCAG 2.1 Level AA** conformance across all user-facing surfaces: the clip editor, timeline, project dashboard, export dialogs, and public share pages. This document defines the compliance baseline, testing methodology, remediation patterns, and tier-specific configurations for both free-tier self-hosted deployments and scaled production environments behind a CDN.

---

## Compliance Target

| Criterion | Level | Relevance to MiniOp |
|-----------|-------|---------------------|
| 1.1.1 Non-text Content | A | Video thumbnails, waveform visualizations, icon buttons |
| 1.2.1 Audio-only / Video-only | A | Clip previews, silent highlight reels |
| 1.2.2 Captions (Prerecorded) | A | Auto-generated captions via ASR pipeline |
| 1.2.5 Audio Description (Prerecorded) | AA | Scene-change descriptions for exported clips |
| 1.3.1 Info and Relationships | A | Semantic HTML for timeline tracks, clip cards |
| 1.4.1 Use of Color | A | Clip status indicators (processing/ready/failed) must not rely on color alone |
| 1.4.3 Contrast (Minimum) | AA | 4.5:1 for body text, 3:1 for large text and UI components |
| 1.4.11 Non-text Contrast | AA | Focus rings, timeline scrub handles, progress bars |
| 2.1.1 Keyboard | A | Full editor control via keyboard |
| 2.4.7 Focus Visible | AA | Custom focus indicators on all interactive elements |
| 4.1.2 Name, Role, Value | A | ARIA labels on custom widgets (timeline, clip selector) |

---

## Color Contrast System

MiniOp enforces contrast through design tokens. Define accessible palettes in `src/theme/tokens.ts`:

```typescript
// src/theme/tokens.ts
export const contrastTokens = {
  // Passes 4.5:1 on white background
  textPrimary: '#1a1a2e',
  textSecondary: '#4a4a68',    // 4.6:1 on #fff
  textDisabled: '#7a7a94',     // only used with supplementary indicator

  // Interactive element borders (3:1 against background)
  focusRing: '#2563eb',
  buttonBorder: '#374151',

  // Status indicators — always paired with icon/text
  statusReady: '#059669',
  statusProcessing: '#d97706',
  statusFailed: '#dc2626',

  // Timeline waveform
  waveformActive: '#1e40af',
  waveformInactive: '#93c5fd',
};
```

Every status color is paired with a visible icon and text label — color is never the sole carrier of meaning, satisfying SC 1.4.1.

### Automated Contrast Checking

Add `axe-core` to your CI pipeline:

```bash
npm install --save-dev @axe-core/cli
```

```jsonc
// package.json
{
  "scripts": {
    "a11y:audit": "axe http://localhost:3000 --rules color-contrast,link-in-text-block --exit"
  }
}
```

For scaled production, run audits against the deployed URL:

```bash
axe https://app.minio.example.com --tags wcag2a,wcag2aa --exit
```

---

## Semantic HTML and ARIA Landmarks

MiniOp's layout uses native HTML5 landmarks instead of generic `<div>` wrappers:

```html
<!-- src/layouts/AppLayout.tsx -->
<header role="banner">
  <nav aria-label="Primary navigation">...</nav>
</header>
<main role="main" id="main-content">
  <!-- Editor, dashboard, or project view renders here -->
</main>
<aside role="complementary" aria-label="Clip properties panel">
  ...
</aside>
<footer role="contentinfo">...</footer>
```

Skip navigation is built into the shell:

```tsx
// src/components/SkipLink.tsx
export function SkipLink() {
  return (
    <a href="#main-content" className="skip-link">
      Skip to main content
    </a>
  );
}
```

```css
.skip-link {
  position: absolute;
  left: -10000px;
  top: auto;
  width: 1px;
  height: 1px;
  overflow: hidden;
}
.skip-link:focus {
  position: static;
  width: auto;
  height: auto;
  padding: 8px 16px;
  background: #2563eb;
  color: #fff;
  z-index: 9999;
}
```

---

## Media Accessibility (SC 1.2.x)

### Auto-Caption Pipeline

MiniOp's ASR pipeline generates WebVTT captions. Ensure captions are exposed in the player:

```typescript
// src/lib/captions/renderTracks.ts
export function renderCaptionTrack(videoEl: HTMLVideoElement, vttUrl: string) {
  const track = document.createElement('track');
  track.kind = 'captions';
  track.label = 'English';
  track.srclang = 'en';
  track.src = vttUrl;
  track.default = true;
  videoEl.appendChild(track);
}
```

### Audio Descriptions for Exports

When users export clips, MiniOp can generate a text-based audio description sidecar:

```bash
# API call to generate audio description metadata
curl -X POST https://api.minio.example.com/v1/clips/{clip_id}/audio-description \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"format": "json", "scene_detection": true}'
```

The response contains timestamped scene descriptions that screen readers or secondary audio tracks can consume.

---

## Form Accessibility

All form inputs in MiniOp follow a consistent accessible pattern:

```tsx
// src/components/ui/AccessibleInput.tsx
interface Props {
  label: string;
  id: string;
  error?: string;
  required?: boolean;
}

export function AccessibleInput({ label, id, error, required }: Props) {
  const errorId = `${id}-error`;
  return (
    <div className="form-field">
      <label htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      <input
        id={id}
        aria-required={required}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
      />
      {error && (
        <p id={errorId} role="alert" className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
```

---

## Tier-Specific Configuration

### Free Tier (Self-Hosted)

For small teams running MiniOp locally, enforce accessibility at build time:

```jsonc
// next.config.js
module.exports = {
  // Fail build on accessibility violations in CI
  experimental: {
    a11yStrictMode: true,
  },
};
```

Run a manual audit:

```bash
npx playwright test tests/accessibility/
```

### Scaled Production (CDN / Multi-Region)

In production, deploy continuous accessibility monitoring:

```yaml
# .github/workflows/a11y-monitor.yml
name: Accessibility Monitor
on:
  schedule:
    - cron: '0 6 * * 1'  # Weekly Monday 6AM
  workflow_dispatch:

jobs:
  axe-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npx axe-core/cli https://app.minio.example.com --tags wcag2a,wcag2aa --save results.json
      - uses: actions/upload-artifact@v4
        with:
          name: a11y-report
          path: results.json
```

Integrate with monitoring dashboards by shipping `results.json` to your observability stack (Datadog, Grafana) for trend tracking.

---

## Testing Checklist

| Test | Tool | Frequency |
|------|------|-----------|
| Color contrast ratios | axe-core, Chrome DevTools | Every PR |
| Keyboard tab order | Manual + Playwright | Every PR |
| Screen reader announcements | NVDA / VoiceOver manual | Sprint review |
| ARIA attribute correctness | axe-core, eslint-plugin-jsx-a11y | Every PR |
| Focus trap in modals | Playwright | Every PR |
| Caption sync accuracy | Manual review | Each ASR model update |

---

## References

- [WCAG 2.1 Specification](https://www.w3.org/TR/WCAG21/)
- [WAI-ARIA Authoring Practices 1.2](https://www.w3.org/WAI/ARIA/apatdoc)
- [axe-core Rules](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md)
- [MDN Accessibility](https://developer.mozilla.org/en-US/docs/Web/Accessibility)
