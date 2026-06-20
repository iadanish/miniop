# RTL (Right-to-Left) Support

## Overview

MiniOp supports Arabic, Hebrew, Persian, and Urdu locales requiring right-to-left (RTL) text direction. This document covers bidirectional (BiDi) text handling, CSS logical properties, component mirroring, video player controls, and canvas rendering for both free tier and scaled production.

## Direction Detection

### Setting Document Direction

Set `dir` and `lang` attributes on the root element:

```tsx
// src/hooks/useDirection.ts
import { useLocale } from './useLocale';

const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi']);

export function isRTL(locale: string): boolean {
  const lang = locale.split('-')[0].toLowerCase();
  return RTL_LOCALES.has(lang);
}

export function useDirection() {
  const { locale } = useLocale();
  const dir = isRTL(locale) ? 'rtl' : 'ltr';

  return { dir, isRTL: dir === 'rtl', locale };
}
```

Apply at the root:

```tsx
// src/App.tsx
function App() {
  const { dir, locale } = useDirection();

  return (
    <html dir={dir} lang={locale}>
      <body>
        <I18nProvider>
          <MiniOpApp />
        </I18nProvider>
      </body>
    </html>
  );
}
```

### Why `dir` on `<html>`, Not `<body>`

Setting `dir` on `<html>` ensures:
- Scrollbars appear on the correct side
- Form inputs inherit direction automatically
- Native browser UI (date pickers, context menus) follows direction
- CSS `:dir()` pseudo-class works in supporting browsers

## CSS Logical Properties

Replace all physical CSS properties with logical equivalents. This is the single most important RTL change.

### Property Mapping

| Physical (Wrong) | Logical (Correct) |
|-------------------|--------------------|
| `margin-left` | `margin-inline-start` |
| `margin-right` | `margin-inline-end` |
| `padding-left` | `padding-inline-start` |
| `padding-right` | `padding-inline-end` |
| `border-left` | `border-inline-start` |
| `border-right` | `border-inline-end` |
| `left` | `inset-inline-start` |
| `right` | `inset-inline-end` |
| `text-align: left` | `text-align: start` |
| `text-align: right` | `text-align: end` |
| `float: left` | `float: inline-start` |
| `float: right` | `float: inline-end` |
| `resize: horizontal` | `resize: inline` |

### Enforce with Stylelint

```bash
npm install --save-dev stylelint stylelint-use-logical
```

```js
// .stylelintrc.js
export default {
  plugins: ['stylelint-use-logical'],
  rules: {
    'liberty/use-logical': [
      'always',
      {
        except: [
          'border-radius',
          'background-position',
          'transform',
          'grid-template-columns',
          'grid-template-rows',
        ],
      },
    ],
  },
};
```

Run in CI:

```bash
npx stylelint 'src/**/*.css' --config .stylelintrc.js
```

### Border Radius

Border radius has shorthand logical syntax:

```css
/* Physical - wrong for RTL */
.card {
  border-top-left-radius: 8px;
  border-bottom-right-radius: 8px;
}

/* Logical - correct */
.card {
  border-start-start-radius: 8px;
  border-end-end-radius: 8px;
}
```

## Component Mirroring

### Icons That Must Mirror

Directional icons (arrows, navigation, playback) must flip in RTL:

```tsx
// src/components/Icon.tsx
import { useDirection } from '../hooks/useDirection';

interface IconProps {
  name: string;
  mirror?: boolean;
  className?: string;
}

export function Icon({ name, mirror = false, className }: IconProps) {
  const { isRTL } = useDirection();
  const shouldFlip = mirror && isRTL;

  return (
    <svg
      className={clsx('icon', className, { 'icon--mirrored': shouldFlip })}
      aria-hidden="true"
    >
      <use href={`/sprites/icons.svg#${name}`} />
    </svg>
  );
}
```

```css
/* src/styles/components/icon.css */
.icon--mirrored {
  transform: scaleX(-1);
}
```

Mark which icons need mirroring in a config:

```ts
// src/config/iconMirror.ts
export const MIRROR_ICONS = new Set([
  'arrow-left',
  'arrow-right',
  'chevron-left',
  'chevron-right',
  'skip-back',
  'skip-forward',
  'undo',
  'redo',
  'indent',
  'outdent',
  'reply',
  'forward',
  'play',        // context-dependent, see below
  'fast-forward',
  'rewind',
]);

export const NO_MIRROR_ICONS = new Set([
  'checkmark',
  'close',
  'search',
  'settings',
  'volume',
  'fullscreen',
  'download',
  'upload',
  'trash',
  'edit',
]);
```

### Icons That Must NOT Mirror

- Checkmarks, close buttons, search magnifiers
- Volume controls, fullscreen toggles
- Logos and brand marks
- Clock hands, check/shield icons
- Media playback symbols that have universal meaning (pause, stop)

### Text Content Mirroring

User-generated text may be LTR within an RTL UI (e.g., an English video title in Arabic UI). Handle BiDi isolation:

```tsx
// src/components/UserText.tsx
export function UserText({ text, locale }: { text: string; locale: string }) {
  const textDir = isRTL(locale) ? 'rtl' : 'ltr';

  return (
    <span dir="auto" className="user-text">
      {/* browser will detect direction from first strong character */}
      {text}
    </span>
  );
}
```

Use `dir="auto"` for user-generated content. The browser inspects the first strong directional character to determine direction.

### Form Inputs

```tsx
export function SearchInput() {
  const { dir } = useDirection();

  return (
    <div className="search-wrapper">
      <Icon name="search" />
      <input
        type="search"
        dir="auto"
        placeholder={intl.formatMessage({ id: 'search.placeholder' })}
        className="search-input"
      />
    </div>
  );
}
```

```css
.search-wrapper {
  display: flex;
  align-items: center;
  gap: 8px;
  /* Logical property: icon stays on the correct side */
  padding-inline-start: 12px;
}

.search-input {
  /* Logical properties ensure correct alignment */
  text-align: start;
  border-inline-start: none;
}
```

## Video Player Controls

The video player requires special RTL handling because timeline scrubbing direction is universal (left = earlier, right = later), but the control bar layout mirrors.

### Control Bar Layout

```tsx
// src/components/VideoPlayer/Controls.tsx
export function VideoControls() {
  const { isRTL } = useDirection();

  return (
    <div className="controls">
      <div className="controls__left">
        <Icon name="play" mirror={false} />
        <Icon name="skip-back" mirror={true} />
        <Icon name="skip-forward" mirror={true} />
        <VolumeControl />
      </div>

      {/* Timeline: NOT mirrored - left is always earlier */}
      <div className="controls__timeline">
        <ProgressBar />
      </div>

      <div className="controls__right">
        <TimestampDisplay />
        <Icon name="fullscreen" mirror={false} />
      </div>
    </div>
  );
}
```

```css
.controls {
  display: flex;
  align-items: center;
  gap: 12px;
  /* Layout order is handled by flexbox direction */
}

[dir="rtl"] .controls {
  flex-direction: row-reverse;
}

/* Timeline stays in the center regardless of direction */
.controls__timeline {
  flex: 1;
  /* Do NOT reverse timeline direction */
}

[dir="rtl"] .controls__timeline {
  direction: ltr; /* Force LTR for timeline scrubbing */
}
```

### Timeline Scrubbing

The progress bar must always move left-to-right regardless of UI direction. Force LTR on the timeline:

```ts
// src/components/VideoPlayer/ProgressBar.tsx
export function ProgressBar({ currentTime, duration }: ProgressBarProps) {
  const { isRTL } = useDirection();
  const percent = (currentTime / duration) * 100;

  return (
    <div
      className="progress-bar"
      dir="ltr"
      role="slider"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={currentTime}
      aria-label="Video progress"
    >
      <div
        className="progress-bar__fill"
        style={{ width: `${percent}%` }}
      />
      <input
        type="range"
        min={0}
        max={duration}
        value={currentTime}
        className="progress-bar__input"
        dir="ltr"
      />
    </div>
  );
}
```

## Canvas and Overlay Rendering

For the clip editor canvas (where users add text overlays, stickers, captions), text direction must be explicitly set per text element:

```ts
// src/canvas/TextOverlay.ts
import { isRTL } from '../hooks/useDirection';

export function renderTextOverlay(
  ctx: CanvasRenderingContext2D,
  overlay: TextOverlayData,
  locale: string
) {
  const dir = isRTL(locale) ? 'rtl' : 'ltr';

  ctx.save();
  ctx.direction = dir;
  ctx.textAlign = dir === 'rtl' ? 'right' : 'left';
  ctx.font = `${overlay.fontSize}px ${overlay.fontFamily}`;
  ctx.fillStyle = overlay.color;

  const x = dir === 'rtl'
    ? overlay.x + overlay.width
    : overlay.x;

  // Handle multi-line text
  const lines = wrapText(ctx, overlay.text, overlay.width);
  lines.forEach((line, i) => {
    ctx.fillText(line, x, overlay.y + i * overlay.lineHeight);
  });

  ctx.restore();
}
```

### Caption Preview in Editor

```tsx
export function CaptionPreview({ text, locale, style }: CaptionPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    renderTextOverlay(ctx, {
      text,
      x: 20,
      y: canvas.height - 60,
      width: canvas.width - 40,
      fontSize: 24,
      fontFamily: getFontStack(locale),
      color: '#FFFFFF',
      lineHeight: 32,
    }, locale);
  }, [text, locale]);

  return <canvas ref={canvasRef} className="caption-preview" dir="ltr" />;
}
```

## Free Tier vs. Scaled Production

| Feature | Free Tier | Scaled |
|---------|-----------|--------|
| CSS logical properties | Manual adoption | Enforced by stylelint in CI |
| Icon mirroring | Basic `scaleX(-1)` | Sprite-based with per-icon config |
| BiDi text detection | `dir="auto"` | ICU BiDi algorithm via `react-intl` |
| Canvas text | Basic `ctx.direction` | Full BiDi with line-wrapping engine |
| Timeline scrubbing | Force `dir="ltr"` | Same, with ARIA announcements |
| Font rendering | System Arabic fonts | Web fonts with proper shaping (HarfBuzz) |
| Video controls | Basic mirror | Accessible mirror with keyboard nav |
| Text overlays | Manual direction | Per-element direction with undo stack |
| Testing | Manual visual check | Chromatic visual regression per locale |
| Accessibility | Basic `lang` attribute | Full `lang` + `dir` + ARIA live regions |

## Testing RTL

### Visual Regression

Use Chromatic with RTL stories:

```tsx
// src/components/__stories__/ClipCard.stories.tsx
export const Arabic: Story = {
  parameters: {
    locale: 'ar',
  },
  decorators: [
    (Story) => (
      <div dir="rtl" lang="ar">
        <Story />
      </div>
    ),
  ],
};
```

### Manual Testing Checklist

- [ ] Page scrolls from right to left
- [ ] Scrollbar appears on the left side
- [ ] All text aligns to the right
- [ ] Navigation menu items are reversed
- [ ] Icons (arrows, navigation) are mirrored
- [ ] Video timeline moves left to right (NOT reversed)
- [ ] Form inputs have cursor on the right
- [ ] Dropdown menus open to the left
- [ ] Tooltips appear on the correct side
- [ ] Modal close button is on the left
- [ ] Breadcrumbs read right to left
- [ ] Tables have columns in reversed order
- [ ] Tab order follows visual order (right to left)
- [ ] Embedded LTR text (URLs, code) renders correctly
- [ ] Number inputs still accept left-to-right digits

### Automated Check

```bash
# Check for physical CSS properties that should be logical
npx stylelint 'src/**/*.css' --config .stylelintrc.js

# Check for hardcoded direction in components
npx eslint src/ --rule '{"no-restricted-properties": ["error", {
  "object": "style",
  "property": "marginLeft",
  "message": "Use marginInlineStart instead"
}]}'
```

## Common Pitfalls

1. **`transform: translateX(-50%)` for centering** — This works in both directions. No change needed.
2. **CSS Grid with `grid-template-columns`** — Grid is layout-order independent. Columns don't reverse.
3. **`flex-direction: row-reverse`** — Don't use this as a blanket RTL fix. Use logical properties instead.
4. **`position: absolute` with `left/right`** — Replace with `inset-inline-start/end`.
5. **Third-party components** — Many component libraries (MUI, Ant Design, Chakra) have built-in RTL support via theme providers. Use their `direction` prop rather than wrapping in a `dir` div.
6. **Animation `@keyframes`** — Physical transforms in animations don't auto-mirror. Use CSS logical properties or JavaScript-based animation that reads direction context.
7. **SVG icons with text** — SVG `<text>` elements don't inherit `dir`. Set `direction="rtl"` and `text-anchor="end"` explicitly on SVG text nodes.
