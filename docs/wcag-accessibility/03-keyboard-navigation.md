# Keyboard Navigation for MiniOp

## Overview

MiniOp is fully operable via keyboard. No action requires a mouse. This document defines the keyboard interaction model, focus management strategy, custom widget patterns, skip navigation, and tier-specific configuration for both free-tier and scaled production deployments.

---

## Global Focus Management

### Focus Ring System

MiniOp uses a custom focus indicator that meets SC 2.4.7 (Focus Visible) and SC 1.4.11 (Non-text Contrast):

```css
/* src/styles/focus.css */
:focus-visible {
  outline: 3px solid #2563eb;
  outline-offset: 2px;
  border-radius: 2px;
}

/* Suppress focus ring for mouse users */
:focus:not(:focus-visible) {
  outline: none;
}

/* High contrast mode support */
@media (forced-colors: active) {
  :focus-visible {
    outline: 3px solid Highlight;
    forced-color-adjust: none;
  }
}
```

The `:focus-visible` pseudo-class ensures the ring appears on keyboard focus but not on mouse click, satisfying both keyboard users and mouse users who dislike visual clutter.

### Focus Trap Utility

Modals and dropdown menus trap focus. MiniOp provides a reusable trap:

```typescript
// src/lib/focus-trap.ts
export function createFocusTrap(container: HTMLElement): { activate: () => void; deactivate: () => void } {
  let previouslyFocused: HTMLElement | null = null;

  function getFocusable(): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;

    const focusable = getFocusable();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return {
    activate() {
      previouslyFocused = document.activeElement as HTMLElement;
      container.addEventListener('keydown', handleKeyDown);
      const first = getFocusable()[0];
      first?.focus();
    },
    deactivate() {
      container.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    },
  };
}
```

---

## Skip Navigation

The first focusable element in the DOM is a skip link:

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

Additional skip links are injected contextually:

```tsx
// src/components/EditorLayout.tsx
export function EditorLayout({ children }) {
  return (
    <>
      <SkipLink />
      <a href="#timeline" className="skip-link">Skip to timeline</a>
      <a href="#properties-panel" className="skip-link">Skip to clip properties</a>
      <main id="main-content">{children}</main>
    </>
  );
}
```

---

## Tab Order Strategy

MiniOp uses a logical tab order that follows visual layout. Avoid `tabindex` values > 0 — they create maintenance burden and break when the DOM changes.

### Main Application Tab Flow

```
1. Skip links (visually hidden until focused)
2. Navigation bar (Dashboard, Projects, Export)
3. Main content area:
   a. Upload button / project selector
   b. Video player controls
   c. Timeline seek bar
   d. Clip list
   e. Action buttons (Select All, Clear, Export)
4. Properties panel (when visible)
5. Footer links
```

### Roving Tabindex for Clip List

The clip list uses roving tabindex so only one item is in the tab order at a time:

```tsx
// src/components/ClipList.tsx
export function ClipList({ clips, focusedIndex, onFocusChange, onToggleSelect }) {
  return (
    <ul role="listbox" aria-label="Detected highlights" aria-multiselectable="true">
      {clips.map((clip, i) => (
        <li
          key={clip.id}
          role="option"
          aria-selected={clip.selected}
          tabIndex={i === focusedIndex ? 0 : -1}
          onFocus={() => onFocusChange(i)}
          onKeyDown={(e) => {
            switch (e.key) {
              case 'ArrowDown':
                e.preventDefault();
                onFocusChange(Math.min(i + 1, clips.length - 1));
                break;
              case 'ArrowUp':
                e.preventDefault();
                onFocusChange(Math.max(i - 1, 0));
                break;
              case 'Home':
                e.preventDefault();
                onFocusChange(0);
                break;
              case 'End':
                e.preventDefault();
                onFocusChange(clips.length - 1);
                break;
              case ' ':
              case 'Enter':
                e.preventDefault();
                onToggleSelect(clip.id);
                break;
            }
          }}
        >
          <ClipCard clip={clip} />
        </li>
      ))}
    </ul>
  );
}
```

### Managing Focus After DOM Mutations

When clips are deleted or reordered, move focus predictably:

```typescript
// src/lib/focusAfterMutation.ts
export function focusAfterRemoval(
  list: HTMLElement,
  removedIndex: number,
  totalRemaining: number
) {
  const nextIndex = Math.min(removedIndex, totalRemaining - 1);
  const nextItem = list.querySelector<HTMLElement>(
    `[role="option"]:nth-child(${nextIndex + 1})`
  );
  nextItem?.focus();
}
```

---

## Keyboard Shortcuts

MiniOp defines a keyboard shortcut system accessible via `?` key:

| Shortcut | Action | Context |
|----------|--------|---------|
| `Space` | Play / Pause video | Video player focused |
| `←` | Seek backward 5s | Video player focused |
| `→` | Seek forward 5s | Video player focused |
| `Shift+←` | Seek backward 10s | Video player focused |
| `Shift+→` | Seek forward 10s | Video player focused |
| `Home` | Jump to start | Video player focused |
| `End` | Jump to end | Video player focused |
| `↑` | Previous clip | Clip list focused |
| `↓` | Next clip | Clip list focused |
| `Space` | Toggle clip selection | Clip list focused |
| `Ctrl+A` | Select all clips | Clip list focused |
| `Escape` | Clear selection / close modal | Global |
| `Enter` | Open selected clip | Clip list focused |
| `E` | Export selected clips | Global |
| `?` | Show keyboard shortcuts | Global |

### Shortcut Registration

```typescript
// src/hooks/useKeyboardShortcuts.ts
import { useEffect } from 'react';

type ShortcutMap = Record<string, (e: KeyboardEvent) => void>;

export function useKeyboardShortcuts(shortcuts: ShortcutMap, enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    function handler(e: KeyboardEvent) {
      // Don't capture when user is typing in an input
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      const key = [
        e.ctrlKey && 'Ctrl',
        e.shiftKey && 'Shift',
        e.altKey && 'Alt',
        e.key,
      ].filter(Boolean).join('+');

      const action = shortcuts[key];
      if (action) {
        e.preventDefault();
        action(e);
      }
    }

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [shortcuts, enabled]);
}
```

---

## Timeline Keyboard Interaction

The timeline scrub handle uses the slider pattern:

```tsx
// src/components/TimelineScrub.tsx
export function TimelineScrub({ duration, currentTime, onSeek }) {
  const scrubRef = useRef<HTMLDivElement>(null);

  function handleKeyDown(e: React.KeyboardEvent) {
    const step = e.shiftKey ? 10 : 5;
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        onSeek(Math.min(currentTime + step, duration));
        break;
      case 'ArrowLeft':
        e.preventDefault();
        onSeek(Math.max(currentTime - step, 0));
        break;
      case 'Home':
        e.preventDefault();
        onSeek(0);
        break;
      case 'End':
        e.preventDefault();
        onSeek(duration);
        break;
      case 'PageUp':
        e.preventDefault();
        onSeek(Math.min(currentTime + 30, duration));
        break;
      case 'PageDown':
        e.preventDefault();
        onSeek(Math.max(currentTime - 30, 0));
        break;
    }
  }

  return (
    <div
      ref={scrubRef}
      role="slider"
      tabIndex={0}
      aria-label="Playback position"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={currentTime}
      aria-valuetext={formatTimestamp(currentTime)}
      onKeyDown={handleKeyDown}
      className="timeline-scrub"
    />
  );
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m} minute${m !== 1 ? 's' : ''} ${s} second${s !== 1 ? 's' : ''}`;
}
```

---

## Export Dialog Keyboard Flow

The export dialog is a multi-step wizard. Each step is a fieldset with a logical tab order:

```tsx
// src/components/ExportDialog.tsx
export function ExportDialog({ clips, open, onClose }) {
  const [step, setStep] = useState(0);

  return (
    <Modal open={open} onClose={onClose} title="Export Clips">
      <form onSubmit={handleExport}>
        {step === 0 && (
          <fieldset>
            <legend>Select format</legend>
            <label>
              <input type="radio" name="format" value="mp4" defaultChecked />
              MP4 (H.264)
            </label>
            <label>
              <input type="radio" name="format" value="webm" />
              WebM (VP9)
            </label>
            <label>
              <input type="radio" name="format" value="gif" />
              GIF
            </label>
          </fieldset>
        )}

        {step === 1 && (
          <fieldset>
            <legend>Resolution</legend>
            <select aria-label="Output resolution">
              <option value="1080p">1080p (Full HD)</option>
              <option value="720p">720p (HD)</option>
              <option value="480p">480p (SD)</option>
            </select>
          </fieldset>
        )}

        <div className="dialog-actions">
          {step > 0 && (
            <button type="button" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          {step < 1 ? (
            <button type="button" onClick={() => setStep(step + 1)}>
              Next
            </button>
          ) : (
            <button type="submit">Export</button>
          )}
        </div>
      </form>
    </Modal>
  );
}
```

---

## Tier-Specific Configuration

### Free Tier

Run keyboard navigation tests locally with Playwright:

```typescript
// tests/keyboard/navigation.spec.ts
import { test, expect } from '@playwright/test';

test('tab order follows visual layout', async ({ page }) => {
  await page.goto('/editor/project-123');

  // Tab through the interface
  await page.keyboard.press('Tab'); // Skip link
  await page.keyboard.press('Tab'); // Dashboard nav
  await page.keyboard.press('Tab'); // Projects nav
  await page.keyboard.press('Tab'); // Upload button

  const focused = await page.evaluate(() => document.activeElement?.textContent);
  expect(focused).toBe('Upload Video');
});

test('clip list supports arrow key navigation', async ({ page }) => {
  await page.goto('/editor/project-123');

  // Focus the clip list
  await page.locator('[role="listbox"]').focus();

  // First clip should be focused
  await page.keyboard.press('ArrowDown');
  const selected = await page.locator('[role="option"][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
});

test('modal traps focus', async ({ page }) => {
  await page.goto('/editor/project-123');
  await page.keyboard.press('E'); // Open export

  // Tab should cycle within modal
  const modal = page.locator('dialog[aria-modal="true"]');
  await expect(modal).toBeVisible();

  // Press Tab many times — focus should never leave the modal
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    const isInModal = await page.evaluate(() => {
      const modal = document.querySelector('dialog[aria-modal="true"]');
      return modal?.contains(document.activeElement);
    });
    expect(isInModal).toBe(true);
  }
});
```

```jsonc
// package.json
{
  "scripts": {
    "test:keyboard": "npx playwright test tests/keyboard/"
  }
}
```

### Scaled Production

In production, inject keyboard shortcut analytics to identify usability gaps:

```typescript
// src/lib/analytics/keyboardTracking.ts
export function trackKeyboardUsage() {
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    fetch('/api/v1/analytics/keyboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: e.key,
        modifiers: {
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
          alt: e.altKey,
        },
        path: window.location.pathname,
        timestamp: Date.now(),
      }),
      keepalive: true,
    });
  });
}
```

Deploy a visual keyboard shortcut overlay that users can toggle:

```tsx
// src/components/ShortcutOverlay.tsx
export function ShortcutOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <div role="dialog" aria-label="Keyboard shortcuts" className="shortcut-overlay">
      <h2>Keyboard Shortcuts</h2>
      <dl>
        <dt><kbd>Space</kbd></dt><dd>Play / Pause</dd>
        <dt><kbd>←</kbd> / <kbd>→</kbd></dt><dd>Seek 5 seconds</dd>
        <dt><kbd>↑</kbd> / <kbd>↓</kbd></dt><dd>Navigate clips</dd>
        <dt><kbd>Enter</kbd></dt><dd>Select clip</dd>
        <dt><kbd>E</kbd></dt><dd>Export</dd>
        <dt><kbd>?</kbd></dt><dd>Toggle this overlay</dd>
      </dl>
    </div>
  );
}
```

---

## Common Anti-Patterns to Avoid

| Anti-Pattern | Problem | Fix |
|-------------|---------|-----|
| `div` with `onClick` but no `tabIndex` or `role` | Not focusable, not announced | Use `<button>` or add `role="button"` + `tabIndex={0}` + `onKeyDown` |
| `tabindex="5"` | Breaks natural tab order | Use `tabindex="0"` and manage DOM order |
| Auto-focus on page load | Confuses screen reader users | Only auto-focus search inputs or skip links |
| Focus on decorative elements | Wastes user's time | Add `tabindex="-1"` to decorative interactive traps |
| No visible focus indicator | SC 2.4.7 violation | Always render `:focus-visible` outline |

---

## References

- [WAI-ARIA Authoring Practices - Keyboard](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)
- [WCAG 2.1 SC 2.1.1 Keyboard](https://www.w3.org/TR/WCAG21/#keyboard)
- [WCAG 2.1 SC 2.4.7 Focus Visible](https://www.w3.org/TR/WCAG21/#focus-visible)
- [MDN: `HTMLElement.focus()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/focus)
